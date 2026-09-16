import { describe, expect, it } from "vitest";
import { decideRetention, freezeCampaign, type CandidateResult } from "../evolution/campaign.js";

const contract = freezeCampaign({
  id: "q-demo", version: "v1", goal: "improve", evaluatorVersion: "eval-v1",
  rubricVersion: "rubric-v1", holdoutVersion: "holdout-v1", baseRevision: "base",
  primaryMetric: "score", direction: "higher",
});
const candidate = (over: Partial<CandidateResult> = {}): CandidateResult => ({
  id: "c1", parentRevision: "base", revision: "cand", contractVersion: "v1",
  measures: { score: 0.8 }, checks: { routeResolved: true, outputValid: true, evidenceComplete: true }, ...over,
});

describe("M3 campaign retention", () => {
  it("retains a verified improvement and rolls back a regression", () => {
    expect(decideRetention(contract, { score: 0.7 }, candidate()).status).toBe("retained");
    expect(decideRetention(contract, { score: 0.9 }, candidate({ measures: { score: 0.8 } })).status).toBe("rolled_back");
  });

  it("fails closed on route, schema, evidence, and lineage/version defects", () => {
    for (const checks of [
      { routeResolved: false, outputValid: true, evidenceComplete: true },
      { routeResolved: true, outputValid: false, evidenceComplete: true },
      { routeResolved: true, outputValid: true, evidenceComplete: false },
    ]) expect(decideRetention(contract, { score: 0.7 }, candidate({ checks })).status).toBe("ineligible");
    expect(decideRetention(contract, { score: 0.7 }, candidate({ contractVersion: "v2" })).status).toBe("ineligible");
    expect(decideRetention(contract, { score: 0.7 }, candidate({ parentRevision: "other" })).status).toBe("ineligible");
  });
});


it("uses constrained utility and freezes policy independently of caller mutations", () => {
  const policy = { constraint: { metric: "loss", upperBound: 0.15 },
    objectives: [{ metric: "reward", direction: "higher" as const, epsilon: 0.001 }] };
  const frozen = freezeCampaign({ ...contract, utilityPolicy: policy });
  policy.constraint.upperBound = 1;
  policy.objectives[0]!.epsilon = 100;
  expect(frozen.utilityPolicy!.constraint.upperBound).toBe(0.15);
  const base = { loss: 0.2, reward: 0.3 };
  const c = candidate({ measures: { loss: 0.1, reward: 0.2 } });
  expect(decideRetention(frozen, base, c).status).toBe("retained");
  expect(decideRetention(frozen, { loss: 0.1, reward: 0.2 },
    candidate({ measures: { loss: 0.2, reward: 0.9 } })).status).toBe("rolled_back");
  expect(decideRetention(frozen, base, candidate()).status).toBe("ineligible");
  expect(decideRetention(frozen, base, { ...c,
    checks: { routeResolved: "false", outputValid: true, evidenceComplete: true },
  } as unknown as CandidateResult).status).toBe("ineligible");
});
it('refuses improvement attributed to an unchanged revision', () => {
  expect(decideRetention(contract, {score:0.1}, candidate({revision:'base'})).status).toBe('ineligible');
});
