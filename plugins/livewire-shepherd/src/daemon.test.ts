import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppendCoordination } from "./append-coordination.js";
import { ShepherdCoordinator } from "./coordinator.js";
import { ShepherdDaemon, type LivewireProbePort } from "./daemon.js";
import { ShepherdScheduler } from "./scheduler.js";
import { openShepherdStore } from "./store.js";
import { createWorkUnit } from "./work-unit.js";

const direct: AppendCoordination = { run: <T>(operation: () => T) => ({ acquired: true, value: operation() }) };
const now = "2026-08-31T01:00:00.000Z";

describe("ShepherdDaemon", () => {
  it("serializes ticks, keeps local waits local, tolerates analysis failure, and records cycles", async () => {
    const store = openShepherdStore(mkdtempSync(join(tmpdir(), "helium-shepherdd-")), { sync: () => {} });
    let ids = 0;
    const coordinator = new ShepherdCoordinator(store, direct, {
      ownerId: "shepherdd-test",
      now: () => now,
      id: (prefix) => `${prefix}-${++ids}`,
    });
    const massive = createWorkUnit({ kind: "market-partition", provider: "massive", assetClass: "equity", marketDate: "2026-08-28", timeframe: "1m", layer: "bronze" });
    const ib = createWorkUnit({ kind: "market-partition", provider: "ib", assetClass: "equity", marketDate: "2026-08-28", timeframe: "1m", layer: "bronze" });
    let calls = 0;
    let analysisCalls = 0;
    const bridge: LivewireProbePort = {
      probe: async ({ workUnit }) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return workUnit.workUnitId === ib.workUnitId
          ? { outcome: "temporary-unavailable", stateHint: "AWAITING_USER" }
          : { outcome: "completed", stateHint: "VERIFIED" };
      },
    };
    const daemon = new ShepherdDaemon({
      store,
      coordinator,
      scheduler: new ShepherdScheduler(),
      scanner: { scan: async () => [massive, ib] },
      bridge,
      executorId: "livewire-probe",
      providerRetryMs: 300_000,
      now: () => new Date(now),
      analysis: { publish: async () => { analysisCalls += 1; throw new Error("provider down"); } },
    });
    const [first, same] = await Promise.all([daemon.tickOnce(), daemon.tickOnce()]);
    expect(same.cycleId).toBe(first.cycleId);
    expect(calls).toBe(2);
    expect(store.load().workUnits[massive.workUnitId]?.state).toBe("EVIDENCE_PENDING");
    expect(store.load().workUnits[ib.workUnitId]?.state).toBe("AWAITING_USER");
    expect(store.events().filter((event) => event.type === "cycle/recorded")).toHaveLength(1);
    await daemon.tickOnce();
    expect(analysisCalls).toBe(1);
  });

  it("hands repair decisions to the mutation seam without executing the read-only bridge", async () => {
    const store = openShepherdStore(mkdtempSync(join(tmpdir(), "helium-shepherdd-mutation-")), { sync: () => {} });
    const unit = createWorkUnit({ kind: "market-partition", provider: "massive", assetClass: "equity", marketDate: "2026-08-28", timeframe: "1m", layer: "bronze" });
    store.append({ version: 1, eventId: "discover", at: now, type: "work-unit/discovered", payload: { unit } });
    store.append({ version: 1, eventId: "repair", at: now, type: "work-unit/transitioned", payload: { workUnitId: unit.workUnitId, expectedRevision: 0, revision: 1, from: "DISCOVERED", to: "REPAIR_READY", reason: "fixture" } });
    let bridgeCalls = 0;
    const coordinator = new ShepherdCoordinator(store, direct, { ownerId: "test", now: () => now });
    const result = await new ShepherdDaemon({
      store,
      coordinator,
      scheduler: new ShepherdScheduler(),
      scanner: { scan: async () => [] },
      bridge: { probe: async () => { bridgeCalls += 1; return { outcome: "completed", stateHint: "VERIFIED" }; } },
      executorId: "livewire-probe",
      providerRetryMs: 300_000,
      now: () => new Date(now),
    }).tickOnce();
    expect(bridgeCalls).toBe(0);
    expect(result.mutationHandoffs).toEqual([unit.workUnitId]);
  });
});
