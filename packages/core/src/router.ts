/**
 * The deterministic capability router.
 *
 *   WorkOrder capability requirements
 *     -> tools / mutations / latency / context / availability hard filter
 *     -> cheapest capable target (or a configured opaque preference)
 *     -> budget affordability, downgrading one step at a time with a reason
 *     -> selected ExecutionTargetId
 *
 * The seam that must survive is the model-blind one: capability requirements
 * in, an opaque `ExecutionTargetId` out, no vendor or model name at any step.
 *
 * v2 changes from v1 (design §8): the policy VERSION is gone -- a decision is
 * replayable from the catalog snapshot and the work order, and a version
 * string on a lookup table was ceremony -- and the cheapest-capable rule is
 * in. Isolation class is no longer a routing input; blast radius is the
 * sandbox kind.
 *
 * The function is pure and side-effect free. Availability, including quota
 * state and `retryAfter`, is resolved into the catalog snapshot by the caller;
 * this module never polls.
 * @module @helium/core/router
 */
import type {
  CatalogSnapshot,
  ExecutionTargetId,
  TargetSnapshot,
} from "./capabilities.js";
import type { WorkOrder } from "./work.js";

export interface RolePolicy {
  /** Walked in order; the first eligible AND affordable entry wins. */
  preferred: ExecutionTargetId;
  fallback: ExecutionTargetId[];
}

export interface SelectionPolicy {
  roles: Record<string, RolePolicy>;
}

/**
 * What the caller projects this one step will consume. Supplied by the budget
 * layer; without it the router ranks on blended per-token price alone and
 * never reports `budget-exhausted`.
 */
export interface BudgetProjection {
  remainingUsd: number;
  projectedInputTokens: number;
  projectedOutputTokens: number;
}

export interface CandidateDecision {
  targetId: string;
  eligible: boolean;
  /** Named exclusion reasons, in a fixed order. Empty when eligible. */
  reasons: string[];
  /** Projected USD for this step; absent when the target is not metered. */
  projectedUsd?: number;
}

export interface SelectionDecision {
  selected?: ExecutionTargetId;
  candidates: CandidateDecision[];
  /** How the winner was chosen. */
  basis?: "preference" | "cheapest-capable";
  /**
   * Present only when a cheaper target was taken because the one the ranking
   * would otherwise have chosen did not fit the remaining budget. Never
   * inferred after the fact; written at the moment the step was skipped.
   */
  downgradeReason?: string;
  failure?: {
    class: "capability-shortage" | "unavailable" | "budget-exhausted";
    reasons: string[];
  };
}

/**
 * Blended per-token price. An UNPRICED target sorts last, not first: absent
 * price means "not metered", and treating it as zero would make every
 * flat-rate subscription automatically outrank a cheap metered model.
 */
function rank(target: TargetSnapshot): number {
  return target.price === undefined
    ? Number.POSITIVE_INFINITY
    : target.price.usdIn + target.price.usdOut;
}

function projectedUsd(
  target: TargetSnapshot,
  budget: BudgetProjection | undefined,
): number | undefined {
  if (target.price === undefined || budget === undefined) return undefined;
  // The preamble is input the caller never wrote but always pays for.
  const input =
    budget.projectedInputTokens + (target.price.overheadInputTokens ?? 0);
  return (
    target.price.usdIn * input +
    target.price.usdOut * budget.projectedOutputTokens
  );
}

/** Every reason one target failed the hard filter, in a stable order. */
function exclusions(work: WorkOrder, target: TargetSnapshot): string[] {
  const reasons: string[] = [];
  const tags = new Set(target.capabilities);
  if (!work.requires.every((tag) => tags.has(tag))) reasons.push("capability");

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

  // Availability last, and named: "quota-exhausted" is dynamic availability
  // with a deadline, not the same condition as a target that is simply down.
  // Collapsing them would lose the retryAfter the caller needs.
  if (!target.available) {
    reasons.push(
      target.availability.state === "quota-exhausted"
        ? "quota-exhausted"
        : "unavailable",
    );
  }

  return reasons;
}

