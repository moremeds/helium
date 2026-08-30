import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckDefinitionSchema,
  type CheckDefinition,
  type Observation,
} from "@helium/core";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { ObservationProbe } from "./collector.js";
import {
  ProductionCheckRuntime,
  createProductionCheckRuntime,
} from "./production-checks.js";
import type { CommandRunner } from "./probes/process.js";

const NOW = new Date("2026-08-30T03:00:00.000Z");
const EVIDENCE = "artifact://ops/raw/check-fixture.json";

const runner: CommandRunner = {
  async run() {
    throw new Error("fake source should not call the command runner");
  },
};

function check(
  id: string,
  probeId: string,
  dimension: string,
  value: string | number | boolean,
  operator: "eq" | "gte" = "eq",
): CheckDefinition {
  return CheckDefinitionSchema.parse({
    id,
    kind: "business",
    probe: { probeId, args: {} },
    expect: { dimension, operator, value },
    onUnavailable: "unknown",
    timeoutMs: 10_000,
    owner: "ops",
  });
}

function observation(
  probeId: string,
  state: Observation["state"],
  dimension: string,
  value: Record<string, unknown>,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    version: 1,
    id: `obs-${probeId}`,
    componentId: probeId.startsWith("host.") ? "host" : probeId.split(".")[0]!,
    probeId,
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    state,
    dimension,
    value,
    evidenceRefs: [EVIDENCE],
    parserVersion: "fixture/1",
    ...overrides,
  };
}

function source(rows: readonly Observation[], outputProbeIds = rows.map((row) => row.probeId)) {
  const observe = vi.fn(async () => rows);
  const probe: ObservationProbe = { probeId: "fixture.snapshot.v1", observe };
  return { source: { probe, outputProbeIds }, observe };
}

