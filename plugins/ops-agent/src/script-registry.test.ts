import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptRegistry, type RegisteredScript } from "./script-registry.js";
import { writeFakeScript } from "./testing/fake-script.js";

const dir = () => mkdtempSync(join(tmpdir(), "helium-ops-script-"));

const scriptFor = (path: string, overrides: Partial<RegisteredScript> = {}) =>
  ({
    executorId: "script-v1",
    path,
    identity: {
      kind: "sha256" as const,
      value: createHash("sha256").update(readFileSync(path)).digest("hex"),
    },
    argvSchema: {
      id: "repair-argv-v1",
      params: [
        {
          flag: "--target-date",
          valuePattern: "\\d{4}-\\d{2}-\\d{2}",
          required: true,
        },
      ],
    },
    cwd: join(path, ".."),
    environmentProfile: { PATH: "/usr/bin:/bin" },
    timeoutMs: 30_000,
    maxOutputBytes: 4096,
    expectedOwnerUid: process.getuid?.() ?? 0,
    ...overrides,
  }) as RegisteredScript;

describe("ScriptRegistry", () => {
  it("registers and returns a script by id", () => {
    const d = dir();
    const registry = ScriptRegistry.load([scriptFor(writeFakeScript(d))]);
    expect(registry.get("script-v1")?.executorId).toBe("script-v1");
  });

  it("refuses a duplicate executor id", () => {
    const d = dir();
    const script = scriptFor(writeFakeScript(d));
    expect(() => ScriptRegistry.load([script, script])).toThrow(/duplicate executor/);
  });

  it("has no field in which a command string could be represented", () => {
    const d = dir();
    expect(() =>
      ScriptRegistry.load([{ ...scriptFor(writeFakeScript(d)), command: "sh -c ls" }]),
    ).toThrow();
    expect(() =>
      ScriptRegistry.load([{ ...scriptFor(writeFakeScript(d)), shell: true }]),
    ).toThrow();
  });
});

describe("identity verification", () => {
  it("accepts a script whose hash still matches", () => {
    const d = dir();
    const registry = ScriptRegistry.load([scriptFor(writeFakeScript(d))]);
    expect(registry.verifyIdentity(registry.get("script-v1")!)).toEqual({ ok: true });
  });

  // A script certified an hour ago and edited since is a different script.
  it("refuses a script that drifted since certification", () => {
    const d = dir();
    const path = writeFakeScript(d);
    const registry = ScriptRegistry.load([scriptFor(path)]);
    writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    const result = registry.verifyIdentity(registry.get("script-v1")!);
    expect(result).toMatchObject({ ok: false, reason: "script-drift" });
  });

  it("refuses a missing script", () => {
    const registry = ScriptRegistry.load([
      scriptFor(writeFakeScript(dir()), { path: "/nonexistent/repair.mjs" }),
    ]);
    expect(registry.verifyIdentity(registry.get("script-v1")!)).toMatchObject({
      ok: false,
      reason: "script-missing",
    });
  });

  it("refuses a script anyone can rewrite", () => {
    const d = dir();
    const path = writeFakeScript(d);
    const registry = ScriptRegistry.load([scriptFor(path)]);
    chmodSync(path, 0o777);
    expect(registry.verifyIdentity(registry.get("script-v1")!)).toMatchObject({
      ok: false,
      reason: "script-writable-by-others",
    });
  });

  it("refuses a script owned by an unexpected uid", () => {
    const d = dir();
    const path = writeFakeScript(d);
    const registry = ScriptRegistry.load([
      scriptFor(path, { expectedOwnerUid: (process.getuid?.() ?? 0) + 4242 }),
    ]);
    expect(registry.verifyIdentity(registry.get("script-v1")!)).toMatchObject({
      ok: false,
      reason: "script-owner-mismatch",
    });
  });

  it("refuses an unverifiable release assertion instead of treating it as identity", () => {
    const d = dir();
    const registry = ScriptRegistry.load([
      scriptFor(writeFakeScript(d), { identity: { kind: "release", value: "release-42" } }),
    ]);
    expect(registry.verifyIdentity(registry.get("script-v1")!)).toMatchObject({
      ok: false,
      reason: "release-identity-unverifiable",
    });
  });
});

describe("argv validation", () => {
  const registry = () => {
    const d = dir();
    return ScriptRegistry.load([scriptFor(writeFakeScript(d))]);
  };

  it("accepts argv matching the declared schema", () => {
    const r = registry();
    expect(() =>
      r.validateArgv(r.get("script-v1")!, ["--target-date", "2026-08-21"]),
    ).not.toThrow();
  });

  it.each([
    [["; rm", "anything"], /unexpected argument/],
    [["--target-date", "2026-08-21; rm -rf /"], /does not match its pattern/],
    [["--target-date", "$(whoami)"], /does not match its pattern/],
    [["--not-a-flag", "x"], /unexpected argument/],
    [["--target-date"], /has no value/],
    [[], /missing required/],
  ])("refuses %s", (argv, message) => {
    const r = registry();
    expect(() => r.validateArgv(r.get("script-v1")!, argv)).toThrow(message);
    expect(() => r.validateArgv(r.get("script-v1")!, argv)).toThrow(
      /argument schema/,
    );
  });

  it("refuses a repeated flag rather than letting the last one win", () => {
    const r = registry();
    expect(() =>
      r.validateArgv(r.get("script-v1")!, [
        "--target-date",
        "2026-08-21",
        "--target-date",
        "2026-08-22",
      ]),
    ).toThrow(/repeated argument/);
  });

  it("anchors the pattern, so a matching prefix is not enough", () => {
    const r = registry();
    expect(() =>
      r.validateArgv(r.get("script-v1")!, ["--target-date", "2026-08-21extra"]),
    ).toThrow(/does not match its pattern/);
  });
});
