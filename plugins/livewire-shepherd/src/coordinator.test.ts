import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AppendCoordination } from "./append-coordination.js";
import { ShepherdCoordinator } from "./coordinator.js";
import { openShepherdStore } from "./store.js";
import { createWorkUnit } from "./work-unit.js";

const noSync = () => {};
const now = "2026-08-31T01:00:00.000Z";
const direct: AppendCoordination = {
  run: <T>(operation: () => T) => ({ acquired: true as const, value: operation() }),
};

function setup() {
  const store = openShepherdStore(mkdtempSync(join(tmpdir(), "helium-shepherd-coordinator-")), { sync: noSync });
  const unit = createWorkUnit({
    kind: "market-partition",
    provider: "massive",
    assetClass: "equity",
    marketDate: "2026-08-28",
    timeframe: "1m",
    layer: "bronze",
  });
  store.append({ version: 1, eventId: "discover", at: now, type: "work-unit/discovered", payload: { unit } });
  let id = 0;
  const coordinator = new ShepherdCoordinator(store, direct, {
    ownerId: "shepherdd-test",
    now: () => now,
    id: (prefix) => `${prefix}-${++id}`,
  });
  return { store, unit, coordinator };
}

describe("ShepherdCoordinator", () => {
  it("records one durable lease before execution intent", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z");
    expect(leased.acquired).toBe(true);
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "probe");

    const projection = store.load().workUnits[unit.workUnitId];
    expect(projection?.activeLease).toMatchObject({
      attemptId: leased.lease.attemptId,
      state: "intent-recorded",
      operation: "probe",
    });
    expect(coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z"))
      .toMatchObject({ acquired: false, reason: "active-lease" });
  });

  it("closes quota attempts, releases capacity, and schedules one provider wakeup", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z");
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "analysis");
    coordinator.recordOutcome(leased.lease, {
      outcome: "quota-exhausted",
      availabilityDomain: "codex-subscription-session",
      retryAt: "2026-08-31T02:00:00.000Z",
    });

    const projection = store.load().workUnits[unit.workUnitId];
    expect(projection?.activeLease).toBeUndefined();
    expect(projection?.state).toBe("AWAITING_PROVIDER");
    expect(projection?.retry).toMatchObject({
      domain: "codex-subscription-session",
      wakeAt: "2026-08-31T02:00:00.000Z",
    });
    expect(store.events().filter((event) => event.type === "work-unit/retry-scheduled"))
      .toHaveLength(1);
  });

  it("persists an IB user wait locally without blocking other work", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z");
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "probe");
    coordinator.recordOutcome(leased.lease, { outcome: "awaiting-user" });
    const projection = store.load().workUnits[unit.workUnitId];
    expect(projection?.state).toBe("AWAITING_USER");
    expect(projection?.activeLease).toBeUndefined();
  });

  it("advances a completed attempt atomically so it is not leased again", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z");
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "probe");
    coordinator.recordOutcome(leased.lease, {
      outcome: "completed",
      nextState: "EVIDENCE_PENDING",
    });
    expect(store.load().workUnits[unit.workUnitId]?.state).toBe("EVIDENCE_PENDING");
  });

  it("reconciles an expired read-only attempt once after cold restart", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:00:01.000Z");
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "probe");

    const restarted = new ShepherdCoordinator(store, direct, {
      ownerId: "shepherdd-restarted",
      now: () => "2026-08-31T01:00:02.000Z",
      id: (prefix) => `${prefix}-restart`,
    });
    expect(restarted.reconcileExpired()).toMatchObject({ readOnlyExpired: [unit.workUnitId], mutationRecovery: [] });
    expect(restarted.reconcileExpired()).toMatchObject({ readOnlyExpired: [], mutationRecovery: [] });
    expect(store.load().workUnits[unit.workUnitId]?.attempts[leased.lease.attemptId]?.state)
      .toBe("uncertain");
  });

  it("does not expire or retry a persisted mutation intent", () => {
    const { store, unit, coordinator } = setup();
    const leased = coordinator.lease(unit.workUnitId, "2026-08-31T01:00:01.000Z");
    if (!leased.acquired) throw new Error("expected lease");
    coordinator.recordIntent(leased.lease, "publish");
    const restarted = new ShepherdCoordinator(store, direct, {
      ownerId: "shepherdd-restarted",
      now: () => "2026-08-31T01:00:02.000Z",
      id: (prefix) => `${prefix}-restart`,
    });
    const result = restarted.reconcileExpired();
    expect(result.readOnlyExpired).toEqual([]);
    expect(result.mutationRecovery).toEqual([expect.objectContaining({
      workUnitId: unit.workUnitId,
      attemptId: leased.lease.attemptId,
      operation: "publish",
    })]);
    expect(store.load().workUnits[unit.workUnitId]?.activeLease).toBeDefined();
  });

  it("does not append when cross-process coordination is held", () => {
    const { store, unit } = setup();
    const held: AppendCoordination = { run: () => ({ acquired: false, reason: "lock-held" }) };
    const coordinator = new ShepherdCoordinator(store, held, {
      ownerId: "shepherdd-test",
      now: () => now,
      id: (prefix) => `${prefix}-held`,
    });
    expect(coordinator.lease(unit.workUnitId, "2026-08-31T01:05:00.000Z"))
      .toEqual({ acquired: false, reason: "append-lock-held" });
    expect(store.events()).toHaveLength(1);
  });

  it("grants exactly one durable lease in a real two-process race", async () => {
    const coordinatorModule = fileURLToPath(new URL("../lib/coordinator.js", import.meta.url));
    const appendModule = fileURLToPath(new URL("../lib/append-coordination.js", import.meta.url));
    const storeModule = fileURLToPath(new URL("../lib/store.js", import.meta.url));
    if (![coordinatorModule, appendModule, storeModule].every(existsSync)) {
      throw new Error("built Shepherd modules are required for process-race test");
    }

    const race = (directory: string, workUnitId: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const script = `
          import { ShepherdCoordinator } from ${JSON.stringify(coordinatorModule)};
          import { FileAppendCoordination } from ${JSON.stringify(appendModule)};
          import { openShepherdStore } from ${JSON.stringify(storeModule)};
          const store = openShepherdStore(${JSON.stringify(directory)});
          const lock = new FileAppendCoordination({
            directory: ${JSON.stringify(join(directory, "append-lock"))},
            bootId: "boot-process-race",
          });
          const coordinator = new ShepherdCoordinator(store, lock, { ownerId: "child-" + process.pid });
          const result = coordinator.lease(${JSON.stringify(workUnitId)}, "2099-01-01T00:00:00.000Z");
          process.stdout.write(result.acquired ? "WON" : "LOST");
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });

    for (let round = 0; round < 5; round += 1) {
      const directory = mkdtempSync(join(tmpdir(), "helium-shepherd-process-race-"));
      const store = openShepherdStore(directory);
      const work = createWorkUnit({
        kind: "market-partition",
        provider: "massive",
        assetClass: "equity",
        marketDate: `2026-08-${String(20 + round).padStart(2, "0")}`,
        timeframe: "1m",
        layer: "bronze",
      });
      store.append({ version: 1, eventId: "discover", at: now, type: "work-unit/discovered", payload: { unit: work } });
      const results = await Promise.all([race(directory, work.workUnitId), race(directory, work.workUnitId)]);
      expect(results.filter((result) => result === "WON"), `round ${round}`).toHaveLength(1);
      expect(results.filter((result) => result === "LOST"), `round ${round}`).toHaveLength(1);
      expect(openShepherdStore(directory).load().workUnits[work.workUnitId]?.activeLease).toBeDefined();
    }
  }, 30_000);
});
