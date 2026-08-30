import { describe, expect, it } from "vitest";
import type { ShepherdProjection, WorkUnitProjection } from "./reducer.js";
import { ShepherdScheduler } from "./scheduler.js";
import { createWorkUnit, type ShepherdState } from "./work-unit.js";

function projection(
  state: ShepherdState,
  options: {
    provider?: string;
    activeLease?: boolean;
    retry?: WorkUnitProjection["retry"];
    discoveredAt?: string;
  } = {},
): WorkUnitProjection {
  const unit = createWorkUnit({
    kind: "market-partition",
    provider: options.provider ?? "massive",
    assetClass: "equity",
    marketDate: options.discoveredAt?.slice(0, 10) ?? "2026-08-28",
    timeframe: "1m",
    layer: "bronze",
  });
  const activeLease = options.activeLease
    ? {
        attemptId: "attempt-active",
        leaseId: "lease-active",
        ownerId: "owner",
        expiresAt: "2026-08-31T02:00:00.000Z",
        state: "leased" as const,
      }
    : undefined;
    return {
    unit,
    discoveredAt: options.discoveredAt ?? "2026-08-28T00:00:00.000Z",
    state,
    revision: 0,
    evidence: {},
    coverage: {},
    claims: {},
    attempts: activeLease === undefined ? {} : { [activeLease.attemptId]: activeLease },
    ...(activeLease === undefined ? {} : { activeLease }),
    verificationPassed: false,
    repairVerificationPassed: false,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };
}

function state(...units: WorkUnitProjection[]): ShepherdProjection {
  return {
    workUnits: Object.fromEntries(units.map((unit) => [unit.unit.workUnitId, unit])),
    eventIds: [],
    cycles: [],
  };
}

const normal = { level: "normal" as const };
const pressured = { level: "high" as const };
const now = new Date("2026-08-31T01:00:00.000Z");

describe("ShepherdScheduler", () => {
  it("leases ready Massive work while IB and UW waits remain local", () => {
    const massive = projection("DISCOVERED", { provider: "massive" });
    const ib = projection("AWAITING_USER", { provider: "ib" });
    const uw = projection("AWAITING_PROVIDER", {
      provider: "uw",
      retry: {
        wakeAt: "2026-08-31T02:00:00.000Z",
        trigger: "provider-availability",
        reason: "403",
        domain: "uw-research",
      },
    });

    const decisions = new ShepherdScheduler().decide(
      state(massive, ib, uw),
      { domains: { massive: { state: "available" }, "uw-research": { state: "unavailable" } } },
      normal,
      now,
    );

    expect(decisions.find((d) => d.workUnitId === massive.unit.workUnitId)?.disposition)
      .toBe("lease");
    expect(decisions.find((d) => d.workUnitId === ib.unit.workUnitId)?.disposition)
      .toBe("wait");
    expect(decisions.find((d) => d.workUnitId === uw.unit.workUnitId))
      .toMatchObject({ disposition: "wait", wakeAt: "2026-08-31T02:00:00.000Z" });
  });

  it("does not poll before a retry trigger and resumes after availability changes", () => {
    const waiting = projection("AWAITING_PROVIDER", {
      provider: "uw",
      retry: {
        wakeAt: "2026-08-31T02:00:00.000Z",
        trigger: "provider-availability",
        reason: "quota",
        domain: "uw-research",
      },
    });
    const scheduler = new ShepherdScheduler();
    expect(scheduler.decide(
      state(waiting),
      { domains: { "uw-research": { state: "unavailable" } } },
      normal,
      now,
    )[0]?.disposition).toBe("wait");
    expect(scheduler.decide(
      state(waiting),
      { domains: { "uw-research": { state: "available" } } },
      normal,
      now,
    )[0]?.disposition).toBe("lease");
  });

  it("admits deterministic verification but refuses agent fanout under pressure", () => {
    const adjudicating = projection("ADJUDICATING", { provider: "search" });
    const verifying = projection("VERIFYING", { provider: "massive" });
    const decisions = new ShepherdScheduler().decide(
      state(adjudicating, verifying),
      { domains: {} },
      pressured,
      now,
    );
    expect(decisions.find((d) => d.workUnitId === adjudicating.unit.workUnitId))
      .toMatchObject({ disposition: "wait", reason: "resource-pressure" });
    expect(decisions.find((d) => d.workUnitId === verifying.unit.workUnitId)?.disposition)
      .toBe("verify");
  });

  it("never leases a unit with an active lease", () => {
    const active = projection("DISCOVERED", { activeLease: true });
    expect(new ShepherdScheduler().decide(state(active), { domains: {} }, normal, now)[0])
      .toMatchObject({ disposition: "wait", reason: "active-lease" });
  });

  it("returns a decision for every unit so a poisoned unit cannot starve later work", () => {
    const poisoned = projection("QUARANTINED", { provider: "ib" });
    const ready = projection("DISCOVERED", { provider: "massive", discoveredAt: "2026-08-29T00:00:00.000Z" });
    const decisions = new ShepherdScheduler().decide(state(poisoned, ready), { domains: {} }, normal, now);
    expect(decisions).toHaveLength(2);
    expect(decisions.some((d) => d.workUnitId === ready.unit.workUnitId && d.disposition === "lease"))
      .toBe(true);
  });

  it("orders deterministic verification before new fanout, then by discovery time", () => {
    const newer = projection("DISCOVERED", { provider: "massive", discoveredAt: "2026-08-29T00:00:00.000Z" });
    const older = projection("DISCOVERED", { provider: "ib", discoveredAt: "2026-08-28T00:00:00.000Z" });
    const verifier = projection("VERIFYING", { provider: "search", discoveredAt: "2026-08-30T00:00:00.000Z" });
    const decisions = new ShepherdScheduler().decide(state(newer, older, verifier), { domains: {} }, normal, now);
    expect(decisions.map((decision) => decision.workUnitId)).toEqual([
      verifier.unit.workUnitId,
      older.unit.workUnitId,
      newer.unit.workUnitId,
    ]);
  });
});
