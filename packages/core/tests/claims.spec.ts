import { describe, expect, it } from "vitest";
import { ClaimSchema, ClaimSetSchema } from "../src/evidence/claims.js";

describe("ClaimSchema", () => {
  it("normalizes a provider-neutral factual claim", () => {
    expect(
      ClaimSchema.parse({
        key: "policy.rate_path",
        statement: "The policy rate is likely to remain restrictive.",
        kind: "fact",
        evidenceRefs: ["artifact://source/minutes"],
        confidence: 0.8,
        assumptions: [],
        asOf: "2026-08-30T00:00:00.000Z",
      }),
    ).toMatchObject({ key: "policy.rate_path", kind: "fact" });
  });

  it("allows an empty provenance list so comparison can expose the gap", () => {
    expect(
      ClaimSchema.parse({
        key: "policy.rate_path",
        statement: "Rates will fall.",
        kind: "inference",
        evidenceRefs: [],
        confidence: 0.5,
        assumptions: ["Inflation continues to cool."],
      }).evidenceRefs,
    ).toEqual([]);
  });

  it("rejects duplicate evidence and out-of-range confidence", () => {
    const claim = {
      key: "gold.impact",
      statement: "Gold benefits.",
      kind: "judgment",
      evidenceRefs: ["artifact://same", "artifact://same"],
      confidence: 1.1,
      assumptions: ["Real yields fall."],
    };
    expect(() => ClaimSchema.parse(claim)).toThrow();
  });

  it("rejects provider and model fields at claim-set boundaries", () => {
    expect(() =>
      ClaimSetSchema.parse({
        claimSetId: "set-1",
        producerRole: "researcher",
        model: "forbidden",
        claims: [],
      }),
    ).toThrow(/unrecognized key/i);
  });
});
