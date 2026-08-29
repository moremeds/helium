/**
 * A metered, process-isolated reference executor.
 *
 * One of two fakes registered by the executor registry. They differ on BOTH
 * axes -- isolation class and billing model -- because one fake cannot hold
 * both sets of invariants at once, and splitting only on isolation class
 * leaves the `budget-exhausted` / `quota-exhausted` distinction with no test
 * that can break it. The regression that would permit: core normalizes one
 * exhaustion state into the other, or defaults a missing cost to `0` and
 * treats it as a known zero, and the suite stays green.
 *
 * This executor is token-priced. It reports tokens and cost, it may terminate
 * `budget-exhausted`, and it MUST NEVER emit `quota-exhausted` -- there is no
 * code path here that constructs one.
 *
 * It spawns a real child process, which is what makes its `process` claim
 * demonstrable by the shared execution-boundary conformance suite rather than
 * merely asserted.
 * @module @helium/fake-metered
 */
import { spawn } from "node:child_process";
import type {
  AgentResult,
  ExecutionContext,
  ExecutionTargetId,
  Executor,
  WorkOrder,
} from "@helium/core";

export interface MeteredExecutorOptions {
  targetId: ExecutionTargetId;
  /**
   * The binary to spawn. Required rather than defaulted, so this package
   * names no provider: the caller supplies whatever CLI it is standing in for.
   */
  command: string;
  costPerRun?: number;
  tokensPerRun?: { input: number; output: number };
  /** When true every run terminates `budget-exhausted` instead of completing. */
  budgetExhausted?: boolean;
  timeoutMs?: number;
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * The flag set is the boundary, not a formatting choice: `--tools ""` disables
 * the entire built-in set, `--allowedTools` is the only flag that carries the
 * declared names and is emitted even when empty so an empty declared set stays
 * empty rather than becoming the provider default, and `--setting-sources ""`
 * inherits no settings file.
 */
function argsFor(work: WorkOrder, context: ExecutionContext): string[] {
  const args = [
    "-p",
    work.inputs.prompt ?? "",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--allowedTools",
    context.allowedTools.join(","),
    "--setting-sources",
    "",
  ];
  if (context.mcpConfigPath !== undefined) {
    args.push("--mcp-config", context.mcpConfigPath, "--strict-mcp-config");
  }
  return args;
}

function spawnChild(
  command: string,
  args: string[],
  context: ExecutionContext,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const child = spawn(command, args, {
      cwd: context.workspace,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const kill = () => {
      const pid = child.pid;
      try {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: Error) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut, spawnError: error.message });
    });
    child.on("close", () => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

/** Take the terminal `result` event; fall back to the last element. */
function envelopeResult(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const envelope = Array.isArray(parsed)
    ? (parsed.findLast((e) => (e as { type?: string } | null)?.type === "result") ??
      parsed.at(-1))
    : parsed;
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const body = envelope as { result?: string; is_error?: boolean };
  return body.is_error === true ? undefined : body.result;
}

export function createMeteredExecutor(
  options: MeteredExecutorOptions,
): Executor {
  const {
    targetId,
    command,
    costPerRun = 0.01,
    tokensPerRun = { input: 100, output: 50 },
    budgetExhausted = false,
    timeoutMs = 30_000,
  } = options;

  const snapshot = (ms: number) => ({
    targetId: String(targetId),
    providerId: "fake-metered",
    model: "metered-1",
    providerVersion: "0.0.0",
    isolationClass: "process" as const,
    recordedAt: new Date(ms).toISOString(),
  });

  return {
    targetId,
    isolationClass: "process",

    async run(
      work: WorkOrder,
      signal: AbortSignal,
      context: ExecutionContext,
    ): Promise<AgentResult> {
      const started = Date.now();
      if (budgetExhausted) {
        // Metered billing exhausts a BUDGET -- a spent allowance. It never
        // exhausts a quota, and this package constructs no such failure.
        return {
          workId: work.id,
          outcome: "failed",
          failure: { class: "budget-exhausted", safeDetail: "cost ceiling reached" },
          artifacts: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            ms: Date.now() - started,
          },
          executionSnapshot: snapshot(started),
          runtimeMetadata: { fake: "metered", reason: "budget" },
        };
      }

      const outcome = await spawnChild(
        command,
        argsFor(work, context),
        context,
        signal,
        timeoutMs,
      );
      const ms = Date.now() - started;
      const usage = {
        inputTokens: tokensPerRun.input,
        outputTokens: tokensPerRun.output,
        cost: costPerRun,
        ms,
      };
      const result = outcome.timedOut ? undefined : envelopeResult(outcome.stdout);

      if (result === undefined) {
        return {
          workId: work.id,
          outcome: "failed",
          failure: {
            class: outcome.timedOut ? "timeout" : "provider-error",
            safeDetail: outcome.spawnError ?? "no result envelope",
          },
          artifacts: [],
          usage,
          executionSnapshot: snapshot(started),
          runtimeMetadata: { fake: "metered", stderrBytes: outcome.stderr.length },
        };
      }

      return {
        workId: work.id,
        outcome: "completed",
        structured: result,
        artifacts: [],
        usage,
        executionSnapshot: snapshot(started),
        runtimeMetadata: { fake: "metered", stdoutBytes: outcome.stdout.length },
      };
    },

    async drain(): Promise<void> {
      // Nothing queued: every run owns its own child and awaits its close.
    },
  };
}
