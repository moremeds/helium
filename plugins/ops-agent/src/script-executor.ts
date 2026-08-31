/**
 * The certified exact-argv script executor.
 *
 * `spawn(path, argv, { shell: false, ... })`. There is no `sh -c`, no
 * `bash -c`, and no string ever assembled into a command line -- not from
 * configuration, and certainly not from model text. A shell metacharacter in
 * an argument is passed to the child as a literal argument, because there is
 * no shell to interpret it.
 *
 * It returns an execution RECEIPT and nothing more. It never returns
 * `recovered`, `succeeded`, or any other verdict: whether the component
 * actually recovered is decided by the postcondition set, elsewhere. A zero
 * exit is a fact about a process, not evidence about a system.
 * @module dsh-plugin-ops-agent/script-executor
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import type { ScriptRegistry } from "./script-registry.js";

export interface ExecutionRequest {
  actionId: string;
  executorId: string;
  argv: string[];
  /** Runs synchronously while the child is blocked behind inherited fd 3. */
  onSpawn?: (pid: number) => void;
  /**
   * Runs only after the `go` byte sequence has been flushed into the child's
   * inherited fd 3. A durable event written here can prove the gated child was
   * released; `onSpawn` alone proves only lock ownership.
   */
  onExecutionReleased?: (pid: number) => void;
}

export interface ExecutionReceipt {
  actionId: string;
  executorId: string;
  /** Exactly what was passed to the child, for the record. */
  argv: string[];
  exit: { code: number | null; signal: NodeJS.Signals | null };
  timedOut: boolean;
  /** Bounded tail; the full output is represented by its digest. */
  outputTail: string;
  outputBytes: number;
  outputDigest: string;
  startedAt: string;
  finishedAt: string;
}

export type ExecutionGate = () => Promise<
  { admitted: true } | { admitted: false; reason: string }
>;

export type ExecutionOutputSink = (
  stream: "stdout" | "stderr",
  chunk: Buffer,
) => void;

/** A pre-spawn guard refused. No child process was created. */
export class ExecutionSuppressedError extends Error {
  constructor(readonly reason: string) {
    super(`execution suppressed: ${reason}`);
    this.name = "ExecutionSuppressedError";
  }
}

const SIGKILL_GRACE_MS = 5_000;

export class ScriptExecutor {
  constructor(
    private readonly registry: ScriptRegistry,
    private readonly opts: { now?: () => Date; killGraceMs?: number } = {},
  ) {}

  async run(
    request: ExecutionRequest,
    signal: AbortSignal,
    gate?: ExecutionGate,
    outputSink?: ExecutionOutputSink,
  ): Promise<ExecutionReceipt> {
    const now = this.opts.now ?? (() => new Date());
    const script = this.registry.get(request.executorId);
    if (script === undefined) {
      throw new Error(`unknown executor: ${request.executorId}`);
    }

    // Validate BEFORE touching the filesystem or the process table.
    this.registry.validateArgv(script, request.argv);

    // Identity is compared immediately before spawn, so the window between
    // "certified" and "executed" is as small as it can be made.
    const identity = this.registry.verifyIdentity(script);
    if (!identity.ok) {
      throw new Error(
        `refusing to execute ${request.executorId}: ${identity.reason}`,
      );
    }

    // This callback performs the final controller-enumeration check and
    // write-ahead intent append. Nothing asynchronous occurs between a
    // successful return and `spawn`, which makes this the execution boundary
    // rather than an earlier advisory check.
    const gateDecision = await gate?.();
    if (gateDecision !== undefined && !gateDecision.admitted) {
      throw new ExecutionSuppressedError(gateDecision.reason);
    }

    const startedAt = now().toISOString();
    const killGraceMs = this.opts.killGraceMs ?? SIGKILL_GRACE_MS;

    return await new Promise<ExecutionReceipt>((resolve, reject) => {
      const child = spawn(script.path, request.argv, {
        shell: false,
        detached: true,
        cwd: script.cwd,
        // The COMPLETE environment. Nothing from this process is inherited.
        env: { ...script.environmentProfile },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });

      const executionGate = child.stdio[3] as Writable | null | undefined;
      const childPid = child.pid;
      if (childPid === undefined || executionGate === null || executionGate === undefined) {
        child.kill("SIGKILL");
        reject(new Error("spawned executor has no pid or adoption gate"));
        return;
      }
      try {
        request.onSpawn?.(childPid);
      } catch (error) {
        try { process.kill(-childPid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        executionGate.destroy();
        reject(error);
        return;
      }

      const digest = createHash("sha256");
      let bytes = 0;
      let tail = "";
      let timedOut = false;

      const absorb = (stream: "stdout" | "stderr", chunk: Buffer) => {
        outputSink?.(stream, chunk);
        digest.update(chunk);
        bytes += chunk.length;
        tail = (tail + chunk.toString()).slice(-script.maxOutputBytes);
      };
      child.stdout!.on("data", (chunk: Buffer) => absorb("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => absorb("stderr", chunk));

      /**
       * Signal the whole process GROUP. A repair script that spawned helpers
       * must not leave descendants running past its deadline -- `detached:
       * true` gives the child its own group whose id is its pid, hence -pid.
       */
      const killTree = (sig: NodeJS.Signals) => {
        const pid = child.pid;
        try {
          if (pid !== undefined) process.kill(-pid, sig);
          else child.kill(sig);
        } catch {
          // already gone
        }
      };

      let killTimer: NodeJS.Timeout | undefined;
      const beginTermination = () => {
        timedOut = true;
        killTree("SIGTERM");
        if (killTimer === undefined) {
          killTimer = setTimeout(() => killTree("SIGKILL"), killGraceMs);
        }
      };
      const deadline = setTimeout(beginTermination, script.timeoutMs);

      const onAbort = beginTermination;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      const finish = () => {
        clearTimeout(deadline);
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
      };

      child.on("error", (error: Error) => {
        finish();
        reject(error);
      });

      child.on("close", (code, sig) => {
        finish();
        resolve({
          actionId: request.actionId,
          executorId: request.executorId,
          argv: [...request.argv],
          exit: { code, signal: sig },
          timedOut,
          outputTail: tail,
          outputBytes: bytes,
          outputDigest: `sha256:${digest.digest("hex")}`,
          startedAt,
          finishedAt: now().toISOString(),
        });
      });

      let gateWriteFailed = false;
      executionGate.once("error", () => {
        // The child can close fd 3 after an abort/timeout races with this
        // final write.  It has not received the release token, so kill the
        // group and let the ordinary close receipt drive reconciliation;
        // never surface an unhandled EPIPE from the inherited pipe.
        gateWriteFailed = true;
        killTree("SIGKILL");
      });
      executionGate.end("go\n", () => {
        if (gateWriteFailed) return;
        try {
          request.onExecutionReleased?.(childPid);
        } catch (error) {
          killTree("SIGKILL");
          reject(error);
        }
      });
    });
  }
}
