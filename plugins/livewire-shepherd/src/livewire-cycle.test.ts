import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppendCoordination } from "./append-coordination.js";
import { ShepherdCoordinator } from "./coordinator.js";
import { ShepherdDaemon } from "./daemon.js";
import { ShepherdScheduler } from "./scheduler.js";
import { openShepherdStore } from "./store.js";
import { createWorkUnit } from "./work-unit.js";

const direct: AppendCoordination = { run: <T>(operation: () => T) => ({ acquired: true, value: operation() }) };
const now = "2026-08-31T01:00:00.000Z";

describe("Livewire source isolation", () => {
  it("keeps an IB user wait local and completes other ready units in the same cycle", async () => {
    const store = openShepherdStore(mkdtempSync(join(tmpdir(), "helium-livewire-cycle-")), { sync: () => {} });
    let ids = 0;
    const coordinator = new ShepherdCoordinator(store, direct, {
      ownerId: "cycle-test",
      now: () => now,
      id: (prefix) => `${prefix}-${++ids}`,
    });
    const ib = createWorkUnit({
      kind: "market-partition",
      provider: "ib",
      assetClass: "equity",
      marketDate: "2026-08-28",
      timeframe: "1d",
      layer: "bronze",
    });
    const massive = createWorkUnit({
      kind: "market-partition",
      provider: "massive",
      assetClass: "equity",
      marketDate: "2026-08-28",
      timeframe: "1m",
      layer: "bronze",
    });
    const calls: string[] = [];
    const daemon = new ShepherdDaemon({
      store,
      coordinator,
      scheduler: new ShepherdScheduler(),
      scanner: { scan: async () => [ib, massive] },
      bridge: {
        probe: async ({ workUnit }) => {
          calls.push(workUnit.workUnitId);
          return workUnit.workUnitId === ib.workUnitId
            ? { outcome: "temporary-unavailable", stateHint: "AWAITING_USER" }
            : { outcome: "completed", stateHint: "VERIFIED" };
        },
      },
      executorId: "livewire-probe",
      providerRetryMs: 300_000,
      now: () => new Date(now),
    });

    const result = await daemon.tickOnce();

    expect(calls).toEqual([ib.workUnitId, massive.workUnitId]);
    expect(result.failures).toEqual([]);
    expect(store.load().workUnits[ib.workUnitId]?.state).toBe("AWAITING_USER");
    expect(store.load().workUnits[massive.workUnitId]?.state).toBe("EVIDENCE_PENDING");
  });
});
