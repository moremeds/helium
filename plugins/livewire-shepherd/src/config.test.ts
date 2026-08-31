import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadShepherdRuntimeConfig, ShepherdRuntimeConfigSchema } from "./config.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-shepherd-config-"));
  const script = join(root, "probe");
  writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(script, 0o700);
  const repair = join(root, "repair");
  writeFileSync(repair, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(repair, 0o700);
  const postcondition = join(root, "postcondition");
  writeFileSync(postcondition, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(postcondition, 0o700);
  return {
    version: 1 as const,
    stateRoot: join(root, "state"),
    appendLockRoot: join(root, "locks"),
    intervalMs: 60_000,
    providerRetryMs: 300_000,
    livewire: {
      executorId: "livewire-probe",
      changedPathRoots: [join(root, "data")],
      repair: {
        executorId: "livewire-repair-transaction",
        postconditionExecutorId: "livewire-repair-postcondition",
        readyDir: join(root, "ready"),
        dataLakeRoots: [join(root, "data")],
      },
    },
    scripts: [{
      executorId: "livewire-probe",
      path: script,
      identity: { kind: "sha256" as const, value: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex") },
      argvSchema: { id: "probe-v1", params: [] },
      cwd: root,
      environmentProfile: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }, {
      executorId: "livewire-repair-transaction",
      path: repair,
      identity: { kind: "sha256" as const, value: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex") },
      argvSchema: { id: "repair-v1", params: [{ flag: "--manifest", valuePattern: ".+", required: true }] },
      cwd: root,
      environmentProfile: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }, {
      executorId: "livewire-repair-postcondition",
      path: postcondition,
      identity: { kind: "sha256" as const, value: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex") },
      argvSchema: { id: "postcondition-v1", params: [{ flag: "--manifest", valuePattern: ".+", required: true }] },
      cwd: root,
      environmentProfile: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }],
  };
}

describe("ShepherdRuntimeConfig", () => {
  it("accepts only absolute owner-controlled runtime paths and a registered probe", () => {
    expect(ShepherdRuntimeConfigSchema.parse(fixture()).livewire.executorId).toBe("livewire-probe");
    expect(() => ShepherdRuntimeConfigSchema.parse({ ...fixture(), stateRoot: "relative" })).toThrow();
    expect(() => ShepherdRuntimeConfigSchema.parse({ ...fixture(), extra: true })).toThrow();
  });

  it("rejects a transaction executor wired as its own postcondition verifier", () => {
    const config = fixture();
    expect(() => ShepherdRuntimeConfigSchema.parse({
      ...config,
      livewire: {
        ...config.livewire,
        repair: {
          ...config.livewire.repair,
          postconditionExecutorId: config.livewire.repair.executorId,
        },
      },
    })).toThrow(/distinct/);
  });

  it("loads one strict YAML document without sourcing an env file", () => {
    const config = fixture();
    const path = join(mkdtempSync(join(tmpdir(), "helium-shepherd-yaml-")), "config.yaml");
    writeFileSync(path, [
      "version: 1",
      `stateRoot: ${config.stateRoot}`,
      `appendLockRoot: ${config.appendLockRoot}`,
      "intervalMs: 60000",
      "providerRetryMs: 300000",
      "livewire:",
      "  executorId: livewire-probe",
      `  changedPathRoots: [${config.livewire.changedPathRoots[0]}]`,
      "  repair:",
      "    executorId: livewire-repair-transaction",
      "    postconditionExecutorId: livewire-repair-postcondition",
      `    readyDir: ${config.livewire.repair.readyDir}`,
      `    dataLakeRoots: [${config.livewire.repair.dataLakeRoots[0]}]`,
      "scripts:",
      "  - executorId: livewire-probe",
      `    path: ${config.scripts[0]?.path}`,
      "    identity:",
      "      kind: sha256",
      `      value: ${config.scripts[0]?.identity.value}`,
      "    argvSchema: { id: probe-v1, params: [] }",
      `    cwd: ${config.scripts[0]?.cwd}`,
      "    environmentProfile: {}",
      "    timeoutMs: 5000",
      "    maxOutputBytes: 100000",
      `    expectedOwnerUid: ${config.scripts[0]?.expectedOwnerUid}`,
      "  - executorId: livewire-repair-transaction",
      `    path: ${config.scripts[1]?.path}`,
      "    identity:",
      "      kind: sha256",
      `      value: ${config.scripts[1]?.identity.value}`,
      "    argvSchema: { id: repair-v1, params: [{ flag: --manifest, valuePattern: '.+', required: true }] }",
      `    cwd: ${config.scripts[1]?.cwd}`,
      "    environmentProfile: {}",
      "    timeoutMs: 5000",
      "    maxOutputBytes: 100000",
      `    expectedOwnerUid: ${config.scripts[1]?.expectedOwnerUid}`,
      "  - executorId: livewire-repair-postcondition",
      `    path: ${config.scripts[2]?.path}`,
      "    identity:",
      "      kind: sha256",
      `      value: ${config.scripts[2]?.identity.value}`,
      "    argvSchema: { id: postcondition-v1, params: [{ flag: --manifest, valuePattern: '.+', required: true }] }",
      `    cwd: ${config.scripts[2]?.cwd}`,
      "    environmentProfile: {}",
      "    timeoutMs: 5000",
      "    maxOutputBytes: 100000",
      `    expectedOwnerUid: ${config.scripts[2]?.expectedOwnerUid}`,
    ].join("\n"));
    expect(loadShepherdRuntimeConfig(path).stateRoot).toBe(config.stateRoot);
    expect(() => loadShepherdRuntimeConfig("relative.yaml")).toThrow(/absolute/i);
  });
});
