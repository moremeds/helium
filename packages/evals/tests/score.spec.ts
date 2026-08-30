import { describe, expect, it } from "vitest";
import { scoreRun } from "../src/score.js";

describe("scoreRun", () => {
  it("scores acceptance, provenance, contradictions, evidence, structure and operations", () => {
    expect(scoreRun({
      accepted: true,
      claims: [
        { key: "a", kind: "fact", evidenceRefs: ["artifact://a"], status: "PROVEN" },
        { key: "b", kind: "judgment", evidenceRefs: [], status: "PARTIAL" },
      ],
      contradictions: { material: 2, correctlyResolved: 2 },
      uniqueEvidenceRefs: ["artifact://a", "artifact://b"],
      structuredOutputValid: true,
      capabilityCalls: [
        { capability: "research.read", authorized: true },
        { capability: "mutation.write", authorized: false },
      ],
      latencyMs: 120,
      cost: 0,
      humanPreference: 0.75,
    })).toEqual({
      acceptance: 1,
      verifiedClaimRate: 0.5,
      unsupportedClaimRate: 0,
      contradictionResolutionRate: 1,
      uniqueEvidence: 2,
      structuredOutput: 1,
      unauthorizedCalls: 1,
      latencyMs: 120,
      cost: 0,
      humanPreference: 0.75,
    });
  });

  it("counts a factual claim with no provenance as unsupported", () => {
    expect(scoreRun({
      accepted: false,
      claims: [{ key: "a", kind: "fact", evidenceRefs: [], status: "PARTIAL" }],
      contradictions: { material: 0, correctlyResolved: 0 },
      uniqueEvidenceRefs: [],
      structuredOutputValid: false,
      capabilityCalls: [],
      latencyMs: 10,
    })).toMatchObject({ unsupportedClaimRate: 1, verifiedClaimRate: 0 });
  });
});
