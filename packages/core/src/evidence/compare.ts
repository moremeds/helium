/** Pure comparison of claim sets. It describes disagreement; it never adjudicates it. */
import { ClaimSetSchema, type Claim, type ClaimSet } from "./claims.js";

export type EvidenceGapReason = "missing-provenance" | "shared-source-only";

export interface ClaimComparison {
  agreements: Array<{
    key: string;
    statement: string;
    producerRoles: string[];
    independentEvidence: boolean;
  }>;
  contradictions: Array<{
    key: string;
    claims: Array<{ producerRole: string; statement: string }>;
    requiresVerification: true;
  }>;
  subjectiveJudgments: Array<{
    key: string;
    claims: Array<{ producerRole: string; statement: string }>;
    requiresVerification: false;
  }>;
  uniqueEvidence: Array<{ key: string; sourceRef: string; producerRole: string }>;
  evidenceGaps: Array<{
    key: string;
    producerRole?: string;
    reason: EvidenceGapReason;
  }>;
  verificationWorkOrders: Array<{
    id: string;
    claimKey: string;
    reason: "contradiction" | "non-independent-consensus";
    requires: ["fresh-evidence", "independent-source"];
    excludeEvidenceRefs: string[];
  }>;
}

const normalizedStatement = (claim: Claim): string =>
  claim.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

/** Compare two or more roles' claims without selecting a winner. */
export function compareClaimSets(...inputs: ClaimSet[]): ClaimComparison {
  const sets = inputs.map((input) => ClaimSetSchema.parse(input));
  if (sets.length < 2) throw new Error("claim comparison requires at least two claim sets");

  const result: ClaimComparison = {
    agreements: [],
    contradictions: [],
    subjectiveJudgments: [],
    uniqueEvidence: [],
    evidenceGaps: [],
    verificationWorkOrders: [],
  };
  const keys = [...new Set(sets.flatMap((set) => set.claims.map((claim) => claim.key)))].sort();

  for (const key of keys) {
    const entries = sets.flatMap((set) => {
      const claim = set.claims.find((candidate) => candidate.key === key);
      return claim === undefined ? [] : [{ producerRole: set.producerRole, claim }];
    });

    for (const entry of entries) {
      if (entry.claim.evidenceRefs.length === 0) {
        result.evidenceGaps.push({
          key,
          producerRole: entry.producerRole,
          reason: "missing-provenance",
        });
      }
      for (const sourceRef of entry.claim.evidenceRefs) {
        const usedBy = entries.filter((other) => other.claim.evidenceRefs.includes(sourceRef));
        if (usedBy.length === 1) {
          result.uniqueEvidence.push({ key, sourceRef, producerRole: entry.producerRole });
        }
      }
    }

    if (entries.length < 2) continue;
    const statements = new Set(entries.map((entry) => normalizedStatement(entry.claim)));
    const allRefs = entries.flatMap((entry) => entry.claim.evidenceRefs);
    const distinctRefs = new Set(allRefs);
    const everyClaimHasEvidence = entries.every((entry) => entry.claim.evidenceRefs.length > 0);
    const independentEvidence =
      everyClaimHasEvidence &&
      distinctRefs.size > 1 &&
      entries.some((entry, index) =>
        entries.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            entry.claim.evidenceRefs.every((ref) => !other.claim.evidenceRefs.includes(ref)),
        ),
      );

    if (statements.size === 1) {
      result.agreements.push({
        key,
        statement: entries[0]!.claim.statement,
        producerRoles: entries.map((entry) => entry.producerRole),
        independentEvidence,
      });
      if (everyClaimHasEvidence && !independentEvidence) {
        result.evidenceGaps.push({ key, reason: "shared-source-only" });
        result.verificationWorkOrders.push({
          id: `verify:${key}:independence`,
          claimKey: key,
          reason: "non-independent-consensus",
          requires: ["fresh-evidence", "independent-source"],
          excludeEvidenceRefs: [...distinctRefs].sort(),
        });
      }
      continue;
    }

    const claims = entries.map((entry) => ({
      producerRole: entry.producerRole,
      statement: entry.claim.statement,
    }));
    if (entries.every((entry) => entry.claim.kind === "judgment")) {
      result.subjectiveJudgments.push({ key, claims, requiresVerification: false });
      continue;
    }
    result.contradictions.push({ key, claims, requiresVerification: true });
    result.verificationWorkOrders.push({
      id: `verify:${key}:contradiction`,
      claimKey: key,
      reason: "contradiction",
      requires: ["fresh-evidence", "independent-source"],
      excludeEvidenceRefs: [...distinctRefs].sort(),
    });
  }

  return result;
}

export type { ClaimSet } from "./claims.js";
