import { compareUtility, type UtilityPolicy } from "./utility.js";

export type MeasureVector = Readonly<Record<string, number>>;

export interface CampaignContract {
  readonly id: string;
  readonly version: string;
  readonly goal: string;
  readonly evaluatorVersion: string;
  readonly rubricVersion: string;
  readonly holdoutVersion: string;
  readonly baseRevision: string;
  readonly primaryMetric: string;
  readonly direction: "higher" | "lower";
  readonly utilityPolicy?: UtilityPolicy;
}

export interface CandidateResult {
  readonly id: string;
  readonly parentRevision: string;
  readonly revision: string;
  readonly contractVersion: string;
  readonly measures: MeasureVector;
  readonly checks: Readonly<{
    routeResolved: boolean;
    outputValid: boolean;
    evidenceComplete: boolean;
  }>;
}

export interface RetentionDecision {
  readonly status: "retained" | "rolled_back" | "ineligible";
  readonly revision: string;
  readonly reason: string;
}

export function freezeCampaign(contract: CampaignContract): CampaignContract {
  if (![contract.id, contract.version, contract.evaluatorVersion,
      contract.rubricVersion, contract.holdoutVersion, contract.baseRevision,
      contract.primaryMetric, contract.goal].every(value => typeof value === "string" && value.trim().length > 0))
    throw new Error("campaign contract has missing identity fields");
  if (contract.direction !== "higher" && contract.direction !== "lower")
    throw new Error("invalid campaign direction");
  const utilityPolicy = contract.utilityPolicy && Object.freeze({
    constraint: Object.freeze({ ...contract.utilityPolicy.constraint }),
    objectives: Object.freeze(contract.utilityPolicy.objectives.map(o => Object.freeze({ ...o }))),
  });
  if (utilityPolicy) compareUtility(utilityPolicy, {}, {});
  return Object.freeze({ ...contract, utilityPolicy });
}

export function decideRetention(
  contract: CampaignContract,
  base: MeasureVector,
  candidate: CandidateResult,
): RetentionDecision {
  if (candidate.contractVersion !== contract.version)
    return { status: "ineligible", revision: contract.baseRevision, reason: "contract-version-mismatch" };
  if (candidate.parentRevision !== contract.baseRevision)
    return { status: "ineligible", revision: contract.baseRevision, reason: "parent-mismatch" };
  if (!candidate.revision || candidate.checks?.routeResolved !== true || candidate.checks?.outputValid !== true || candidate.checks?.evidenceComplete !== true)
    return { status: "ineligible", revision: contract.baseRevision, reason: "verification-failed" };
  if (typeof candidate.revision !== "string" || candidate.revision === contract.baseRevision)
    return { status: "ineligible", revision: contract.baseRevision, reason: "unchanged-or-invalid-revision" };
  if (contract.utilityPolicy) {
    const comparison = compareUtility(contract.utilityPolicy, base, candidate.measures);
    return {
      status: !comparison.eligible ? "ineligible" : comparison.improved ? "retained" : "rolled_back",
      revision: comparison.eligible && comparison.improved ? candidate.revision : contract.baseRevision,
      reason: comparison.reason,
    };
  }
  const before = base[contract.primaryMetric];
  const after = candidate.measures[contract.primaryMetric];
  if (!Number.isFinite(before) || !Number.isFinite(after))
    return { status: "ineligible", revision: contract.baseRevision, reason: "primary-measure-missing" };
  const improved = contract.direction === "higher" ? after > before : after < before;
  return improved
    ? { status: "retained", revision: candidate.revision, reason: "primary-measure-improved" }
    : { status: "rolled_back", revision: contract.baseRevision, reason: "primary-measure-not-improved" };
}
