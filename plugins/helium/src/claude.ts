/**
 * Dispatch — senior lane (spec §4, §12): spawns the host `claude -p` binary,
 * parses its JSON output, enforces the wall clock with SIGTERM->SIGKILL, and
 * classifies failures. Secrets are read from disk and injected only into the
 * child environment; values are never logged.
 * @module dsh-plugin-helium/claude
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readEnvFile } from "./envfile.js";

export type ClaudeClassification =
  | "proxy"
  | "auth"
  | "timeout"
  | "quota-exhausted"
  | "error";

export interface ClaudeResult {
  ok: boolean;
  text?: string;
  classification?: ClaudeClassification;
  /** Opaque provider-supplied hint; only meaningful for `quota-exhausted`. */
  retryAfter?: string;
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

/**
 * Subscription session-window exhaustion. Checked AHEAD of `auth` and `proxy`
 * because a 429 envelope frequently also carries wording those two patterns
 * match, and because the downstream meaning is different in kind: the target's
 * capabilities are unchanged, it is merely unavailable until `retryAfter`.
 */
const QUOTA_RE =
  /\b429\b|rate[_\s-]?limit|usage limit|session limit|quota[_\s-]?(?:exceeded|exhausted)/i;

/**
 * The provider's own reset hint, carried through verbatim. Deliberately NOT
 * parsed into a duration, and never synthesised when the provider gives none.
 */
const RETRY_AFTER_RE =
  /"(?:retry[_-]?after|resets?[_-]?at)"\s*:\s*"([^"]+)"|\bretry-after:\s*([^\s,;}"]+)/i;

function classify(
  stderr: string,
  stdout: string,
): { classification: ClaudeClassification; retryAfter?: string } {
  const blob = `${stderr}\n${stdout}`;
  if (QUOTA_RE.test(blob)) {
    const hit = RETRY_AFTER_RE.exec(blob);
    const retryAfter = hit?.[1] ?? hit?.[2];
    return retryAfter === undefined
      ? { classification: "quota-exhausted" }
      : { classification: "quota-exhausted", retryAfter };
  }
  if (/\b401\b|unauthorized|invalid[_ ]?api[_ ]?key|authentication/i.test(blob)) {
    return { classification: "auth" };
  }
  if (/\b403\b|ECONNREFUSED|ECONNRESET|EAI_AGAIN|proxy|tunnel/i.test(blob)) {
    return { classification: "proxy" };
  }
  return { classification: "error" };
}

/**
 * Signals the child's whole process group, so a senior run that spawned
 * helpers cannot leave descendants running past its wall clock. `detached:
 * true` gives the child its own group whose id equals its pid, hence `-pid`.
 * Falls back to the direct child when no group exists (or it is already gone).
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // no process group (or already reaped) — fall through to the child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
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
  // Flag semantics are NOT interchangeable (verified against CLI 2.1.250 help):
  // `--tools` names the BUILT-IN set only, `--allowedTools` is the permission
  // allow-list and the only flag that accepts `mcp__helium__*` names. All three
  // restrictions ship together, and `--allowedTools` is emitted even for an
  // empty declared set so an empty list stays empty instead of silently
  // becoming the provider default.
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(opts.maxTurns),
    // disable the entire built-in tool set
    "--tools",
    "",
    // permission allow-list: exactly the declared mcp__helium__* names
    "--allowedTools",
    opts.allowedTools.join(","),
    // inherit no user / project / local settings file
    "--setting-sources",
    "",
  ];
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }

  return await new Promise<ClaudeResult>((resolve) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      // own process group, so the deadline can reap descendants too
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

    let kill: NodeJS.Timeout | undefined;
    const term = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      kill = setTimeout(() => killTree(child, "SIGKILL"), SIGKILL_GRACE_MS);
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
        resolve({ ok: false, ...classify(stderr, stdout), raw: { stdout, stderr } });
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
          ...classify(stderr, stdout),
          raw: { stdout, stderr },
        });
        return;
      }
      const body = envelope as { result?: string; is_error?: boolean };
      if (body.is_error === true) {
        // A failing ENVELOPE is classified too, not hard-coded to `error`: a
        // session-window exhaustion arrives this way, and it must surface as
        // `quota-exhausted` rather than as a generic failure.
        resolve({
          ok: false,
          text: body.result,
          ...classify(stderr, stdout),
          raw: envelope,
        });
        return;
      }
      resolve({ ok: true, text: body.result, raw: envelope });
    });
  });
}
