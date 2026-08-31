import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OpsdRuntimeConfig } from "dsh-plugin-ops-agent";
import type { ShepherdRuntimeConfig } from "../config.js";
import { assertLivewireOpsBinding, composeLivewireOpsDaemon, parseLivewireOpsdArgs } from "./livewire-opsd.js";

const repairExecutor = {
  executorId: "livewire-repair-transaction",
  path: "/opt/livewire/bin/repair",
  identity: { kind: "sha256" as const, value: "a".repeat(64) },
  argvSchema: {
    id: "repair-v1",
    params: [{ flag: "--manifest", valuePattern: "/private/ready/sha256:[0-9a-f]{64}\\.json", required: true }],
  },
  cwd: "/opt/livewire",
  environmentProfile: { PATH: "/usr/bin:/bin" },
  timeoutMs: 60_000,
  maxOutputBytes: 1_000,
  expectedOwnerUid: 0,
};

const shepherd = {
  version: 1,
  stateRoot: "/private/shepherd",
  appendLockRoot: "/private/shepherd-locks",
  intervalMs: 60_000,
  providerRetryMs: 60_000,
  livewire: {
    executorId: "livewire-probe",
    changedPathRoots: ["/private/lake"],
    repair: {
      executorId: repairExecutor.executorId,
      postconditionExecutorId: "livewire-repair-postcondition",
      readyDir: "/private/ready",
      dataLakeRoots: ["/private/lake"],
    },
  },
  scripts: [
    { ...repairExecutor, executorId: "livewire-probe" },
    repairExecutor,
    { ...repairExecutor, executorId: "livewire-repair-postcondition" },
  ],
} satisfies ShepherdRuntimeConfig;

const manifestCap = {
  kind: "manifest-argv-v1",
  sopId: "livewire-shepherd-targeted-repair",
  componentId: "livewire",
  executorId: repairExecutor.executorId,
  postconditionIds: ["livewire-repair-integrity"],
  manifestRoot: shepherd.livewire.repair.readyDir,
  verificationExecutor: {
    executorId: "livewire-repair-postcondition",
    path: repairExecutor.path,
    identity: repairExecutor.identity,
    expectedOwnerUid: repairExecutor.expectedOwnerUid,
    argvSchema: repairExecutor.argvSchema,
  },
} satisfies Extract<NonNullable<OpsdRuntimeConfig["automaticAuthority"]>, {
  kind: "manifest-argv-v1";
}>;

const promotionBundleDir = mkdtempSync(join(tmpdir(), "livewire-opsd-binding-"));
const ops = {
  version: 1,
  mode: "auto",
  intervalMs: 60_000,
  automaticAuthority: manifestCap,
  promotionBundleDir,
} as OpsdRuntimeConfig;

writeFileSync(
  join(promotionBundleDir, "promotion-input.json"),
  `${JSON.stringify({ opsConfig: ops, shepherdConfig: shepherd })}\n`,
);

afterAll(() => rmSync(promotionBundleDir, { recursive: true, force: true }));

describe("livewire-opsd composition boundary", () => {
  it("accepts exactly two absolute config paths", () => {
    expect(parseLivewireOpsdArgs([
      "--ops-config", "/private/ops.json",
      "--shepherd-config", "/private/shepherd.yaml",
    ])).toEqual({
      command: "run",
      opsConfigPath: "/private/ops.json",
      shepherdConfigPath: "/private/shepherd.yaml",
    });
    expect(parseLivewireOpsdArgs([
      "check-config",
      "--ops-config", "/private/ops.json",
      "--shepherd-config", "/private/shepherd.yaml",
    ])).toMatchObject({ command: "check-config" });
    expect(() => parseLivewireOpsdArgs(["--ops-config", "relative"])).toThrow();
    expect(() => parseLivewireOpsdArgs([
      "--ops-config", "/private/ops.json",
      "--shepherd-config", "/private/shepherd.yaml",
      "--execute", "anything",
    ])).toThrow(/unknown/);
  });

  it("requires the Shepherd ready root and executor to equal the signed capability", () => {
    expect(() => assertLivewireOpsBinding(ops, shepherd)).not.toThrow();
    expect(() => assertLivewireOpsBinding({
      ...ops,
      automaticAuthority: { ...manifestCap, manifestRoot: "/private/other" },
    }, shepherd)).toThrow(/ready directory/);
    expect(() => assertLivewireOpsBinding({
      ...ops,
      automaticAuthority: { ...manifestCap, executorId: "other" },
    }, shepherd)).toThrow(/component\/executor/);
    expect(() => assertLivewireOpsBinding({ ...ops, mode: "approve" }, shepherd)).toThrow(/auto mode/);
  });

  it("refuses to use the mutation executor as the baseline verifier", () => {
    expect(() => assertLivewireOpsBinding({
      ...ops,
      automaticAuthority: {
        ...manifestCap,
        verificationExecutor: { ...manifestCap.verificationExecutor, executorId: repairExecutor.executorId },
      },
    }, {
      ...shepherd,
      livewire: {
        ...shepherd.livewire,
        repair: { ...shepherd.livewire.repair, postconditionExecutorId: repairExecutor.executorId },
      },
    })).toThrow(/postcondition executor/);
  });

  it("refuses a changed state root before creating any Shepherd storage", () => {
    const unsignedStateRoot = join(promotionBundleDir, "unsigned-state");
    expect(() => composeLivewireOpsDaemon(ops, {
      ...shepherd,
      stateRoot: unsignedStateRoot,
    })).toThrow(/signed promotion config/);
    expect(existsSync(unsignedStateRoot)).toBe(false);
  });
});