describe("ProductionCheckRuntime", () => {
  it("runs one fresh snapshot and projects exact scalar business readings", async () => {
    const fixture = source([
      observation("colima.container-inventory.v1", "failed", "readiness", { missing: ["trading-cadvisor"] }),
      observation("colima.guest-runtime.v1", "ok", "readiness", { ready: true }),
      observation("colima.vm-state.v1", "ok", "liveness", { vmState: "running" }),
      observation("host.volume.data-lake.v1", "ok", "volume-data-lake", { identity: { ok: true } }),
      observation("livewire.status-parser.v1", "failed", "freshness", { found: true, intradayCoverage: 0.0001 }),
      observation("livewire.parquet-integrity.v1", "ok", "integrity", { valid: true }),
      observation("livewire.coverage-freshness.v1", "ok", "freshness", {}),
    ]);
    const runtime = new ProductionCheckRuntime([fixture.source]);
    const checks = [
      check("container-set", "colima.container-inventory.v1", "expected-set", true),
      check("transport", "colima.guest-runtime.v1", "readiness", true),
      check("vm", "colima.vm-state.v1", "readiness", true),
      check("mount", "host.volume.data-lake.v1", "mount-identity", true),
      check("input", "livewire.status-parser.v1", "source-available", true),
      check("coverage", "livewire.status-parser.v1", "coverage", 1, "gte"),
      check("integrity", "livewire.parquet-integrity.v1", "integrity", true),
      check("freshness", "livewire.coverage-freshness.v1", "target-freshness", true),
    ];

    const samples = await runtime.sample(checks, "baseline", runner, NOW);

    expect(fixture.observe).toHaveBeenCalledTimes(1);
    expect(samples.map(({ checkId, state }) => ({ checkId, state }))).toEqual([
      { checkId: "container-set", state: "fail" },
      { checkId: "transport", state: "pass" },
      { checkId: "vm", state: "pass" },
      { checkId: "mount", state: "pass" },
      { checkId: "input", state: "pass" },
      { checkId: "coverage", state: "fail" },
      { checkId: "integrity", state: "pass" },
      { checkId: "freshness", state: "pass" },
    ]);
    expect(samples.every((sample) => sample.observedAt === NOW.toISOString())).toBe(true);
    expect(samples.every((sample) => sample.evidenceRefs.includes(EVIDENCE))).toBe(true);
  });

  it("never passes unknown, expired, or mismatched observations", async () => {
    const fixture = source([
      observation("colima.guest-runtime.v1", "unknown", "readiness", { ready: true }),
      observation("colima.vm-state.v1", "ok", "liveness", { vmState: "running" }, {
        observedAt: new Date(NOW.getTime() - 120_000).toISOString(),
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      }),
      observation("host.volume.data-lake.v1", "ok", "volume-data-lake", { identity: { ok: true } }),
      observation("colima.container-inventory.v1", "failed", "readiness", {}),
    ]);
    const runtime = new ProductionCheckRuntime([fixture.source]);

    const samples = await runtime.sample([
      check("unknown", "colima.guest-runtime.v1", "readiness", true),
      check("expired", "colima.vm-state.v1", "readiness", true),
      check("mismatch", "host.volume.data-lake.v1", "wrong-dimension", true),
      check("missing-payload", "colima.container-inventory.v1", "expected-set", true),
    ], "postcondition", runner, NOW);

    expect(samples.map((sample) => sample.state)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });

  it("rejects missing output, duplicate registration, empty evidence, and probe failure", async () => {
    expect(() => new ProductionCheckRuntime([
      source([], ["colima.guest-runtime.v1"]).source,
      source([], ["colima.guest-runtime.v1"]).source,
    ])).toThrow(/duplicate runtime check probe/);

    await expect(new ProductionCheckRuntime([
      source([], ["colima.guest-runtime.v1"]).source,
    ]).sample([
      check("missing", "colima.guest-runtime.v1", "readiness", true),
    ], "baseline", runner, NOW)).rejects.toThrow(/did not emit/);

    const noEvidence = source([
      observation("colima.guest-runtime.v1", "ok", "readiness", { ready: true }, { evidenceRefs: [] }),
    ]);
    await expect(new ProductionCheckRuntime([noEvidence.source]).sample([
      check("no-evidence", "colima.guest-runtime.v1", "readiness", true),
    ], "baseline", runner, NOW)).rejects.toThrow(/evidence/i);

    const failing: ObservationProbe = {
      probeId: "failed.snapshot.v1",
      async observe() {
        throw new Error("parser drift");
      },
    };
    await expect(new ProductionCheckRuntime([{
      probe: failing,
      outputProbeIds: ["colima.guest-runtime.v1"],
    }]).sample([
      check("failed", "colima.guest-runtime.v1", "readiness", true),
    ], "baseline", runner, NOW)).rejects.toThrow(/parser drift/);

    const injecting = source([
      observation("colima.guest-runtime.v1", "ok", "readiness", { ready: true }),
      observation("colima.vm-state.v1", "ok", "liveness", { vmState: "running" }),
    ], ["colima.guest-runtime.v1"]);
    const missingVm = source([], ["colima.vm-state.v1"]);
    await expect(new ProductionCheckRuntime([
      injecting.source,
      missingVm.source,
    ]).sample([
      check("guest", "colima.guest-runtime.v1", "readiness", true),
      check("vm", "colima.vm-state.v1", "readiness", true),
    ], "baseline", runner, NOW)).rejects.toThrow(/did not emit: colima.vm-state.v1/);
  });

  it("exports exactly the probe ids implemented by the production runtime", () => {
    const targets = parse(readFileSync(join(process.cwd(), "ops/observation-targets.yaml"), "utf8"));
    const runtime = createProductionCheckRuntime(targets, {
      releaseDir: process.cwd(),
      nodePath: process.execPath,
    });
    const configuredChecks = [
      "colima.container-inventory.v1",
      "colima.guest-runtime.v1",
      "colima.vm-state.v1",
      "host.volume.data-lake.v1",
      "livewire.status-parser.v1",
      "livewire.parquet-integrity.v1",
      "livewire.coverage-freshness.v1",
    ];

    expect(runtime.probeIds()).toEqual(configuredChecks.sort());
  });
});