/** Whether a projected step fits what is left, given the order's own ceiling. */
function affordable(
  usd: number | undefined,
  work: WorkOrder,
  budget: BudgetProjection | undefined,
): boolean {
  if (usd === undefined) return true;
  if (work.constraints.maxCost !== undefined && usd > work.constraints.maxCost) {
    return false;
  }
  return budget === undefined || usd <= budget.remainingUsd;
}

/**
 * Resolve one work order to an opaque execution target.
 *
 * @param work - capability requirements and hard constraints.
 * @param catalog - a catalog snapshot with availability already resolved.
 * @param options - an optional per-role preference and the budget projection.
 * @returns the decision, including every candidate's eligibility and reasons.
 * An empty surviving set yields `capability-shortage`; a surviving set none of
 * which fits the budget yields `budget-exhausted`. No requirement is ever
 * relaxed and no context is ever silently truncated to produce a selection.
 */
export function select(
  work: WorkOrder,
  catalog: CatalogSnapshot,
  options: { policy?: SelectionPolicy; budget?: BudgetProjection } = {},
): SelectionDecision {
  const { policy, budget } = options;
  const decided = catalog.targets.map((target) => {
    const reasons = exclusions(work, target);
    return {
      target,
      reasons,
      eligible: reasons.length === 0,
      usd: projectedUsd(target, budget),
    };
  });

  // Eligible first, then cheapest, then stable target id. A stable order is
  // what makes a recorded decision replayable.
  const ordered = [...decided].sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      rank(a.target) - rank(b.target) ||
      (a.target.targetId < b.target.targetId ? -1 : 1),
  );

  const candidates: CandidateDecision[] = ordered.map((entry) => ({
    targetId: entry.target.targetId,
    eligible: entry.eligible,
    reasons: entry.reasons,
    ...(entry.usd === undefined ? {} : { projectedUsd: entry.usd }),
  }));

  const eligible = ordered.filter((entry) => entry.eligible);
  if (eligible.length === 0) {
    const dynamic = new Set(["quota-exhausted", "unavailable"]);
    const capacityOnly =
      decided.length > 0 &&
      decided.every((entry) => entry.reasons.every((r) => dynamic.has(r)));
    return {
      candidates,
      failure: {
        class: capacityOnly ? "unavailable" : "capability-shortage",
        reasons:
          decided.length === 0
            ? ["no registered target"]
            : decided.map(
                (entry) =>
                  `${entry.target.targetId}: ${entry.reasons.join(", ")}`,
              ),
      },
    };
  }

  // A configured preference is a LOOKUP, not a weight: it either survives the
  // hard filter and the budget, or the walk advances. There is no boost that
  // outranks a hard requirement.
  const preference = policy?.roles[work.role];
  const walk =
    preference === undefined
      ? eligible
      : [preference.preferred, ...preference.fallback].flatMap((id) => {
          const entry = eligible.find((e) => e.target.targetId === id);
          return entry === undefined ? [] : [entry];
        });

  if (walk.length === 0) {
    return {
      candidates,
      failure: {
        class: "capability-shortage",
        reasons: [`no eligible configured target for role ${work.role}`],
      },
    };
  }

  const index = walk.findIndex((entry) => affordable(entry.usd, work, budget));
  if (index === -1) {
    return {
      candidates,
      failure: {
        class: "budget-exhausted",
        reasons: walk.map(
          (entry) =>
            `${entry.target.targetId}: projected ${entry.usd?.toFixed(6) ?? "?"} USD exceeds remaining ${budget?.remainingUsd.toFixed(6) ?? "?"}`,
        ),
      },
    };
  }

  const winner = walk[index]!;
  const base: SelectionDecision = {
    candidates,
    selected: winner.target.targetId as ExecutionTargetId,
    basis: preference === undefined ? "cheapest-capable" : "preference",
  };
  if (index === 0) return base;
  const skipped = walk[index - 1]!;
  return {
    ...base,
    downgradeReason: `${skipped.target.targetId} projected ${skipped.usd?.toFixed(6) ?? "?"} USD over the remaining ${budget?.remainingUsd.toFixed(6) ?? "?"}; downgraded to ${winner.target.targetId}`,
  };
}
