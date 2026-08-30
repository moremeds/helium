/**
 * The thin deterministic selector.
 *
 *   WorkOrder capability requirements
 *     -> isolation / tools / quota / availability hard filter
 *     -> configured opaque target preference
 *     -> ordered fallback
 *     -> selected ExecutionTargetId
 *
 * Nothing is scored. Weighted capability scoring, evaluation confidence as a
 * routing input, cost/latency/reliability weighting, bounded preference boosts
 * that reorder eligible targets, and learned tie-breaks are all deferred v2
 * pending real usage data. The preference in v1 is a LOOKUP, not a weight: it
 * either survives the hard filter or the fallback list advances. There is no
 * boost that outranks a hard requirement.
 *
 * The seam that must survive is the model-blind one -- capability
 * requirements in, an opaque `ExecutionTargetId` out, no provider or model
 * name at any step. Scoring can be added behind that seam later without
 * changing the work-order or lease contract.
 *
 * The function is pure and side-effect free. Availability, including quota
 * state and `retryAfter`, is resolved into the catalog snapshot by the caller;
 * this module never polls.
 * @module @helium/core/router
 */
import type { CatalogSnapshot, ExecutionTargetId, TargetSnapshot } from "./capabilities.js";
import { ISOLATION_CLASSES, type WorkOrder } from "./work.js";

/** Higher admits everything lower; a target may exceed what work requires. */
const ISOLATION_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  ISOLATION_CLASSES.map((c, i) => [c, i]),
);

export interface RolePolicy {
  preferred: ExecutionTargetId;
  /** Walked in order when the preference does not survive the hard filter. */
  fallback: ExecutionTargetId[];
}

export interface SelectionPolicy {
  policyVersion: string;
  roles: Record<string, RolePolicy>;
}

export interface CandidateDecision {
  targetId: string;
  eligible: boolean;
  /** Named exclusion reasons, in a fixed order. Empty when eligible. */
  reasons: string[];
}

export interface SelectionDecision {
  selected?: ExecutionTargetId;
  candidates: CandidateDecision[];
  /** Index into [preferred, ...fallback]; 0 means the preference won. */
  fallbackPosition?: number;
  failure?: {
    class: "capability-shortage" | "unavailable";
    reasons: string[];
  };
  policyVersion: string;
  catalogVersion: string;
}

/** Every reason one target failed the hard filter, in a stable order. */
function exclusions(work: WorkOrder, target: TargetSnapshot): string[] {
  const reasons: string[] = [];
  const tags = new Set(target.capabilities);
  if (!work.requires.every((tag) => tags.has(tag))) reasons.push("capability");

  if (
    ISOLATION_RANK[target.isolationClass] <
    ISOLATION_RANK[work.constraints.minIsolationClass]
  ) {
    reasons.push("isolation");
  }

  if (work.constraints.tools.length > 0 && !target.supports.toolIsolation) {
    reasons.push("tool-isolation");
  }

  if (work.constraints.mutations === "permitted" && !target.supports.mutations) {
    reasons.push("mutations");
  }

  const { maxLatencyMs, maxContextTokens } = work.constraints;
  if (
    maxLatencyMs !== undefined &&
    target.operations.maxLatencyMs !== undefined &&
    target.operations.maxLatencyMs > maxLatencyMs
  ) {
    reasons.push("latency");
  }
  if (
    maxContextTokens !== undefined &&
    target.operations.maxContextTokens !== undefined &&
    target.operations.maxContextTokens < maxContextTokens
  ) {
    reasons.push("context");
  }

  // Availability last, and named: "quota-exhausted" is dynamic provider
  // availability with a deadline, not the same condition as a target that is
  // simply down. Collapsing them would lose the retryAfter the caller needs.
  if (!target.available) {
    reasons.push(
      target.availability.state === "quota-exhausted"
        ? "quota-exhausted"
        : "unavailable",
    );
  }

  return reasons;
}

/**
 * Resolve one work order to an opaque execution target.
 *
 * @param work - capability requirements and hard constraints.
 * @param policy - the configured per-role preference and ordered fallback.
 * @param catalog - a catalog snapshot with availability already resolved.
 * @returns the decision, including every candidate's eligibility and reasons.
 * An empty surviving set yields `capability-shortage`; no requirement is ever
 * relaxed to produce a selection.
 */
export function select(
  work: WorkOrder,
  policy: SelectionPolicy,
  catalog: CatalogSnapshot,
): SelectionDecision {
  const decided = catalog.targets.map((target) => {
    const reasons = exclusions(work, target);
    return { target, reasons, eligible: reasons.length === 0 };
  });

  // Eligible first, then stable target id. With nothing scored there are few
  // ties left, and a stable order is what makes a recorded decision replayable.
  const candidates: CandidateDecision[] = [...decided]
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        (a.target.targetId < b.target.targetId ? -1 : 1),
    )
    .map(({ target, eligible, reasons }) => ({
      targetId: target.targetId,
      eligible,
      reasons,
    }));

  const base = {
    candidates,
    policyVersion: policy.policyVersion,
    catalogVersion: catalog.catalogVersion,
  };

  const role = policy.roles[work.role];
  if (role === undefined) {
    return {
      ...base,
      failure: {
        class: "capability-shortage",
        reasons: [`no configured target for role ${work.role}`],
      },
    };
  }

  const eligible = new Set(
    decided.filter((d) => d.eligible).map((d) => d.target.targetId),
  );
  const ordered = [role.preferred, ...role.fallback];
  const position = ordered.findIndex((id) => eligible.has(id));

  if (position === -1) {
    const byId = new Map(decided.map((entry) => [entry.target.targetId, entry]));
    const orderedFailures = ordered.map((targetId) => {
      const entry = byId.get(targetId);
      return entry === undefined
        ? { targetId, reasons: ["missing-target"] }
        : { targetId, reasons: entry.reasons };
    });
    const dynamic = new Set(["quota-exhausted", "unavailable"]);
    const capacityOnly = orderedFailures.every(
      (entry) =>
        entry.reasons.length > 0 &&
        entry.reasons.every((reason) => dynamic.has(reason)),
    );
    return {
      ...base,
      failure: {
        class: capacityOnly ? "unavailable" : "capability-shortage",
        reasons: orderedFailures.map(
          (entry) => `${entry.targetId}: ${entry.reasons.join(", ")}`,
        ),
      },
    };
  }

  return { ...base, selected: ordered[position], fallbackPosition: position };
}
