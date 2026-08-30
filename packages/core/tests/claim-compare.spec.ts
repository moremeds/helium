import { describe, expect, it } from "vitest";
import { compareClaimSets, type ClaimSet } from "../src/evidence/compare.js";

const set = (
  claimSetId: string,
  producerRole: string,
  claims: ClaimSet["claims"],
): ClaimSet => ({ claimSetId, producerRole, claims });

const claim = (
  statement: string,
  evidenceRefs: string[],
  kind: "fact" | "inference" | "judgment" = "fact",
) => ({
  key: "policy.rate_path",
  statement,
  kind,
  evidenceRefs,
  confidence: 0.75,
  assumptions: kind === "fact" ? [] : ["Policy transmission remains stable."],
  asOf: "2026-08-30T00:00:00.000Z",
});

describe("compareClaimSets", () => {
  it("records agreement and preserves different evidence", () => {
    const comparison = compareClaimSets(
      set("primary", "researcher", [claim("Rates stay restrictive.", ["artifact://source/a"])]),
      set("review", "reviewer", [claim("Rates stay restrictive.", ["artifact://source/b"])]),
    );

    expect(comparison.agreements).toEqual([
      expect.objectContaining({
        key: "policy.rate_path",
        independentEvidence: true,
      }),
    ]);
    expect(comparison.uniqueEvidence).toContainEqual(
      expect.objectContaining({ sourceRef: "artifact://source/b", producerRole: "reviewer" }),
    );
    expect(comparison.contradictions).toEqual([]);
  });

  it("turns a direct contradiction into fresh-evidence verification work", () => {
    const comparison = compareClaimSets(
      set("primary", "researcher", [claim("Rates rise.", ["artifact://source/old"])]),
      set("review", "reviewer", [claim("Rates fall.", ["artifact://source/new"])]),
    );

    expect(comparison.contradictions).toEqual([
      expect.objectContaining({ key: "policy.rate_path", requiresVerification: true }),
    ]);
    expect(comparison.uniqueEvidence).toContainEqual(
      expect.objectContaining({ sourceRef: "artifact://source/new" }),
    );
    expect(comparison.verificationWorkOrders).toEqual([
      expect.objectContaining({
        claimKey: "policy.rate_path",
        requires: ["fresh-evidence", "independent-source"],
      }),
    ]);
  });

  it("exposes missing provenance instead of treating it as disagreement", () => {
    const comparison = compareClaimSets(
      set("primary", "researcher", [claim("Rates stay restrictive.", [])]),
      set("review", "reviewer", [claim("Rates stay restrictive.", ["artifact://source/a"])]),
    );
    expect(comparison.evidenceGaps).toContainEqual(
      expect.objectContaining({
        key: "policy.rate_path",
        producerRole: "researcher",
        reason: "missing-provenance",
      }),
    );
  });

  it("keeps subjective judgments visible without manufacturing a factual contradiction", () => {
    const comparison = compareClaimSets(
      set("primary", "lead", [claim("The risk is acceptable.", ["artifact://source/a"], "judgment")]),
      set("review", "reviewer", [claim("The risk is unacceptable.", ["artifact://source/b"], "judgment")]),
    );
    expect(comparison.contradictions).toEqual([]);
    expect(comparison.subjectiveJudgments).toEqual([
      expect.objectContaining({ key: "policy.rate_path", requiresVerification: false }),
    ]);
  });

  it("does not mistake three-agent use of the same source for independent consensus", () => {
    const shared = ["artifact://source/bad"];
    const comparison = compareClaimSets(
      set("one", "inflation", [claim("Rates rise.", shared)]),
      set("two", "policy", [claim("Rates rise.", shared)]),
      set("three", "reviewer", [claim("Rates rise.", shared)]),
    );
    expect(comparison.agreements[0]).toMatchObject({ independentEvidence: false });
    expect(comparison.evidenceGaps).toContainEqual(
      expect.objectContaining({
        key: "policy.rate_path",
        reason: "shared-source-only",
      }),
    );
    expect(comparison.verificationWorkOrders).toContainEqual(
      expect.objectContaining({ claimKey: "policy.rate_path" }),
    );
  });
});
