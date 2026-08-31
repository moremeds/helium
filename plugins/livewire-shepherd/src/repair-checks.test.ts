import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckDefinition } from "@helium/core/operations/check.js";
import { ScriptRegistry, type CommandRunner } from "dsh-plugin-ops-agent";
import { describe, expect, it } from "vitest";
import { LivewireRepairCheckSampler } from "./repair-checks.js";

const NOW = new Date("2026-08-31T22:00:00.000Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-livewire-repair-check-"));
  const path = join(root, "postcondition");
  const body = "#!/bin/sh\nexit 0\n";
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
  const registry = ScriptRegistry.load([{
    executorId: "livewire-repair-postcondition",
    path,
    identity: { kind: "sha256", value: createHash("sha256").update(body).digest("hex") },
    argvSchema: {
      id: "livewire-repair-postcondition-v1",
      params: [{
        flag: "--manifest",
        valuePattern: "/private/ready/sha256:[0-9a-f]{64}\\.json",
        required: true,
      }],
    },
    cwd: root,
    environmentProfile: {},
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
    expectedOwnerUid: process.getuid?.() ?? 0,
  }]);
  return {
    root,
    path,
    sampler: new LivewireRepairCheckSampler({
      registry,
      executorId: "livewire-repair-postcondition",
    }),
  };
}

const check = {
  id: "livewire-repair-verified",
  kind: "business",
  probe: {
    probeId: "livewire.repair-postcondition.v1",
    args: { manifest: `/private/ready/sha256:${"a".repeat(64)}.json` },
  },
  expect: { dimension: "repair", operator: "eq", value: true },
  onUnavailable: "unknown",
  timeoutMs: 60_000,
  owner: "ops",
} satisfies CheckDefinition;

function runner(result: { stdout: string; exitCode: number; timedOut?: boolean }): CommandRunner {
  return {
    async run(argv) {
      expect(argv.slice(1)).toEqual(["--manifest", check.probe.args.manifest]);
      return {
        stdout: result.stdout,
        exitCode: result.exitCode,
        timedOut: result.timedOut ?? false,
        evidenceRef: "artifact://ops/raw/livewire-postcondition.json",
      };
    },
  };
}

describe("LivewireRepairCheckSampler", () => {
  it("maps the exact terminal postcondition result to pass and pre-action absence to fail", async () => {
    const h = fixture();
    const passed = await h.sampler.sample(
      [check],
      "postcondition",
      runner({ stdout: '{"state":"VERIFIED"}\n', exitCode: 0 }),
      NOW,
    );
    const baseline = await h.sampler.sample(
      [check],
      "baseline",
      runner({ stdout: '{"state":"NOT_VERIFIED"}\n', exitCode: 1 }),
      NOW,
    );

    expect(passed).toEqual([expect.objectContaining({ state: "pass" })]);
    expect(baseline).toEqual([expect.objectContaining({ state: "fail" })]);
    expect(passed?.[0]?.evidenceRefs).toEqual(["artifact://ops/raw/livewire-postcondition.json"]);
  });

  it("returns unknown for timeout or malformed evidence and delegates unrelated checks", async () => {
    const h = fixture();
    expect((await h.sampler.sample(
      [check],
      "postcondition",
      runner({ stdout: "not-json", exitCode: 1, timedOut: true }),
      NOW,
    ))?.[0]?.state).toBe("unknown");
    expect(await h.sampler.sample(
      [{ ...check, probe: { probeId: "fixture.other.v1", args: {} } }],
      "baseline",
      runner({ stdout: "", exitCode: 1 }),
      NOW,
    )).toBeUndefined();
  });

  it("rechecks the registered wrapper identity before every sample", async () => {
    const h = fixture();
    writeFileSync(h.path, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(h.sampler.sample(
      [check],
      "postcondition",
      runner({ stdout: '{"state":"VERIFIED"}', exitCode: 0 }),
      NOW,
    )).rejects.toThrow(/script-drift/);
  });
});
