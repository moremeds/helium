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
  if (!contract.id || !contract.version || !contract.evaluatorVersion ||
      !contract.rubricVersion || !contract.holdoutVersion || !contract.baseRevision ||
      !contract.primaryMetric || !contract.goal)
    throw new Error("campaign contract has missing identity fields");
  return Object.freeze({ ...contract });
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
  if (!candidate.checks.routeResolved || !candidate.checks.outputValid || !candidate.checks.evidenceComplete)
    return { status: "ineligible", revision: contract.baseRevision, reason: "verification-failed" };
  const before = base[contract.primaryMetric];
  const after = candidate.measures[contract.primaryMetric];
  if (!Number.isFinite(before) || !Number.isFinite(after))
    return { status: "ineligible", revision: contract.baseRevision, reason: "primary-measure-missing" };
  const improved = contract.direction === "higher" ? after > before : after < before;
  return improved
    ? { status: "retained", revision: candidate.revision, reason: "primary-measure-improved" }
    : { status: "rolled_back", revision: contract.baseRevision, reason: "primary-measure-not-improved" };
}

