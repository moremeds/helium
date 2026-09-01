import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "./claude.js";

function fakeClaude(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-bin-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * Fake CLI that writes a capture file whose path the body is built around.
 * Used to record argv one argument per line (a flattened `$*` cannot show an
 * EMPTY argument such as `--tools ""`) and to record PIDs.
 */
function fakeClaudeWithCapture(build: (capture: string) => string): {
  dir: string;
  capture: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "helium-bin-"));
  const capture = join(dir, "capture.txt");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${build(capture)}\n`);
  chmodSync(bin, 0o755);
  return { dir, capture };
}

/** Records the child's exact argv, one argument per line. */
const RECORD_ARGV = (capture: string): string =>
  [
    `: > "${capture}"`,
    `for a in "$@"; do printf '%s\\n' "$a" >> "${capture}"; done`,
    `echo '{"result":"recorded","is_error":false}'`,
  ].join("\n");

/** Reads a newline-delimited capture file back into its exact elements. */
function readLines(file: string): string[] {
  const raw = readFileSync(file, "utf8");
  return raw === "" ? [] : raw.split("\n").slice(0, -1);
}

/**
 * The values carried by `flag`, normalised across the CLI's two accepted
 * spellings ("Comma or space-separated list"). Throws when the flag is absent,
 * so every assertion built on it is a POSITIVE assertion about what argv
 * CONTAINS — never a claim about what it lacks. A build that emitted no
 * permission gate at all would fail here rather than pass.
 */
function valuesOf(argv: readonly string[], flag: string): string[] {
  const at = argv.indexOf(flag);
  if (at === -1) {
    throw new Error(`argv does not contain ${flag}: ${JSON.stringify(argv)}`);
  }
  const tokens: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) {
    tokens.push(argv[i]!);
  }
  return tokens.flatMap((t) => t.split(","));
}

/** A directory the senior child is allowed to own for one attempt. */
const workspace = (): string => mkdtempSync(join(tmpdir(), "helium-ws-"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls a capture file until it holds at least `count` lines. */
async function waitForLines(file: string, count: number, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const lines = existsSync(file) ? readLines(file) : [];
    if (lines.length >= count) return lines;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${file} never reached ${count} lines within ${budgetMs}ms`);
}

async function waitGone(pid: number, label: string, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label} (pid ${pid}) still alive ${budgetMs}ms past the deadline`);
}

describe("buildChildEnv", () => {
  it("injects the token and proxy without mutating process.env", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-secret-"));
    writeFileSync(
      join(dir, "claude-token.env"),
      "CLAUDE_CODE_OAUTH_TOKEN=tok-123\n",
    );
    writeFileSync(
      join(dir, "helium.env"),
      "DEEPSEEK_API_KEY=sk-1\nSMTP_HOST=smtp.example.com\n",
    );
    const env = buildChildEnv(
      {
        claudeTokenFile: join(dir, "claude-token.env"),
        envFile: join(dir, "helium.env"),
        proxy: "http://127.0.0.1:7897",
      },
      { PATH: "/usr/bin" },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SMTP_HOST).toBeUndefined(); // only the token file feeds the child
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // Controller addendum (Spike B evidence, task-1.7-report.md): an ambient
  // ANTHROPIC_API_KEY in the parent env SHADOWS the subscription token and
  // breaks auth. buildChildEnv must delete it and never pass it through.
  it("strips an ambient ANTHROPIC_API_KEY from the base env instead of passing it through", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-secret2-"));
    writeFileSync(
      join(dir, "claude-token.env"),
      "CLAUDE_CODE_OAUTH_TOKEN=tok-456\n",
    );
    writeFileSync(join(dir, "helium.env"), "");
    const env = buildChildEnv(
      {
        claudeTokenFile: join(dir, "claude-token.env"),
        envFile: join(dir, "helium.env"),
        proxy: "http://127.0.0.1:7897",
      },
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-shadowing-key" },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-456");
  });
});
