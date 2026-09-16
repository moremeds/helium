export type MeasureVector = Readonly<Record<string, number>>;

export interface UtilityPolicy {
  readonly constraint: Readonly<{
    metric: string;
    minimum?: number;
    upperBound: number;
  }>;
  readonly objectives: readonly Readonly<{
    metric: string;
    direction: "higher" | "lower";
    epsilon: number;
  }>[];
}

export interface UtilityComparison {
  readonly eligible: boolean;
  readonly improved: boolean;
  readonly feasible: boolean;
  readonly reason:
    | "invalid-measure"
    | "feasibility-improved"
    | "feasibility-regressed"
    | "constraint-improved"
    | "constraint-regressed"
    | "objective-improved"
    | "objective-regressed"
    | "no-significant-improvement";
}

export interface StopPolicy {
  readonly maxCalls?: number;
  readonly maxElapsedMs?: number;
  readonly stalledCandidates: number;
}

export interface StopState {
  /** True only after the caller has explicitly confirmed the target. */
  readonly targetVerified: boolean;
  readonly callsUsed: number;
  readonly elapsedMs: number;
  /** Comparisons must be against the incumbent current at that attempt. */
  readonly completed: readonly UtilityComparison[];
}

export interface StopDecision {
  readonly stop: boolean;
  readonly reason: "target_verified" | "budget_exhausted" | "stalled" | "continue";
}

function metric(name: unknown, value: unknown): number {
  if (typeof name !== "string" || name.length === 0 ||
      typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`invalid utility metric: ${String(name || "<empty>")}`);
  return value;
}

function validatePolicy(policy: UtilityPolicy): void {
  metric(policy.constraint.metric, policy.constraint.upperBound);
  if (policy.constraint.minimum !== undefined) {
    metric(policy.constraint.metric, policy.constraint.minimum);
    if (policy.constraint.minimum > policy.constraint.upperBound)
      throw new Error("constraint minimum exceeds upper bound");
  }
  if (policy.objectives.length === 0) throw new Error("utility policy needs an objective");
  for (const objective of policy.objectives) {
    metric(objective.metric, objective.epsilon);
    if (objective.direction !== "higher" && objective.direction !== "lower")
      throw new Error(`invalid objective direction: ${String(objective.direction)}`);
    if (objective.epsilon < 0) throw new Error(`negative epsilon: ${objective.metric}`);
  }
}

function measures(policy: UtilityPolicy, values: unknown): readonly number[] | undefined {
  if (typeof values !== "object" || values === null) return undefined;
  const names = [policy.constraint.metric, ...policy.objectives.map((objective) => objective.metric)];
  const result = names.map((name) => (values as MeasureVector)[name]);
  return result.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    (policy.constraint.minimum === undefined || (result[0] as number) >= policy.constraint.minimum)
    ? result as number[]
    : undefined;
}

/** Compares one candidate with its fixed base or current incumbent. */
export function compareUtility(
  policy: UtilityPolicy,
  base: MeasureVector,
  candidate: MeasureVector,
): UtilityComparison {
  validatePolicy(policy);
  const before = measures(policy, base);
  const after = measures(policy, candidate);
  if (!before || !after)
    return { eligible: false, improved: false, feasible: false, reason: "invalid-measure" };

  const baseViolation = Math.max(0, before[0]! - policy.constraint.upperBound);
  const candidateViolation = Math.max(0, after[0]! - policy.constraint.upperBound);
  const baseFeasible = baseViolation === 0;
  const feasible = candidateViolation === 0;

  if (feasible !== baseFeasible)
    return feasible
      ? { eligible: true, improved: true, feasible, reason: "feasibility-improved" }
      : { eligible: true, improved: false, feasible, reason: "feasibility-regressed" };

  if (!feasible && candidateViolation !== baseViolation)
    return candidateViolation < baseViolation
      ? { eligible: true, improved: true, feasible, reason: "constraint-improved" }
      : { eligible: true, improved: false, feasible, reason: "constraint-regressed" };

  for (let index = 0; index < policy.objectives.length; index += 1) {
    const objective = policy.objectives[index]!;
    const delta = objective.direction === "higher"
      ? after[index + 1]! - before[index + 1]!
      : before[index + 1]! - after[index + 1]!;
    if (Math.abs(delta) <= objective.epsilon) continue;
    return delta > 0
      ? { eligible: true, improved: true, feasible, reason: "objective-improved" }
      : { eligible: true, improved: false, feasible, reason: "objective-regressed" };
  }

  return { eligible: true, improved: false, feasible, reason: "no-significant-improvement" };
}

function nonnegative(name: string, value: number, integer = false): void {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
    throw new Error(`invalid ${name}: ${String(value)}`);
}

export function evaluateStop(policy: StopPolicy, state: StopState): StopDecision {
  if (!Number.isSafeInteger(policy.stalledCandidates) || policy.stalledCandidates <= 0)
    throw new Error(`invalid stalledCandidates: ${String(policy.stalledCandidates)}`);
  if (policy.maxCalls === undefined && policy.maxElapsedMs === undefined)
    throw new Error("stop policy needs a finite budget");
  if (policy.maxCalls !== undefined) nonnegative("maxCalls", policy.maxCalls, true);
  if (policy.maxElapsedMs !== undefined) nonnegative("maxElapsedMs", policy.maxElapsedMs);
  nonnegative("callsUsed", state.callsUsed, true);
  nonnegative("elapsedMs", state.elapsedMs);
  if (typeof state.targetVerified !== "boolean")
    throw new Error(`invalid targetVerified: ${String(state.targetVerified)}`);
  for (const result of state.completed) {
    if (typeof result !== "object" || result === null ||
        typeof result.eligible !== "boolean" || typeof result.improved !== "boolean" ||
        typeof result.feasible !== "boolean")
      throw new Error("invalid completed utility comparison");
  }

  if (state.targetVerified) return { stop: true, reason: "target_verified" };
  if ((policy.maxCalls !== undefined && state.callsUsed >= policy.maxCalls) ||
      (policy.maxElapsedMs !== undefined && state.elapsedMs >= policy.maxElapsedMs))
    return { stop: true, reason: "budget_exhausted" };

  let stalled = 0;
  for (const result of state.completed) {
    if (!result.eligible) continue;
    stalled = result.improved ? 0 : stalled + 1;
  }
  return stalled >= policy.stalledCandidates
    ? { stop: true, reason: "stalled" }
    : { stop: false, reason: "continue" };
}
