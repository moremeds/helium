import { describe, expect, it } from "vitest";
import {
  compareUtility,
  evaluateStop,
  type UtilityPolicy,
} from "../evolution/utility.js";

const policy: UtilityPolicy = {
  constraint: { metric: "error", upperBound: 0.1 },
  objectives: [
    { metric: "quality", direction: "higher", epsilon: 0.01 },
    { metric: "cost", direction: "lower", epsilon: 0.5 },
  ],
};

describe("constrained utility", () => {
  it("puts feasibility ahead of objective epsilon at the boundary", () => {
    const result = compareUtility(
      policy,
      { error: 0.099, quality: 1, cost: 10 },
      { error: 0.101, quality: 100, cost: 0 },
    );
    expect(result).toMatchObject({ eligible: true, feasible: false, improved: false });
  });

  it("ranks infeasible candidates by violation before objectives", () => {
    expect(compareUtility(
      policy,
      { error: 0.3, quality: 100, cost: 0 },
      { error: 0.2, quality: 0, cost: 100 },
    )).toMatchObject({ improved: true, feasible: false, reason: "constraint-improved" });
  });

  it("uses ordered objective direction and epsilon once constraint status ties", () => {
    expect(compareUtility(
      policy,
      { error: 0.05, quality: 1, cost: 10 },
      { error: 0.05, quality: 1.005, cost: 9 },
    )).toMatchObject({ improved: true, feasible: true, reason: "objective-improved" });
    expect(compareUtility(
      policy,
      { error: 0.05, quality: 1, cost: 10 },
      { error: 0.05, quality: 0.98, cost: 0 },
    )).toMatchObject({ improved: false, reason: "objective-regressed" });
  });

  it("leaves metric sign conventions to the adapter", () => {
    const signedPolicy: UtilityPolicy = {
      constraint: { metric: "signed_value", minimum: 0, upperBound: 0.15 },
      objectives: [{ metric: "score", direction: "higher", epsilon: 0 }],
    };
    // A drawdown adapter must supply magnitude; the generic evaluator does not abs() values.
    expect(compareUtility(
      signedPolicy,
      { signed_value: -0.2, score: 1 },
      { signed_value: -0.3, score: 2 },
    )).toMatchObject({ eligible: false, feasible: false, improved: false, reason: "invalid-measure" });
  });

  it("fails closed on invalid measures and policy", () => {
    expect(compareUtility(policy, { error: 0, quality: 1, cost: 1 }, { error: 0, quality: NaN, cost: 1 }))
      .toMatchObject({ eligible: false, improved: false, reason: "invalid-measure" });
    expect(() => compareUtility({
      ...policy,
      objectives: [{ metric: "quality", direction: "higher", epsilon: -1 }],
    }, { error: 0, quality: 1 }, { error: 0, quality: 2 })).toThrow(/negative epsilon/);
    expect(() => compareUtility({
      ...policy,
      objectives: [{ metric: "quality", direction: "sideways" as "higher", epsilon: 0 }],
    }, { error: 0, quality: 1 }, { error: 0, quality: 2 })).toThrow(/direction/);
    expect(compareUtility(policy, null as unknown as Record<string, number>, {}))
      .toMatchObject({ eligible: false, reason: "invalid-measure" });
    expect(() => compareUtility({
      ...policy,
      constraint: { metric: 7 as unknown as string, upperBound: 1 },
    }, {}, {})).toThrow(/utility metric/);
    expect(() => compareUtility({
      ...policy,
      constraint: { metric: "error", minimum: 2, upperBound: 1 },
    }, {}, {})).toThrow(/minimum exceeds upper bound/);
  });
});

describe("stopping", () => {
  const improved = compareUtility(policy,
    { error: 0.05, quality: 1, cost: 10 },
    { error: 0.05, quality: 1.02, cost: 10 });
  const flat = compareUtility(policy,
    { error: 0.05, quality: 1, cost: 10 },
    { error: 0.05, quality: 1.005, cost: 10 });
  const invalid = compareUtility(policy,
    { error: 0.05, quality: 1, cost: 10 },
    { error: 0.05, quality: Infinity, cost: 10 });

  it("stops only on explicit target confirmation or exhausted measured budget", () => {
    const stopPolicy = { maxCalls: 3, maxElapsedMs: 100, stalledCandidates: 2 };
    expect(evaluateStop(stopPolicy, {
      targetVerified: true, callsUsed: 0, elapsedMs: 0, completed: [],
    }).reason).toBe("target_verified");
    expect(evaluateStop(stopPolicy, {
      targetVerified: false, callsUsed: 3, elapsedMs: 0, completed: [],
    })).toEqual({ stop: true, reason: "budget_exhausted" });
    expect(evaluateStop(stopPolicy, {
      targetVerified: false, callsUsed: 0, elapsedMs: 100, completed: [],
    })).toEqual({ stop: true, reason: "budget_exhausted" });
  });

  it("stops after K evaluable non-improvements and ignores invalid results", () => {
    const stopPolicy = { maxCalls: 10, stalledCandidates: 2 };
    expect(evaluateStop(stopPolicy, {
      targetVerified: false, callsUsed: 4, elapsedMs: 10, completed: [flat, invalid, flat],
    })).toEqual({ stop: true, reason: "stalled" });
    expect(evaluateStop(stopPolicy, {
      targetVerified: false, callsUsed: 4, elapsedMs: 10, completed: [flat, improved, flat],
    })).toEqual({ stop: false, reason: "continue" });
  });

  it("rejects invalid budget configuration and measurements", () => {
    const state = { targetVerified: false, callsUsed: 0, elapsedMs: 0, completed: [] };
    expect(() => evaluateStop({ maxCalls: -1, stalledCandidates: 2 }, state)).toThrow(/maxCalls/);
    expect(() => evaluateStop({ maxCalls: 2, stalledCandidates: 0 }, state)).toThrow(/stalledCandidates/);
    expect(() => evaluateStop({ stalledCandidates: 2 }, state)).toThrow(/finite budget/);
    expect(() => evaluateStop({ maxCalls: 2, stalledCandidates: 2 }, { ...state, elapsedMs: NaN }))
      .toThrow(/elapsedMs/);
    expect(() => evaluateStop({ maxCalls: 2, stalledCandidates: 2 }, {
      ...state,
      targetVerified: "false" as unknown as boolean,
    })).toThrow(/targetVerified/);
    expect(() => evaluateStop({ maxCalls: 2, stalledCandidates: 2 }, {
      ...state,
      completed: [{ eligible: "false", improved: false, feasible: false } as unknown as typeof flat],
    })).toThrow(/completed utility comparison/);
    expect(() => evaluateStop({ maxCalls: Number.MAX_SAFE_INTEGER + 1, stalledCandidates: 2 }, state))
      .toThrow(/maxCalls/);
  });
});
