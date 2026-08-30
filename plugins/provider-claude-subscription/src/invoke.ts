import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeEffort } from "./catalog.js";

export type ClaudeClassification =
  | "proxy"
  | "auth"
  | "timeout"
  | "cancelled"
  | "quota-exhausted"
  | "error";

export interface ClaudeRuntimeSnapshot {
  requestedModel: string;
  requestedEffort?: ClaudeEffort;
  effectiveEffort?: ClaudeEffort;
  providerReportedEffort?: string;
  modelUsage: Record<string, unknown>;
}

export interface ClaudeInvocationResult {
  ok: boolean;
  text?: string;
  classification?: ClaudeClassification;
  retryAfter?: string;
  raw?: unknown;
  runtimeSnapshot: ClaudeRuntimeSnapshot;
}

export interface ClaudeInvocation {
  model: string;
  effort?: ClaudeEffort;
  prompt: string;
  cwd: string;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
  mcpConfigPath?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

const QUOTA_RE =
  /\b429\b|rate[_\s-]?limit|usage limit|session limit|quota[_\s-]?(?:exceeded|exhausted)/i;
const RETRY_AFTER_RE =
  /"(?:retry[_-]?after|resets?[_-]?at)"\s*:\s*"([^"]+)"|\bretry-after:\s*([^\s,;}\"]+)/i;

function classify(stderr: string, stdout: string) {
  const blob = `${stderr}\n${stdout}`;
  if (QUOTA_RE.test(blob)) {
    const hit = RETRY_AFTER_RE.exec(blob);
    const retryAfter = hit?.[1] ?? hit?.[2];
    return retryAfter === undefined
      ? ({ classification: "quota-exhausted" } as const)
      : ({ classification: "quota-exhausted", retryAfter } as const);
  }
  if (/\b401\b|unauthorized|invalid[_ ]?api[_ ]?key|authentication/i.test(blob)) {
    return { classification: "auth" } as const;
  }
  if (/\b403\b|ECONNREFUSED|ECONNRESET|EAI_AGAIN|proxy|tunnel/i.test(blob)) {
    return { classification: "proxy" } as const;
  }
  return { classification: "error" } as const;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group is gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

export async function invokeClaude(
  input: ClaudeInvocation,
): Promise<ClaudeInvocationResult> {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(input.maxTurns),
    "--tools",
    "",
    "--allowedTools",
    input.allowedTools.join(","),
    "--setting-sources",
    "",
    "--model",
    input.model,
  ];
  if (input.effort !== undefined) args.push("--effort", input.effort);
  if (input.mcpConfigPath !== undefined) {
    args.push("--mcp-config", input.mcpConfigPath, "--strict-mcp-config");
  }

  return await new Promise<ClaudeInvocationResult>((resolve) => {
    const child = spawn("claude", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let terminal: "timeout" | "cancelled" | undefined;
    let settled = false;
    const runtime = (envelope?: unknown): ClaudeRuntimeSnapshot => {
      const body = envelope as
        | { modelUsage?: unknown; model_usage?: unknown; effort?: unknown }
        | undefined;
      const usage = body?.modelUsage ?? body?.model_usage;
      return {
        requestedModel: input.model,
        ...(input.effort === undefined
          ? {}
          : {
              requestedEffort: input.effort,
              effectiveEffort: input.effort,
            }),
        ...(typeof body?.effort === "string"
          ? { providerReportedEffort: body.effort }
          : {}),
        modelUsage:
          typeof usage === "object" && usage !== null
            ? (usage as Record<string, unknown>)
            : {},
      };
    };
    const finish = (result: ClaudeInvocationResult) => {
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
      setTimeout(() => killTree(child, "SIGKILL"), 10_000).unref();
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
        raw: { spawnError: error.message },
        runtimeSnapshot: runtime(),
      });
    });
    child.on("close", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const failure =
          terminal === undefined
            ? classify(stderr, stdout)
            : { classification: terminal };
        finish({
          ok: false,
          ...failure,
          raw: { stdout, stderr },
          runtimeSnapshot: runtime(),
        });
        return;
      }
      const envelope = Array.isArray(parsed)
        ? (parsed.findLast(
            (entry) => (entry as { type?: string } | null)?.type === "result",
          ) ?? parsed.at(-1))
        : parsed;
      if (terminal !== undefined) {
        finish({
          ok: false,
          classification: terminal,
          raw: envelope,
          runtimeSnapshot: runtime(envelope),
        });
        return;
      }
      if (typeof envelope !== "object" || envelope === null) {
        finish({
          ok: false,
          ...classify(stderr, stdout),
          raw: { stdout, stderr },
          runtimeSnapshot: runtime(),
        });
        return;
      }
      const body = envelope as { result?: string; is_error?: boolean };
      if (body.is_error === true) {
        finish({
          ok: false,
          text: body.result,
          ...classify(stderr, stdout),
          raw: envelope,
          runtimeSnapshot: runtime(envelope),
        });
        return;
      }
      finish({
        ok: true,
        text: body.result,
        raw: envelope,
        runtimeSnapshot: runtime(envelope),
      });
    });
  });
}
