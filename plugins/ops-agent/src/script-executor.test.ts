import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptExecutor } from "./script-executor.js";
import { ScriptRegistry, type RegisteredScript } from "./script-registry.js";
import { writeFakeScript, type FakeScriptOptions } from "./testing/fake-script.js";

const dir = () => mkdtempSync(join(tmpdir(), "helium-ops-exec-"));
const signal = () => new AbortController().signal;

function rig(
  fake: FakeScriptOptions = {},
  overrides: Partial<RegisteredScript> = {},
  descendantMarker?: string,
) {
  const d = dir();
  const path = writeFakeScript(d, fake, descendantMarker);
  const script = {
    executorId: "script-v1",
    path,
    identity: {
      kind: "sha256" as const,
      value: createHash("sha256").update(readFileSync(path)).digest("hex"),
    },
    argvSchema: {
      id: "repair-argv-v1",
      params: [
        { flag: "--target-date", valuePattern: "\\d{4}-\\d{2}-\\d{2}", required: false },
        { flag: "--note", valuePattern: ".*", required: false },
      ],
    },
    cwd: d,
    environmentProfile: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPS_PROFILE: "minimal" },
    timeoutMs: 10_000,
    maxOutputBytes: 512,
    expectedOwnerUid: process.getuid?.() ?? 0,
    ...overrides,
  } as RegisteredScript;
  return { dir: d, script, executor: new ScriptExecutor(ScriptRegistry.load([script])) };
}

describe("ScriptExecutor", () => {
  it("runs a certified script and returns its receipt", async () => {
    const { executor } = rig({ exitCode: 0 });
    await expect(
      executor.run(
        { actionId: "action-1", executorId: "script-v1", argv: ["--target-date", "2026-08-21"] },
        signal(),
      ),
    ).resolves.toMatchObject({ actionId: "action-1", exit: { code: 0 } });
  });

  it("refuses argv the schema does not permit, before spawning anything", async () => {
    const { executor } = rig();
    await expect(
      executor.run(
        { actionId: "action-2", executorId: "script-v1", argv: ["; rm", "anything"] },
        signal(),
      ),
    ).rejects.toThrow(/argument schema/);
  });

  it("refuses a script that drifted since certification", async () => {
    const { executor, script } = rig();
    writeFakeScript(join(script.path, ".."), { exitCode: 3 });
    await expect(
      executor.run({ actionId: "a", executorId: "script-v1", argv: [] }, signal()),
    ).rejects.toThrow(/script-drift/);
  });

  it("reports a non-zero exit as a fact, not as a failure to throw about", async () => {
    const { executor } = rig({ exitCode: 7 });
    const receipt = await executor.run(
      { actionId: "a", executorId: "script-v1", argv: [] },
      signal(),
    );
    expect(receipt.exit.code).toBe(7);
    expect(receipt.timedOut).toBe(false);
  });

  // There is no shell, so there is nothing to escape for. A metacharacter
  // arrives at the child as a literal argument.
  it("passes shell metacharacters through as literal arguments", async () => {
    const { executor } = rig({ reportArgv: true }, {
      argvSchema: {
        id: "any-note-v1",
        params: [{ flag: "--note", valuePattern: ".*", required: true }],
      },
    });
    const receipt = await executor.run(
      { actionId: "a", executorId: "script-v1", argv: ["--note", "$(whoami); rm -rf /"] },
      signal(),
    );
    expect(receipt.outputTail).toContain("ARG:$(whoami); rm -rf /");
  });

  it("never assembles a command line: no shell invocation appears in the source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./script-executor.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("shell: false");
    // The only mentions of a shell are in the comment saying there is none.
    for (const forbidden of ['"sh"', '"bash"', "shell: true", "execSync"]) {
      expect(source, `executor must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("gives the child only the registered environment profile", async () => {
    process.env.HELIUM_OPS_LEAK_PROBE = "must-not-appear";
    try {
      const { executor } = rig({ reportEnvKeys: true });
      const receipt = await executor.run(
        { actionId: "a", executorId: "script-v1", argv: [] },
        signal(),
      );
      expect(receipt.outputTail).toContain("ENV:OPS_PROFILE");
      expect(receipt.outputTail).not.toContain("HELIUM_OPS_LEAK_PROBE");
    } finally {
      delete process.env.HELIUM_OPS_LEAK_PROBE;
    }
  });

  it("gives the child the registered cwd, never the daemon's", async () => {
    const { executor, dir: d } = rig({ reportCwd: true });
    const receipt = await executor.run(
      { actionId: "a", executorId: "script-v1", argv: [] },
      signal(),
    );
    expect(receipt.outputTail).toContain("CWD:");
    expect(receipt.outputTail).not.toContain(process.cwd());
    expect(statSync(d).isDirectory()).toBe(true);
  });

  it("bounds the retained output and digests the whole of it", async () => {
    const { executor } = rig({ emitBytes: 5000 }, { maxOutputBytes: 256 });
    const receipt = await executor.run(
      { actionId: "a", executorId: "script-v1", argv: [] },
      signal(),
    );
    expect(receipt.outputTail.length).toBeLessThanOrEqual(256);
    expect(receipt.outputBytes).toBeGreaterThan(5000);
    expect(receipt.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("times out and reaps the whole process group, descendants included", async () => {
    const marker = join(dir(), "descendant-alive");
    const { executor } = rig(
      { spawnDescendant: true, sleepMs: 30_000 },
      { timeoutMs: 400 },
      marker,
    );
    const receipt = await executor.run(
      { actionId: "a", executorId: "script-v1", argv: [] },
      signal(),
    );
    expect(receipt.timedOut).toBe(true);

    // The descendant writes the marker every 25ms while it lives. Remove it
    // after the kill; if it comes back, the descendant was orphaned, not reaped.
    await new Promise((r) => setTimeout(r, 200));
    rmSync(marker, { force: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(marker), "descendant survived the deadline").toBe(false);
  }, 20_000);

  it("escalates an abort to SIGKILL when the process group ignores TERM", async () => {
    const marker = join(dir(), "abort-descendant-alive");
    const rigged = rig(
      { spawnDescendant: true, ignoreTerm: true, sleepMs: 30_000 },
      { timeoutMs: 2_000 },
      marker,
    );
    const executor = new ScriptExecutor(
      ScriptRegistry.load([rigged.script]),
      { killGraceMs: 100 },
    );
    const abort = new AbortController();
    const started = Date.now();
    const running = executor.run(
      { actionId: "abort", executorId: "script-v1", argv: [] },
      abort.signal,
    );
    for (let attempt = 0; attempt < 60 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(marker)).toBe(true);
    abort.abort();
    const receipt = await running;
    expect(receipt.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_700);
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(marker, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(marker), "descendant survived abort escalation").toBe(false);
  }, 5_000);

  it("does not miss an AbortSignal that was already aborted before spawn", async () => {
    const rigged = rig(
      { ignoreTerm: true, sleepMs: 30_000 },
      { timeoutMs: 2_000 },
    );
    const executor = new ScriptExecutor(
      ScriptRegistry.load([rigged.script]),
      { killGraceMs: 100 },
    );
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const receipt = await executor.run(
      { actionId: "pre-aborted", executorId: "script-v1", argv: [] },
      abort.signal,
    );
    expect(receipt.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  }, 5_000);

  it("refuses an unknown executor", async () => {
    const { executor } = rig();
    await expect(
      executor.run({ actionId: "a", executorId: "ghost", argv: [] }, signal()),
    ).rejects.toThrow(/unknown executor/);
  });
});
