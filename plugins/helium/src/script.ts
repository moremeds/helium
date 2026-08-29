/**
 * Script action lane (Task 3.6, spec §10): spawns an operator-authored
 * command as a gated job action, used by the dsh upgrade canary
 * (jobs/dsh-canary.yaml) so a purely mechanical check never costs a model
 * call. Mirrors claude.ts's SIGTERM->SIGKILL wall-clock enforcement; the
 * script's own stdout tail becomes the delivered analysis payload.
 * @module dsh-plugin-helium/script
 */
import { spawn } from "node:child_process";
import type { JobScriptAction } from "@helium/v1-compat";

const SIGKILL_GRACE_MS = 10_000;
const OUTPUT_TAIL = 8_000;
const ERROR_TAIL = 2_000;

export interface ScriptResult {
  ok: boolean;
  timedOut: boolean;
  code: number | null;
  /** Tail of stdout — becomes `DispatchResult.analysis`. */
  analysis: string;
  error?: string;
}

/**
 * Run one `job.script` action to completion, non-zero exit, or timeout.
 * Never throws — every outcome resolves.
 * @param action - the command/args/timeoutMs parsed from the job YAML.
 * @param opts - the child's working directory and full environment.
 */
export async function runScriptProcess(
  action: JobScriptAction,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ScriptResult> {
  return await new Promise<ScriptResult>((resolve) => {
    const child = spawn(action.command, action.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Give the script its own process group so the timeout below can signal
      // the whole tree. child.kill() reaches ONLY the direct child, and this
      // promise resolves on "close", which does not fire until every process
      // holding the stdout pipe has exited -- so a script that backgrounds
      // anything, or whose shell does not exec its last command, keeps a
      // timed-out run pending long past its declared timeout. Platform-
      // dependent and therefore easy to miss: macOS closes the streams when the
      // direct child exits and looks fine, while Linux waits for pipe EOF (CI
      // caught a run still pending 15s after a 100ms timeout).
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

    /**
     * Signal the script's whole process group. A negative pid means "the group"
     * to kill(2); the fallback covers the case where the group is already gone
     * (ESRCH) or the platform refused the negative form.
     */
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already reaped -- nothing left to signal.
        }
      }
    };

    let kill: NodeJS.Timeout | undefined;
    const term = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      kill = setTimeout(() => killTree("SIGKILL"), SIGKILL_GRACE_MS);
    }, action.timeoutMs);

    child.on("error", (error: Error) => {
      clearTimeout(term);
      if (kill) clearTimeout(kill);
      resolve({
        ok: false,
        timedOut: false,
        code: null,
        analysis: stdout.slice(-OUTPUT_TAIL),
        error: `spawn error: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(term);
      if (kill) clearTimeout(kill);
      if (timedOut) {
        resolve({
          ok: false,
          timedOut: true,
          code,
          analysis: stdout.slice(-OUTPUT_TAIL),
          error: `script exceeded timeoutMs=${action.timeoutMs}`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        timedOut: false,
        code,
        analysis: stdout.slice(-OUTPUT_TAIL),
        error: code === 0 ? undefined : stderr.slice(-ERROR_TAIL),
      });
    });
  });
}
