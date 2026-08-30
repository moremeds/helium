import { spawn, type ChildProcess } from "node:child_process";
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

export async function invokeCodex(input: {
  model: string;
  effort: CodexEffort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  sandbox: "read-only" | "workspace-write";
  env: Record<string, string>;
  signal?: AbortSignal;
}): Promise<CodexInvocationResult> {
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
    child.on("close", () => {
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
      finish(
        text === undefined
          ? { ok: false, classification: "error", runtimeSnapshot }
          : { ok: true, text, runtimeSnapshot },
      );
    });
  });
}
