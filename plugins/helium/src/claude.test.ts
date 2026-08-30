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
import { buildChildEnv, runClaude } from "./claude.js";

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

const run = (dir: string, timeoutMs = 5_000) =>
  runClaude({
    model: "claude-sonnet-5",
    effort: "high",
    prompt: "analyze",
    cwd: process.cwd(),
    maxTurns: 4,
    timeoutMs,
    allowedTools: ["Read", "mcp__helium__argon_api"],
    env: { PATH: dir },
  });

describe("runClaude", () => {
  it("returns the result text on a successful JSON run", async () => {
    const dir = fakeClaude(
      `echo '{"result":"Rate path unchanged.","is_error":false,"num_turns":2,"duration_ms":900}'`,
    );
    const out = await run(dir);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("Rate path unchanged.");
    expect((out.raw as { num_turns: number }).num_turns).toBe(2);
  });

  it("passes the prompt, turn cap, output format, tools and mcp config through", async () => {
    const dir = fakeClaude(
      `echo "{\\"result\\":\\"$*\\",\\"is_error\\":false}"`,
    );
    const out = await runClaude({
      model: "claude-sonnet-5",
      effort: "xhigh",
      prompt: "PROMPTBODY",
      cwd: process.cwd(),
      maxTurns: 8,
      timeoutMs: 5_000,
      allowedTools: ["Read"],
      mcpConfigPath: "/tmp/mcp.json",
      env: { PATH: dir },
    });
    expect(out.text).toContain("PROMPTBODY");
    expect(out.text).toContain("--output-format json");
    expect(out.text).toContain("--max-turns 8");
    expect(out.text).toContain("--model claude-sonnet-5");
    expect(out.text).toContain("--effort xhigh");
    expect(out.text).toContain("--mcp-config /tmp/mcp.json");
    expect(out.text).toContain("--allowedTools Read");
  });

  it("reads the envelope out of the real CLI's streamed JSON array", async () => {
    // The shape below is the real one, captured from `claude -p
    // --output-format json --max-turns 2` on CLI 2.1.241 on the mini (task
    // 3.3 step 22): the whole run streams back as an ARRAY whose LAST element
    // is the result envelope. Reading is_error/result off the array itself
    // gives undefined, so the old parser resolved ok:true with no text on
    // every senior run.
    const dir = fakeClaude(
      `echo '[{"type":"system","subtype":"init"},{"type":"assistant"},{"type":"rate_limit_event"},{"type":"result","subtype":"success","is_error":false,"result":"HELIUM-OK","num_turns":1}]'`,
    );
    const out = await run(dir);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("HELIUM-OK");
    expect((out.raw as { num_turns: number }).num_turns).toBe(1);
  });

  it("still fails a streamed array whose terminal envelope reports is_error", async () => {
    const dir = fakeClaude(
      `echo '[{"type":"system"},{"type":"result","subtype":"error_max_turns","is_error":true,"result":"turn cap hit"}]'`,
    );
    const out = await run(dir);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("turn cap hit");
    expect(out.classification).toBe("error");
  });

  it("treats is_error as a failed run and keeps the text", async () => {
    const dir = fakeClaude(
      `echo '{"result":"tool blew up","is_error":true,"num_turns":1}'`,
    );
    const out = await run(dir);
    expect(out.ok).toBe(false);
    expect(out.classification).toBe("error");
    expect(out.text).toBe("tool blew up");
  });

  it("classifies a 403 / connection refusal as a proxy failure", async () => {
    const dir = fakeClaude(
      `echo "connect ECONNREFUSED 127.0.0.1:7897" >&2; exit 1`,
    );
    expect((await run(dir)).classification).toBe("proxy");
  });

  it("classifies a 401 as an auth failure", async () => {
    const dir = fakeClaude(`echo "API error 401 unauthorized" >&2; exit 1`);
    expect((await run(dir)).classification).toBe("auth");
  });

  it("SIGTERMs a hung child at the deadline and classifies it as a timeout", async () => {
    // Busy-loop on shell builtins only (`:`), not `sleep` — the fixture's PATH is
    // deliberately narrowed to `dir` alone (see fakeClaude/run above) so spawn resolves
    // "claude" from it; an external `sleep` binary would not resolve under that same PATH
    // and would exit immediately with "command not found" instead of hanging.
    const dir = fakeClaude("while :; do :; done");
    const started = Date.now();
    const out = await run(dir, 400);
    expect(out.ok).toBe(false);
    expect(out.classification).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("classifies unparsable stdout as an error rather than throwing", async () => {
    const dir = fakeClaude(`echo 'not json'`);
    const out = await run(dir);
    expect(out.ok).toBe(false);
    expect(out.classification).toBe("error");
  });

  it("disables built-ins, allow-lists only declared MCP tools, and pins MCP config", async () => {
    const { dir, capture } = fakeClaudeWithCapture(RECORD_ARGV);
    const out = await runClaude({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: "PROMPTBODY",
      cwd: workspace(),
      maxTurns: 4,
      timeoutMs: 5_000,
      allowedTools: ["mcp__helium__argon_api", "mcp__helium__apex_api"],
      mcpConfigPath: "/tmp/mcp.json",
      env: { PATH: dir },
    });
    expect(out.ok).toBe(true);
    const argv = readLines(capture);

    // 1. every built-in tool is disabled
    expect(valuesOf(argv, "--tools")).toEqual([""]);

    // 2. the MCP allow-list equals the declared set exactly — no more, no less
    expect(valuesOf(argv, "--allowedTools")).toEqual([
      "mcp__helium__argon_api",
      "mcp__helium__apex_api",
    ]);

    // 3. no ambient MCP server or settings file is inherited
    expect(argv).toContain("--strict-mcp-config");
    expect(valuesOf(argv, "--mcp-config")).toEqual(["/tmp/mcp.json"]);
    expect(valuesOf(argv, "--setting-sources")).toEqual([""]);

    // the pre-existing contract still holds
    expect(argv).toContain("PROMPTBODY");
    expect(valuesOf(argv, "--max-turns")).toEqual(["4"]);
    expect(valuesOf(argv, "--output-format")).toEqual(["json"]);
  });

  it("emits an EMPTY allow-list for an empty declared set rather than omitting the flag", async () => {
    const { dir, capture } = fakeClaudeWithCapture(RECORD_ARGV);
    const out = await runClaude({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: "PROMPTBODY",
      cwd: workspace(),
      maxTurns: 4,
      timeoutMs: 5_000,
      allowedTools: [],
      mcpConfigPath: "/tmp/mcp.json",
      env: { PATH: dir },
    });
    expect(out.ok).toBe(true);
    const argv = readLines(capture);
    expect(argv).toContain("--allowedTools");
    // present AND empty — an omitted flag would fall back to the provider default
    expect(valuesOf(argv, "--allowedTools")).toEqual([""]);
    expect(valuesOf(argv, "--tools")).toEqual([""]);
    expect(valuesOf(argv, "--setting-sources")).toEqual([""]);
    expect(argv).toContain("--strict-mcp-config");
  });

  it(
    "kills the whole process group at the deadline, leaving no descendant behind",
    async () => {
      const { dir, capture } = fakeClaudeWithCapture((f) =>
        [
          // absolute interpreter path: the fixture PATH holds only `dir`
          "/bin/sh -c 'while :; do :; done' &",
          `echo $! > "${f}"`,
          `echo $$ >> "${f}"`,
          "while :; do :; done",
        ].join("\n"),
      );
      // The deadline is deliberately generous: under load the fork/exec of the
      // fixture can take hundreds of ms, and a deadline that fires before the
      // grandchild exists would make this test pass without ever proving
      // anything about the process group.
      const pending = runClaude({
        model: "claude-sonnet-5",
        effort: "high",
        prompt: "analyze",
        cwd: workspace(),
        maxTurns: 4,
        timeoutMs: 3_000,
        allowedTools: [],
        env: { PATH: dir },
      });
      const [descendant, cli] = (await waitForLines(capture, 2)).map(Number);
      expect(Number.isInteger(descendant)).toBe(true);
      expect(Number.isInteger(cli)).toBe(true);
      expect(alive(descendant)).toBe(true);

      const out = await pending;
      expect(out.ok).toBe(false);
      expect(out.classification).toBe("timeout");
      await waitGone(cli, "senior CLI");
      await waitGone(descendant, "senior CLI descendant");
    },
    45_000,
  );

  it("classifies a rate-limit envelope as quota-exhausted and keeps the reset hint verbatim", async () => {
    const dir = fakeClaude(
      `echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached","error":{"type":"rate_limit_error","status":429},"retry_after":"2026-08-29T18:00:00Z"}'`,
    );
    const out = await run(dir);
    expect(out.ok).toBe(false);
    expect(out.classification).toBe("quota-exhausted");
    expect(out.retryAfter).toBe("2026-08-29T18:00:00Z");
  });

  it("classifies a bare 429 as quota-exhausted without inventing a reset hint", async () => {
    const dir = fakeClaude(`echo "API error 429 rate_limit_error" >&2; exit 1`);
    const out = await run(dir);
    expect(out.classification).toBe("quota-exhausted");
    expect(out.retryAfter).toBeUndefined();
  });
});

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
