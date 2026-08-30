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
  type EvidenceStage,
  type EvidenceStatus,
} from "./bundle.js";
import { ClaimSchema, type Claim } from "./claims.js";

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

export type ClaimPublisherRole = "agent" | "verifier" | "renderer";

export interface ClaimDecision {
  actorRole: ClaimPublisherRole;
  claim: Claim;
  evidence: EvidenceBundle;
}

export interface AcceptedClaimEntry {
  acceptedAt: string;
  actorRole: Exclude<ClaimPublisherRole, "renderer">;
  claim: Claim;
  evidence: EvidenceBundle;
}

export interface AcceptedClaimPolicy {
  allowPartial: boolean;
}

const REQUIRED_CLAIM_STAGES: Readonly<
  Record<Claim["kind"], readonly EvidenceStage[]>
> = {
  fact: ["raw", "replay"],
  inference: ["raw", "replay"],
  judgment: ["raw"],
};

/** A claim-specific accepted view derived from the generic evidence ledger. */
export class AcceptedClaimLedger {
  readonly #evidence = new EvidenceLedger();
  readonly #entries: AcceptedClaimEntry[] = [];

  constructor(readonly policy: AcceptedClaimPolicy) {}

  publish(input: ClaimDecision, now: Date = new Date()): AcceptedClaimEntry {
    if (input.actorRole === "renderer") {
      throw new Error("renderer cannot add or promote claims");
    }
    const claim = ClaimSchema.parse(input.claim);
    if (claim.evidenceRefs.length === 0) throw new Error("claim has missing provenance");
    if (claim.kind === "fact" && claim.asOf === undefined) {
      throw new Error("factual claim requires an as-of time");
    }
    if (claim.kind !== "fact" && claim.assumptions.length === 0) {
      throw new Error(`${claim.kind} claim requires named assumptions`);
    }
    if (input.evidence.assertionId !== claim.key) {
      throw new Error("claim key does not match evidence assertion id");
    }
    if (input.evidence.assertion !== claim.statement) {
      throw new Error("claim statement does not match evidence assertion");
    }
    if (input.evidence.assertionClass !== `claim:${claim.kind}`) {
      throw new Error(`claim kind requires assertion class claim:${claim.kind}`);
    }
    if (input.evidence.executionSnapshot === undefined) {
      throw new Error("accepted claim evidence requires an execution snapshot");
    }
    for (const stage of REQUIRED_CLAIM_STAGES[claim.kind]) {
      if (!input.evidence.requiredStages.includes(stage)) {
        throw new Error(`claim policy requires evidence stage: ${stage}`);
      }
    }
    const hashedRefs = new Set(
      Object.values(input.evidence.stages).flatMap((refs) =>
        (refs ?? []).map((entry) => entry.ref),
      ),
    );
    for (const ref of claim.evidenceRefs) {
      if (!hashedRefs.has(ref)) {
        throw new Error(`claim provenance ${ref} is not bound to hashed evidence`);
      }
    }
    if (input.evidence.status === "PARTIAL" && !this.policy.allowPartial) {
      throw new Error("delivery policy does not permit PARTIAL claims");
    }
    if (input.evidence.status !== "PROVEN" && input.evidence.status !== "PARTIAL") {
      throw new Error(`status ${input.evidence.status} cannot enter accepted claim view`);
    }

    const evidence = this.#evidence.accept(input.evidence, now);
    const entry: AcceptedClaimEntry = {
      acceptedAt: now.toISOString(),
      actorRole: input.actorRole,
      claim,
      evidence,
    };
    this.#entries.push(entry);
    return entry;
  }

  remove(actorRole: ClaimPublisherRole, _key: string): never {
    if (actorRole === "renderer") throw new Error("renderer cannot remove claims");
    throw new Error("accepted claim ledger is append-only; claims cannot be removed");
  }

  current(key: string): AcceptedClaimEntry | undefined {
    return this.#entries.findLast((entry) => entry.claim.key === key);
  }

  entries(): readonly AcceptedClaimEntry[] {
    return structuredClone(this.#entries);
  }

  static replay(
    entries: readonly AcceptedClaimEntry[],
    policy: AcceptedClaimPolicy,
  ): AcceptedClaimLedger {
    const ledger = new AcceptedClaimLedger(policy);
    for (const entry of entries) {
      ledger.publish(
        { actorRole: entry.actorRole, claim: entry.claim, evidence: entry.evidence },
        new Date(entry.acceptedAt),
      );
    }
    return ledger;
  }
}

export { EVIDENCE_STATUSES };
