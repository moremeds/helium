import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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

const run = (dir: string, timeoutMs = 5_000) =>
  runClaude({
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
    expect(out.text).toContain("--mcp-config /tmp/mcp.json");
    expect(out.text).toContain("--allowedTools Read");
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
