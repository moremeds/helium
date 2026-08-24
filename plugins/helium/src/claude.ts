/**
 * Dispatch — senior lane (spec §4, §12): spawns the host `claude -p` binary,
 * parses its JSON output, enforces the wall clock with SIGTERM->SIGKILL, and
 * classifies failures. Secrets are read from disk and injected only into the
 * child environment; values are never logged.
 * @module dsh-plugin-helium/claude
 */
import { spawn } from "node:child_process";
import { readEnvFile } from "./envfile.js";

export type ClaudeClassification = "proxy" | "auth" | "timeout" | "error";

export interface ClaudeResult {
  ok: boolean;
  text?: string;
  classification?: ClaudeClassification;
  raw?: unknown;
}

const SIGKILL_GRACE_MS = 10_000;

/**
 * Child-only environment. The OAuth token and the proxy exist for this process
 * tree and nowhere else (spec §12). Values are returned, never logged.
 *
 * An ambient `ANTHROPIC_API_KEY` in `base` SHADOWS the subscription token and
 * breaks auth (verified live, Spike B — task-1.7-report.md), so it is deleted
 * here rather than passed through: the child authenticates via
 * `CLAUDE_CODE_OAUTH_TOKEN` only.
 */
export function buildChildEnv(
  cfg: { claudeTokenFile: string; envFile: string; proxy: string },
  base: Record<string, string>,
): Record<string, string> {
  const token = readEnvFile(cfg.claudeTokenFile).CLAUDE_CODE_OAUTH_TOKEN;
  const env: Record<string, string> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.HTTPS_PROXY = cfg.proxy;
  env.HTTP_PROXY = cfg.proxy;
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

function classify(stderr: string, stdout: string): ClaudeClassification {
  const blob = `${stderr}\n${stdout}`;
  if (/\b401\b|unauthorized|invalid[_ ]?api[_ ]?key|authentication/i.test(blob)) return "auth";
  if (/\b403\b|ECONNREFUSED|ECONNRESET|EAI_AGAIN|proxy|tunnel/i.test(blob)) return "proxy";
  return "error";
}

export async function runClaude(opts: {
  prompt: string;
  cwd: string;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
  mcpConfigPath?: string;
  env: Record<string, string>;
}): Promise<ClaudeResult> {
  const args = ["-p", opts.prompt, "--output-format", "json", "--max-turns", String(opts.maxTurns)];
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.allowedTools.length > 0) args.push("--allowedTools", ...opts.allowedTools);

  return await new Promise<ClaudeResult>((resolve) => {
    const child = spawn("claude", args, {
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
    }, opts.timeoutMs);

    child.on("error", (error: Error) => {
      clearTimeout(term);
      if (kill) clearTimeout(kill);
      resolve({ ok: false, classification: "error", raw: { spawnError: error.message } });
    });

    child.on("close", () => {
      clearTimeout(term);
      if (kill) clearTimeout(kill);
      if (timedOut) {
        resolve({ ok: false, classification: "timeout", raw: { timeoutMs: opts.timeoutMs } });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        resolve({ ok: false, classification: classify(stderr, stdout), raw: { stdout, stderr } });
        return;
      }
      // `claude -p --output-format json` streams the WHOLE run as a JSON
      // ARRAY and puts the envelope last: on 2.1.241 a one-turn run comes
      // back as [system, assistant, rate_limit_event, result] (captured live
      // on the mini, task 3.3 step 22). Reading `.is_error` off the array
      // yields undefined, which is not `true`, so every senior run -- the
      // most expensive lane there is -- would have resolved ok:true with
      // text:undefined, and a real is_error envelope would have been
      // reported as a success. Take the terminal `result` event; fall back
      // to the last element so a shape change still surfaces an envelope
      // rather than silently succeeding. A bare object is still accepted.
      const envelope = Array.isArray(parsed)
        ? (parsed.findLast(
            (e) => (e as { type?: string } | null)?.type === "result",
          ) ?? parsed.at(-1))
        : parsed;
      if (typeof envelope !== "object" || envelope === null) {
        resolve({
          ok: false,
          classification: classify(stderr, stdout),
          raw: { stdout, stderr },
        });
        return;
      }
      const body = envelope as { result?: string; is_error?: boolean };
      if (body.is_error === true) {
        resolve({ ok: false, text: body.result, classification: "error", raw: envelope });
        return;
      }
      resolve({ ok: true, text: body.result, raw: envelope });
    });
  });
}
