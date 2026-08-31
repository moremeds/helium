import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAppendCoordination } from "./append-coordination.js";
import { ShepherdRepairOutcomeProjector } from "./repair-outcomes.js";
import { repairScopeId } from "./repair-ops-adapter.js";
import { openShepherdStore } from "./store.js";
import { createWorkUnit } from "./work-unit.js";

const NOW = "2026-08-31T22:00:00.000Z";
const RECOVERY_BYTES = Buffer.from('{"schema":"fixture-recovery"}');
const RECOVERY_SHA = createHash("sha256").update(RECOVERY_BYTES).digest("hex");

function fixture(failpoint?: (point: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "helium-livewire-outcomes-"));
  const store = openShepherdStore(join(root, "state"));
  const unit = createWorkUnit({
    kind: "security-interval",
    securityId: "sec_00000000000000000000000000000001",
    symbol: "AAPL",
    symbolValidFrom: "2000-01-01T00:00:00Z",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    layer: "bronze",
  });
  store.append({
    version: 1, eventId: "discover", at: NOW, type: "work-unit/discovered", payload: { unit },
  });
  store.append({
    version: 1, eventId: "ready", at: NOW, type: "work-unit/transitioned",
    payload: {
      workUnitId: unit.workUnitId, expectedRevision: 0, revision: 1,
      from: "DISCOVERED", to: "REPAIR_READY", reason: "fixture",
    },
  });
  let id = 0;
  const projector = new ShepherdRepairOutcomeProjector({
    store,
    componentId: "livewire",
    sopId: "livewire-shepherd-targeted-repair",
    readRecoveryEvidence: () => RECOVERY_BYTES,
    coordination: new FileAppendCoordination({
      directory: join(root, "locks"),
      bootId: "boot-test",
    }),
    now: () => NOW,
    id: (prefix) => `${prefix}-${++id}`,
    ...(failpoint === undefined ? {} : { failpoint }),
  });
  return { root, store, unit, projector };
}

function operations(scopeId: string, outcome: string, overrides: Record<string, unknown> = {}) {
  return {
    state: () => ({
      actions: {
        "act-livewire-1": {
          actionId: "act-livewire-1",
          componentId: "livewire",
          sopId: "livewire-shepherd-targeted-repair",
          scopeId,
          state: outcome,
          recoveryEvidence: {
            ref: "artifact://ops/recovery/act-livewire-1.json",
            sha256: RECOVERY_SHA,
          },
          ...overrides,
        },
      },
    }),
  };
}

describe("ShepherdRepairOutcomeProjector", () => {
  it("projects a successful Ops terminal receipt to VERIFIED exactly once", () => {
    const h = fixture();
    const durable = operations(repairScopeId(h.store.load().workUnits[h.unit.workUnitId]!), "succeeded");

    h.projector.recordOperations(durable);
    h.projector.recordOperations(durable);

    expect(h.store.load().workUnits[h.unit.workUnitId]?.state).toBe("VERIFIED");
    expect(h.store.events().filter((event) => event.type === "repair/receipt-recorded")).toHaveLength(1);
    expect(h.store.events().filter((event) => event.type === "repair/verification-recorded")).toHaveLength(1);
  });

  it("projects failed, uncertain, or external recovery to QUARANTINED, never VERIFIED", () => {
    for (const outcome of ["failed", "uncertain", "external-recovery"]) {
      const h = fixture();
      h.projector.recordOperations(operations(
        repairScopeId(h.store.load().workUnits[h.unit.workUnitId]!),
        outcome,
      ));
      expect(h.store.load().workUnits[h.unit.workUnitId]?.state).toBe("QUARANTINED");
      expect(h.store.load().workUnits[h.unit.workUnitId]?.repairVerificationPassed).toBe(false);
    }
  });

  it("resumes after a crash immediately after the durable Ops receipt handoff", () => {
    let crashed = false;
    const h = fixture((point) => {
      if (point === "after-receipt" && !crashed) {
        crashed = true;
        throw new Error("crash after receipt");
      }
    });
    const durable = operations(repairScopeId(h.store.load().workUnits[h.unit.workUnitId]!), "succeeded");
    expect(() => h.projector.recordOperations(durable)).toThrow(/crash/);
    expect(h.store.load().workUnits[h.unit.workUnitId]?.state).toBe("REPAIR_READY");

    const resumed = new ShepherdRepairOutcomeProjector({
      store: h.store,
      coordination: new FileAppendCoordination({
        directory: join(h.root, "locks"), bootId: "boot-test",
      }),
      componentId: "livewire",
      sopId: "livewire-shepherd-targeted-repair",
      readRecoveryEvidence: () => RECOVERY_BYTES,
      now: () => NOW,
    });
    resumed.reconcile();

    expect(h.store.load().workUnits[h.unit.workUnitId]?.state).toBe("VERIFIED");
  });

  it("ignores terminal actions without the exact SOP/component and durable recovery evidence", () => {
    const h = fixture();
    const scope = repairScopeId(h.store.load().workUnits[h.unit.workUnitId]!);
    h.projector.recordOperations(operations(scope, "succeeded", { componentId: "other" }));
    h.projector.recordOperations(operations(scope, "succeeded", { sopId: "other" }));
    h.projector.recordOperations(operations(scope, "succeeded", { recoveryEvidence: undefined }));
    expect(h.store.load().workUnits[h.unit.workUnitId]?.state).toBe("REPAIR_READY");
  });
});
