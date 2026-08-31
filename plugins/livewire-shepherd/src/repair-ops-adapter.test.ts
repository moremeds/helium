import type { Incident } from "@helium/core/operations/incident.js";
import type { SopDefinition } from "@helium/core/operations/sop.js";
import { describe, expect, it } from "vitest";
import type { WorkUnitProjection } from "./reducer.js";
import { ShepherdRepairOpsAdapter } from "./repair-ops-adapter.js";
import type { ShepherdPreparedRepair } from "./repair-controller.js";
import { createWorkUnit } from "./work-unit.js";

const NOW = new Date("2026-08-31T22:00:00.000Z");
const sop = {
  id: "livewire-shepherd-targeted-repair",
  postconditions: ["livewire-repair-verified"],
  graceMs: 0,
  action: { timeoutMs: 60_000 },
} as SopDefinition;
const signedPolicy = {
  postconditions: [{
    id: "livewire-repair-verified",
    kind: "business" as const,
    probe: { probeId: "livewire.repair-postcondition.v1", args: {} },
    expect: { dimension: "repair", operator: "eq" as const, value: true },
    onUnavailable: "unknown" as const,
    timeoutMs: 60_000,
    owner: "ops",
  }],
  graceMs: 0,
};

function projection(symbol: string, state: WorkUnitProjection["state"] = "REPAIR_READY"): WorkUnitProjection {
  const unit = createWorkUnit({
    kind: "security-interval",
    securityId: `sec_${symbol.toLowerCase().padEnd(32, "0")}`,
    symbol,
    symbolValidFrom: "2000-01-01T00:00:00Z",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    layer: "bronze",
  });
  return {
    unit,
    discoveredAt: NOW.toISOString(),
    state,
    revision: 1,
    evidence: {},
    claims: {},
    attempts: {},
    verificationPassed: false,
    repairVerificationPassed: false,
    coverage: {},
  };
}

function prepared(row: WorkUnitProjection): ShepherdPreparedRepair {
  const scopeHash = row.unit.scopeHash as `sha256:${string}`;
  const sha256 = row.unit.scopeHash.slice("sha256:".length);
  return {
    scopeId: `${row.unit.workUnitId}:${row.unit.scopeHash}`,
    manifest: {
      path: `/private/ready/${row.unit.scopeHash}.json`,
      hash: scopeHash,
      evidence: { ref: `artifact://sha256/${sha256}`, hash: scopeHash },
    },
    argv: ["--manifest", `/private/ready/${row.unit.scopeHash}.json`],
    inputArtifacts: [{ ref: `artifact://sha256/${sha256}`, sha256 }],
    preSpawn: () => undefined,
  };
}

describe("ShepherdRepairOpsAdapter", () => {
  it("emits one scoped failed observation per valid REPAIR_READY unit and prepares it again for Ops", async () => {
    const aapl = projection("AAPL");
    const msft = projection("MSFT");
    const ignored = projection("NVDA", "VERIFIED");
    const calls: string[] = [];
    const adapter = new ShepherdRepairOpsAdapter({
      store: { load: () => ({
        workUnits: Object.fromEntries([aapl, msft, ignored].map((row) => [row.unit.workUnitId, row])),
        eventIds: [],
        cycles: [],
      }) },
      preparer: {
        prepare(row) {
          calls.push(row.unit.workUnitId);
          return prepared(row);
        },
      },
      componentId: "livewire",
      sopId: sop.id,
      ttlMs: 60_000,
    });

    const observations = await adapter.observe({ run: async () => { throw new Error("unused"); } }, NOW);

    expect(observations).toHaveLength(2);
    expect(observations.map((row) => row.state)).toEqual(["failed", "failed"]);
    expect(observations.map((row) => row.scopeId)).toEqual(
      [aapl, msft].sort((left, right) => left.unit.workUnitId.localeCompare(right.unit.workUnitId))
        .map((row) => `${row.unit.workUnitId}:${row.unit.scopeHash}`),
    );
    const target = observations[0]!;
    const action = adapter.prepareAction(sop, {
      scopeId: target.scopeId,
    } as Incident, signedPolicy);
    expect(action.argv).toEqual(["--manifest", expect.stringMatching(/sha256:.*\.json$/)]);
    expect(action.inputArtifacts).toHaveLength(1);
    expect(action.verificationPolicy).toMatchObject({
      postconditions: [{
        id: "livewire-repair-verified",
        probe: {
          probeId: "livewire.repair-postcondition.v1",
          args: { manifest: action.manifest.path },
        },
      }],
    });
    expect(calls.filter((id) => target.scopeId?.startsWith(`${id}:`))).toHaveLength(2);
  });

  it("keeps one invalid ready manifest local as unknown while another remains actionable", async () => {
    const invalid = projection("AAPL");
    const valid = projection("MSFT");
    const adapter = new ShepherdRepairOpsAdapter({
      store: { load: () => ({
        workUnits: { [invalid.unit.workUnitId]: invalid, [valid.unit.workUnitId]: valid },
        eventIds: [],
        cycles: [],
      }) },
      preparer: {
        prepare(row) {
          if (row.unit.workUnitId === invalid.unit.workUnitId) throw new Error("manifest changed");
          return prepared(row);
        },
      },
      componentId: "livewire",
      sopId: sop.id,
      ttlMs: 60_000,
    });

    const observations = await adapter.observe({ run: async () => { throw new Error("unused"); } }, NOW);

    expect(observations.map((row) => row.state).sort()).toEqual(["failed", "unknown"]);
    expect(observations.find((row) => row.state === "unknown")?.value).toMatchObject({
      preparation: "refused",
      reason: "manifest changed",
    });
  });

  it("refuses an unregistered SOP or a scope absent from the current durable projection", () => {
    const row = projection("AAPL");
    const adapter = new ShepherdRepairOpsAdapter({
      store: { load: () => ({ workUnits: { [row.unit.workUnitId]: row }, eventIds: [], cycles: [] }) },
      preparer: { prepare: prepared },
      componentId: "livewire",
      sopId: sop.id,
      ttlMs: 60_000,
    });
    const incident = { scopeId: "lws-missing:sha256:missing" } as Incident;

    expect(() => adapter.prepareAction({ ...sop, id: "other" }, incident, signedPolicy)).toThrow(/SOP/);
    expect(() => adapter.prepareAction(sop, incident, signedPolicy)).toThrow(/scope/);
  });

  it("rechecks the exact durable scope at the final pre-spawn boundary", () => {
    const row = projection("AAPL");
    let current = row;
    let innerGateCalls = 0;
    const adapter = new ShepherdRepairOpsAdapter({
      store: { load: () => ({ workUnits: { [row.unit.workUnitId]: current }, eventIds: [], cycles: [] }) },
      preparer: {
        prepare(candidate) {
          return { ...prepared(candidate), preSpawn: () => { innerGateCalls += 1; } };
        },
      },
      componentId: "livewire",
      sopId: sop.id,
      ttlMs: 60_000,
    });
    const action = adapter.prepareAction(
      sop,
      { scopeId: `${row.unit.workUnitId}:${row.unit.scopeHash}` } as Incident,
      signedPolicy,
    );
    current = { ...row, revision: row.revision + 1, state: "QUARANTINED" };

    expect(() => action.preSpawn()).toThrow(/advanced before spawn/);
    expect(innerGateCalls).toBe(0);
  });
});
