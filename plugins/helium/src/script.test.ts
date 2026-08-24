/**
 * Unit coverage for the script-action runner (Task 3.6): success, non-zero
 * exit, spawn failure, and wall-clock timeout with SIGTERM. Mirrors
 * claude.test.ts's fake-binary pattern.
 * @module dsh-plugin-helium/script.test
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScriptProcess } from "./script.js";

function fakeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-script-bin-"));
  const bin = join(dir, "run.sh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const run = (command: string, args: string[] = [], timeoutMs = 5_000) =>
  runScriptProcess(
    { command, args, timeoutMs },
    { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } },
  );

describe("runScriptProcess", () => {
  it("resolves ok on a zero exit, with stdout as the analysis", async () => {
    const bin = fakeScript(`echo "candidate check passed"`);
    const out = await run(bin);
    expect(out.ok).toBe(true);
    expect(out.timedOut).toBe(false);
    expect(out.code).toBe(0);
    expect(out.analysis).toContain("candidate check passed");
    expect(out.error).toBeUndefined();
  });

  it("passes args through to the child", async () => {
    const bin = fakeScript(`echo "args=$*"`);
    const out = await run(bin, ["--candidate", "0.1.1-rc.99"]);
    expect(out.analysis).toContain("args=--candidate 0.1.1-rc.99");
  });

  it("resolves ok=false on a non-zero exit, with stderr as the error", async () => {
    const bin = fakeScript(`echo "boom" 1>&2; exit 3`);
    const out = await run(bin);
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(false);
    expect(out.code).toBe(3);
    expect(out.error).toContain("boom");
  });

  it("truncates a large stdout to the last 8000 chars", async () => {
    const bin = fakeScript(`node -e "process.stdout.write('x'.repeat(9000))"`);
    const out = await run(bin);
    expect(out.analysis.length).toBe(8_000);
  });

  // The old version of this test ran `sleep 5` against vitest's 5000ms default
  // ceiling, so the assertion raced the test runner with zero margin and lost on
  // a slow CI machine (the run itself is bounded at 100ms; only scheduling delay
  // separated pass from fail). The script now sleeps far longer than any
  // assertion window and the vitest timeout is explicit and generous, so what
  // enforces the behaviour is the elapsed-time assertion below and never the
  // runner's ceiling.
  it(
    "kills a hung script with SIGTERM and resolves timedOut=true",
    async () => {
      const bin = fakeScript(`sleep 30`);
      const started = Date.now();
      const out = await run(bin, [], 100);
      expect(out.ok).toBe(false);
      expect(out.timedOut).toBe(true);
      expect(out.error).toContain("timeoutMs=100");
      // ~100ms if SIGTERM landed; ~30s if it did not.
      expect(Date.now() - started).toBeLessThan(2_000);
    },
    15_000,
  );

  it("resolves a spawn error (unknown command) without throwing", async () => {
    const out = await run("/no/such/binary/helium-canary-fixture");
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(false);
    expect(out.code).toBeNull();
    expect(out.error).toContain("spawn error");
  });
});
