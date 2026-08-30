import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { CodexEffort } from "./catalog.js";

export type CodexClassification =
  | "timeout"
  | "cancelled"
  | "quota-exhausted"
  | "error";

export interface CodexRuntimeSnapshot {
  requestedModel: string;
  requestedEffort: CodexEffort;
  effectiveEffort: CodexEffort;
  providerReportedEffort?: string;
  usage: { inputTokens?: number; outputTokens?: number };
  events: unknown[];
}

export interface CodexInvocationResult {
  ok: boolean;
  text?: string;
  classification?: CodexClassification;
  retryAfter?: string;
  runtimeSnapshot: CodexRuntimeSnapshot;
}

const QUOTA_RE = /\b429\b|rate[_\s-]?limit|usage limit|quota|credits exhausted/i;
const RETRY_RE = /"(?:retry[_-]?after|resets?[_-]?at)"\s*:\s*"([^"]+)"/i;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function parseEvents(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { malformed: line };
      }
    });
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

function parseMcpConfig(path: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    mcpServers?: unknown;
  };
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.mcpServers !== "object" ||
    parsed.mcpServers === null ||
    Array.isArray(parsed.mcpServers)
  ) {
    throw new Error("Codex MCP config must contain an mcpServers object");
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!BARE_TOML_KEY.test(name)) {
      throw new Error(`invalid MCP server name for Codex config: ${name}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`invalid MCP server config: ${name}`);
    }
    const raw = value as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      throw new Error(`MCP server ${name} requires a command`);
    }
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string"))
    ) {
      throw new Error(`MCP server ${name} args must be strings`);
    }
    if (
      raw.env !== undefined &&
      (typeof raw.env !== "object" || raw.env === null || Array.isArray(raw.env))
    ) {
      throw new Error(`MCP server ${name} env must be a string map`);
    }
    const env = raw.env as Record<string, unknown> | undefined;
    if (
      env !== undefined &&
      Object.entries(env).some(
        ([key, entry]) => !BARE_TOML_KEY.test(key) || typeof entry !== "string",
      )
    ) {
      throw new Error(`MCP server ${name} env must use safe keys and string values`);
    }
    servers[name] = {
      command: raw.command,
      ...(raw.args === undefined ? {} : { args: raw.args as string[] }),
      ...(env === undefined ? {} : { env: env as Record<string, string> }),
    };
  }
  return servers;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlStringMap(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function toolAssignments(
  serverNames: string[],
  allowedTools: string[],
): Map<string, string[]> {
  const assigned = new Map(serverNames.map((name) => [name, new Set<string>()]));
  for (const declared of allowedTools) {
    const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(declared);
    const server = match?.[1] ?? (serverNames.length === 1 ? serverNames[0] : undefined);
    const tool = match?.[2] ?? declared;
    if (server === undefined || !assigned.has(server)) {
      throw new Error(
        `allowed tool ${declared} is not addressed to a configured MCP server`,
      );
    }
    if (tool.length === 0) throw new Error(`allowed tool ${declared} has no tool name`);
    assigned.get(server)?.add(tool);
  }
  return new Map(
    [...assigned].map(([server, tools]) => [server, [...tools].sort()]),
  );
}

function boundaryConfig(input: {
  allowedTools: string[];
  mcpConfigPath?: string;
}): string[] {
  const values = [
    'approval_policy="never"',
    "features.shell_tool=false",
    "features.unified_exec=false",
    "tools.web_search=false",
    "tools.view_image=false",
    "features.multi_agent=false",
    "agents.enabled=false",
    "features.apps=false",
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.chronicle=false",
    "features.computer_use=false",
    "features.image_generation=false",
    "features.in_app_browser=false",
    "features.memories=false",
    "features.plugin_sharing=false",
    "features.tool_suggest=false",
    "features.workspace_dependencies=false",
  ];
  if (input.mcpConfigPath === undefined) {
    if (input.allowedTools.length > 0) {
      throw new Error("allowed Codex MCP tools require an MCP config path");
    }
    return values;
  }
  const servers = parseMcpConfig(input.mcpConfigPath);
  const names = Object.keys(servers).sort();
  const assignments = toolAssignments(names, input.allowedTools);
  for (const name of names) {
    const server = servers[name] as McpServerConfig;
    values.push(`mcp_servers.${name}.command=${tomlString(server.command)}`);
    if (server.args !== undefined) {
      values.push(`mcp_servers.${name}.args=${tomlStringArray(server.args)}`);
    }
    if (server.env !== undefined) {
      values.push(`mcp_servers.${name}.env=${tomlStringMap(server.env)}`);
    }
    values.push(
      `mcp_servers.${name}.enabled_tools=${tomlStringArray(assignments.get(name) ?? [])}`,
      `mcp_servers.${name}.required=true`,
    );
  }
  return values;
}

export async function invokeCodex(input: {
  model: string;
  effort: CodexEffort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  sandbox: "read-only" | "workspace-write";
  env: Record<string, string>;
  allowedTools: string[];
  mcpConfigPath?: string;
  signal?: AbortSignal;
}): Promise<CodexInvocationResult> {
  const config = boundaryConfig(input);
  const args = [
    "exec",
    "--model",
    input.model,
    "--config",
    `model_reasoning_effort=\"${input.effort}\"`,
    "--cd",
    input.cwd,
    "--sandbox",
    input.sandbox,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...config.flatMap((value) => ["--config", value]),
    "--json",
    input.prompt,
  ];

  return await new Promise<CodexInvocationResult>((resolve) => {
    const child = spawn("codex", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let terminal: CodexClassification | undefined;
    let settled = false;
    const finish = (result: CodexInvocationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      terminal = "timeout";
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 1_000).unref();
    }, input.timeoutMs);
    const abort = () => {
      terminal = "cancelled";
      killTree(child, "SIGTERM");
    };
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      finish({
        ok: false,
        classification: "error",
        runtimeSnapshot: {
          requestedModel: input.model,
          requestedEffort: input.effort,
          effectiveEffort: input.effort,
          usage: {},
          events: [{ spawnError: error.message }],
        },
      });
    });
    child.on("close", (code) => {
      const events = parseEvents(stdout);
      const agentMessages = events
        .map((event) =>
          (event as { type?: string; item?: { type?: string; text?: string } })
            ?.type === "item.completed"
            ? (event as { item?: { type?: string; text?: string } }).item
            : undefined,
        )
        .filter((item) => item?.type === "agent_message");
      const text = agentMessages.at(-1)?.text;
      const completed = events.findLast(
        (event) => (event as { type?: string })?.type === "turn.completed",
      ) as
        | { usage?: { input_tokens?: number; output_tokens?: number } }
        | undefined;
      const usage = {
        ...(completed?.usage?.input_tokens === undefined
          ? {}
          : { inputTokens: completed.usage.input_tokens }),
        ...(completed?.usage?.output_tokens === undefined
          ? {}
          : { outputTokens: completed.usage.output_tokens }),
      };
      const runtimeSnapshot: CodexRuntimeSnapshot = {
        requestedModel: input.model,
        requestedEffort: input.effort,
        effectiveEffort: input.effort,
        usage,
        events,
      };
      if (terminal !== undefined) {
        finish({ ok: false, classification: terminal, runtimeSnapshot });
        return;
      }
      if (code === 0 && completed !== undefined && text !== undefined) {
        finish({ ok: true, text, runtimeSnapshot });
        return;
      }
      const blob = `${stderr}\n${stdout}`;
      if (QUOTA_RE.test(blob)) {
        const retryAfter = RETRY_RE.exec(blob)?.[1];
        finish({
          ok: false,
          classification: "quota-exhausted",
          ...(retryAfter === undefined ? {} : { retryAfter }),
          runtimeSnapshot,
        });
        return;
      }
      finish({ ok: false, classification: "error", runtimeSnapshot });
    });
  });
}
