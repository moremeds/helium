import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const PROVISIONAL_PAIRED_GATE = {
  minPairs: 30,
  minRelativeReduction: 0.2,
  maxPValue: 0.05,
} as const;

export type EvaluationState =
  | "completed"
  | "quota-exhausted"
  | "cancelled"
  | "timeout"
  | "failed";

export interface EvaluationArm {
  state: EvaluationState;
  inputFingerprint: string;
  anchorSnapshot: string;
  anchorTarget?: string;
  unsupportedClaims: number;
  totalClaims: number;
}

export interface PairedEvaluation {
  caseId: string;
  control: EvaluationArm;
  treatment: EvaluationArm;
}

export interface PairedGateResult {
  passed: boolean;
  fixtureHash: string;
  includedPairs: number;
  excludedPairs: number;
  rescheduleCaseIds: string[];
  controlUnsupportedClaimRate: number;
  treatmentUnsupportedClaimRate: number;
  relativeReduction: number;
  pValue: number;
  reasons: string[];
  thresholds: typeof PROVISIONAL_PAIRED_GATE;
}

function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    });
}

/** Hash path and bytes in stable lexical order; adding, removing or renaming fails. */
export function fixtureDirectoryHash(root: string): string {
  const hash = createHash("sha256");
  for (const path of filesUnder(root)) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const validCount = (arm: EvaluationArm): boolean =>
  Number.isSafeInteger(arm.unsupportedClaims) &&
  Number.isSafeInteger(arm.totalClaims) &&
  arm.unsupportedClaims >= 0 &&
  arm.totalClaims > 0 &&
  arm.unsupportedClaims <= arm.totalClaims;

function pairIsEligible(pair: PairedEvaluation): boolean {
  return (
    pair.control.state === "completed" &&
    pair.treatment.state === "completed" &&
    pair.control.inputFingerprint === pair.treatment.inputFingerprint &&
    pair.control.anchorSnapshot === pair.treatment.anchorSnapshot &&
    (pair.control.anchorTarget === undefined ||
      pair.treatment.anchorTarget === undefined ||
      pair.control.anchorTarget === pair.treatment.anchorTarget) &&
    validCount(pair.control) &&
    validCount(pair.treatment)
  );
}

const erf = (value: number): number => {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
};

const normalCdf = (value: number): number => (1 + erf(value / Math.SQRT2)) / 2;

/** Two-sided Wilcoxon signed-rank p-value with tie-corrected normal approximation. */
export function wilcoxonSignedRankPValue(differences: number[]): number {
  const nonzero = differences.filter((difference) => Math.abs(difference) > 1e-12);
  if (nonzero.length === 0) return 1;
  const sorted = nonzero
    .map((difference, index) => ({ difference, absolute: Math.abs(difference), index }))
    .sort((left, right) => left.absolute - right.absolute || left.index - right.index);
  const ranks = new Array<number>(sorted.length);
  const ties: number[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && Math.abs(sorted[end]!.absolute - sorted[start]!.absolute) <= 1e-12) end += 1;
    const average = ((start + 1) + end) / 2;
    for (let index = start; index < end; index += 1) ranks[index] = average;
    ties.push(end - start);
    start = end;
  }
  const positive = sorted.reduce(
    (sum, entry, index) => sum + (entry.difference > 0 ? ranks[index]! : 0),
    0,
  );
  const n = sorted.length;
  const mean = (n * (n + 1)) / 4;
  const tiePenalty = ties.reduce((sum, size) => sum + size ** 3 - size, 0) / 48;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tiePenalty;
  if (variance <= 0) return positive === mean ? 1 : 0;
  const z = Math.max(0, Math.abs(positive - mean) - 0.5) / Math.sqrt(variance);
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

export function evaluatePairedGate(input: {
  fixtureDir: string;
  expectedFixtureHash: string;
  pairs: PairedEvaluation[];
}): PairedGateResult {
  const fixtureHash = fixtureDirectoryHash(input.fixtureDir);
  const included = input.pairs.filter(pairIsEligible);
  const excluded = input.pairs.filter((pair) => !pairIsEligible(pair));
  const controlRates = included.map((pair) => pair.control.unsupportedClaims / pair.control.totalClaims);
  const treatmentRates = included.map((pair) => pair.treatment.unsupportedClaims / pair.treatment.totalClaims);
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const controlRate = mean(controlRates);
  const treatmentRate = mean(treatmentRates);
  const relativeReduction = controlRate === 0 ? 0 : (controlRate - treatmentRate) / controlRate;
  const pValue = wilcoxonSignedRankPValue(
    controlRates.map((rate, index) => rate - treatmentRates[index]!),
  );
  const reasons: string[] = [];
  if (fixtureHash !== input.expectedFixtureHash) reasons.push("fixture-hash-mismatch");
  if (included.length < PROVISIONAL_PAIRED_GATE.minPairs) reasons.push("insufficient-pairs");
  if (relativeReduction < PROVISIONAL_PAIRED_GATE.minRelativeReduction) {
    reasons.push("insufficient-relative-reduction");
  }
  if (pValue >= PROVISIONAL_PAIRED_GATE.maxPValue) reasons.push("not-statistically-significant");
  return {
    passed: reasons.length === 0,
    fixtureHash,
    includedPairs: included.length,
    excludedPairs: excluded.length,
    rescheduleCaseIds: excluded.map((pair) => pair.caseId),
    controlUnsupportedClaimRate: controlRate,
    treatmentUnsupportedClaimRate: treatmentRate,
    relativeReduction,
    pValue,
    reasons,
    thresholds: PROVISIONAL_PAIRED_GATE,
  };
}
