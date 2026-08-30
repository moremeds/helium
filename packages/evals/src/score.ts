export interface ScoredClaim {
  key: string;
  kind: "fact" | "inference" | "judgment";
  evidenceRefs: string[];
  status: "PLANNED" | "PARTIAL" | "PROVEN" | "FAILED" | "BLOCKED";
}

export interface RunScoreInput {
  accepted: boolean;
  claims: ScoredClaim[];
  contradictions: { material: number; correctlyResolved: number };
  uniqueEvidenceRefs: string[];
  structuredOutputValid: boolean;
  capabilityCalls: Array<{ capability: string; authorized: boolean }>;
  latencyMs: number;
  cost?: number;
  humanPreference?: number;
}

export interface RunScore {
  acceptance: 0 | 1;
  verifiedClaimRate: number;
  unsupportedClaimRate: number;
  contradictionResolutionRate: number;
  uniqueEvidence: number;
  structuredOutput: 0 | 1;
  unauthorizedCalls: number;
  latencyMs: number;
  cost?: number;
  humanPreference?: number;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/** Offline scorecard only. No score feeds target selection. */
export function scoreRun(input: RunScoreInput): RunScore {
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
    throw new Error("latency must be finite and non-negative");
  }
  const material = input.claims.filter((claim) => claim.kind !== "judgment");
  const verified = material.filter(
    (claim) => claim.status === "PROVEN" && claim.evidenceRefs.length > 0,
  );
  const unsupported = material.filter((claim) => claim.evidenceRefs.length === 0);
  const uniqueEvidence = new Set(input.uniqueEvidenceRefs);
  return {
    acceptance: input.accepted ? 1 : 0,
    verifiedClaimRate: ratio(verified.length, input.claims.length),
    unsupportedClaimRate: ratio(unsupported.length, material.length),
    contradictionResolutionRate: ratio(
      input.contradictions.correctlyResolved,
      input.contradictions.material,
    ),
    uniqueEvidence: uniqueEvidence.size,
    structuredOutput: input.structuredOutputValid ? 1 : 0,
    unauthorizedCalls: input.capabilityCalls.filter((call) => !call.authorized).length,
    latencyMs: input.latencyMs,
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    ...(input.humanPreference === undefined
      ? {}
      : { humanPreference: input.humanPreference }),
  };
}
