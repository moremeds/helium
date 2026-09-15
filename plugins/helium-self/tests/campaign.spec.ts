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

