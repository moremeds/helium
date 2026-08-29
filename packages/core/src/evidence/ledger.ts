/**
 * The append-only evidence ledger: it validates a bundle against its policy
 * and records every new decision. It does not decide anything itself, and it
 * never derives a verdict from a run outcome.
 * @module @helium/core/evidence/ledger
 */
import {
  EVIDENCE_STATUSES,
  EvidenceBundleSchema,
  type EvidenceBundle,
  type EvidenceStatus,
} from "./bundle.js";

/**
 * How far up the ladder a status sits. `FAILED` and `BLOCKED` are outcomes,
 * not rungs: moving to either is never a promotion and needs no new decision.
 */
const STATUS_RANK: Readonly<Record<EvidenceStatus, number>> = {
  PLANNED: 0,
  BLOCKED: 0,
  FAILED: 0,
  PARTIAL: 1,
  PROVEN: 2,
};

/** Identity of one verifier decision, used to tell a re-record from a re-run. */
const decisionKey = (b: EvidenceBundle): string =>
  [b.verifier.identity, b.verifier.version, b.verifier.decision, b.verifier.decidedAt].join(
    "|",
  );

/**
 * Validate one bundle against its own declared policy.
 *
 * @param input - the candidate bundle.
 * @param now - evaluation time, for the freshness window.
 * @throws when a required stage has neither evidence nor an accepted
 * not-applicable reason, when the proof has expired, when `PROVEN` rests on a
 * non-passing verifier decision, or when a qualified status names no
 * limitation.
 */
export function acceptEvidence(
  input: unknown,
  now: Date = new Date(),
): EvidenceBundle {
  const bundle = EvidenceBundleSchema.parse(input);

  for (const stage of bundle.requiredStages) {
    const refs = bundle.stages[stage];
    if (refs !== undefined && refs.length > 0) continue;
    if (bundle.notApplicable?.[stage] !== undefined) continue;
    throw new Error(`missing required evidence stage: ${stage}`);
  }

  const expiresAt = bundle.freshness.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime()) {
    throw new Error(`evidence expired at ${expiresAt}`);
  }

  if (bundle.status === "PROVEN" && bundle.verifier.decision !== "pass") {
    throw new Error(
      `status PROVEN requires a passing verifier decision, got "${bundle.verifier.decision}"`,
    );
  }

  if (
    (bundle.status === "PARTIAL" || bundle.status === "BLOCKED") &&
    bundle.limitation.trim() === ""
  ) {
    throw new Error(`status ${bundle.status} requires a named limitation`);
  }

  return bundle;
}

export class EvidenceLedger {
  readonly #byAssertion = new Map<string, EvidenceBundle[]>();

  /**
   * Validate and record a decision. Append-only: nothing already recorded is
   * rewritten, and a promotion must carry a verifier decision the ledger has
   * not already seen -- otherwise the same run could be re-read as a stronger
   * claim without anything new having been verified.
   */
  accept(input: unknown, now: Date = new Date()): EvidenceBundle {
    const bundle = acceptEvidence(input, now);
    const history = this.#byAssertion.get(bundle.assertionId) ?? [];
    const previous = history.at(-1);

    if (
      previous !== undefined &&
      STATUS_RANK[bundle.status] > STATUS_RANK[previous.status] &&
      history.some((h) => decisionKey(h) === decisionKey(bundle))
    ) {
      throw new Error(
        `promotion ${previous.status} -> ${bundle.status} requires a new verifier decision`,
      );
    }

    history.push(bundle);
    this.#byAssertion.set(bundle.assertionId, history);
    return bundle;
  }

  history(assertionId: string): readonly EvidenceBundle[] {
    return this.#byAssertion.get(assertionId) ?? [];
  }

  current(assertionId: string): EvidenceBundle | undefined {
    return this.#byAssertion.get(assertionId)?.at(-1);
  }

  /** Every assertion the ledger has ever recorded a decision for. */
  assertions(): string[] {
    return [...this.#byAssertion.keys()].sort();
  }
}

export { EVIDENCE_STATUSES };
