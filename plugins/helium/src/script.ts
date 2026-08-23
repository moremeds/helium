/**
 * Script action lane (Task 3.6, spec §10): spawns an operator-authored
 * command as a gated job action, used by the dsh upgrade canary
 * (jobs/dsh-canary.yaml) so a purely mechanical check never costs a model
 * call. Mirrors claude.ts's SIGTERM->SIGKILL wall-clock enforcement; the
 * script's own stdout tail becomes the delivered analysis payload.
 * @module dsh-plugin-helium/script
 */
import { spawn } from "node:child_process";
import type { JobScriptAction } from "@helium/core";

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

    let kill: NodeJS.Timeout | undefined;
    const term = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
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
