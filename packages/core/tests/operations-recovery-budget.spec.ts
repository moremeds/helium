import { describe, expect, it } from "vitest";
import { RecoveryBudget } from "../src/operations/recovery-budget.js";
import type { AttemptRecord } from "../src/operations/authority.js";

const now = new Date("2026-08-25T04:00:00.000Z");
const policy = {
  maxAttemptsPerIncident: 2,
  maxRunsPerWindow: 3,
  windowMs: 3_600_000,
  cooldownMs: 900_000,
};

const attempt = (overrides: Partial<AttemptRecord> = {}): AttemptRecord => ({
  sopId: "restart",
  incidentId: "inc-1",
  at: "2026-08-25T02:00:00.000Z",
  outcome: "failed",
  ...overrides,
});

const budget = () => new RecoveryBudget(policy);

describe("RecoveryBudget", () => {
  it("admits a first attempt", () => {
    expect(budget().check({ incidentId: "inc-1", sopId: "restart", history: [], now })).toEqual(
      { ok: true },
    );
  });

  it("refuses past the per-incident attempt limit", () => {
    expect(
      budget().check({
        incidentId: "inc-1",
        sopId: "restart",
        history: [attempt(), attempt({ at: "2026-08-25T02:30:00.000Z" })],
        now,
      }),
    ).toEqual({ ok: false, reason: "max-attempts-per-incident" });
  });

  it("refuses past the per-window run limit even across incidents", () => {
    expect(
      budget().check({
        incidentId: "inc-9",
        sopId: "restart",
        history: [
          attempt({ incidentId: "inc-2", at: "2026-08-25T03:10:00.000Z" }),
          attempt({ incidentId: "inc-3", at: "2026-08-25T03:20:00.000Z" }),
          attempt({ incidentId: "inc-4", at: "2026-08-25T03:30:00.000Z" }),
        ],
        now,
      }),
    ).toEqual({ ok: false, reason: "max-runs-per-window" });
  });

  it("lets runs outside the window fall out of the count", () => {
    expect(
      budget().check({
        incidentId: "inc-9",
        sopId: "restart",
        history: [
          attempt({ incidentId: "inc-2", at: "2026-08-25T01:00:00.000Z" }),
          attempt({ incidentId: "inc-3", at: "2026-08-25T01:10:00.000Z" }),
          attempt({ incidentId: "inc-4", at: "2026-08-25T01:20:00.000Z" }),
        ],
        now,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses inside the cooldown", () => {
    expect(
      budget().check({
        incidentId: "inc-1",
        sopId: "restart",
        history: [attempt({ at: "2026-08-25T03:55:00.000Z" })],
        now,
      }),
    ).toEqual({ ok: false, reason: "cooldown" });
  });

  // not-needed means the component was already healthy. It still consumes an
  // attempt -- otherwise a component that keeps looking healthy at baseline
  // lets the controller loop forever.
  it("counts a not-needed attempt against the budget", () => {
    expect(
      budget().check({
        incidentId: "inc-1",
        sopId: "restart",
        history: [
          attempt({ outcome: "not-needed" }),
          attempt({ outcome: "not-needed", at: "2026-08-25T02:30:00.000Z" }),
        ],
        now,
      }),
    ).toEqual({ ok: false, reason: "max-attempts-per-incident" });
  });
});

describe("reservation", () => {
  it("charges once and never twice for the same operation id", () => {
    const b = budget();
    expect(b.reserve("op-1", { incidentId: "inc-1", at: now.toISOString() })).toEqual({
      charged: true,
    });
    expect(b.reserve("op-1", { incidentId: "inc-1", at: now.toISOString() })).toEqual({
      charged: false,
    });
    expect(b.chargeCount()).toBe(1);
  });

  it("survives a replayed reservation without spending budget again", () => {
    // The crash-recovery path: a controller that reconciles after a crash
    // replays its reservation, and must not spend budget it already spent.
    const b = budget();
    for (let i = 0; i < 10; i += 1) {
      b.reserve("op-1", { incidentId: "inc-1", at: now.toISOString() });
    }
    expect(b.chargeCount()).toBe(1);
  });

  it("treats the same id charged to a different incident as corruption", () => {
    const b = budget();
    b.reserve("op-1", { incidentId: "inc-1", at: now.toISOString() });
    expect(() =>
      b.reserve("op-1", { incidentId: "inc-2", at: now.toISOString() }),
    ).toThrow(/different incident/);
  });
});
