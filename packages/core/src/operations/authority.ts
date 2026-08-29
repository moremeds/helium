/**
 * The authority policy: may this SOP run against this incident, right now?
 *
 * Pure and fail-closed. It decides; it never executes, and it never reaches a
 * probe or a clock of its own. Every refusal is a NAMED reason, because an
 * operator reading "not eligible" learns nothing and an operator reading
 * "cooldown" knows exactly what to wait for.
 *
 * DEVIATION from the plan's sketch, and a deliberate one: preconditions arrive
 * as `checkResults`, already evaluated, rather than as raw `observations`.
 * Turning an observation into a check result means running a probe, which is
 * the verifier's job two tasks later; doing it here would either drag I/O into
 * a pure policy or force this module to invent a probe-value convention before
 * any probe exists. The incident is what the policy branches on, and it
 * already carries its contributing observation ids.
 * @module @helium/core/operations/authority
 */
import type { CheckResult } from "./check.js";
import type { Incident } from "./incident.js";
import type { ActionOutcome } from "./action.js";
import type { SopAuthority, SopDefinition } from "./sop.js";

export interface AttemptRecord {
  sopId: string;
  incidentId: string;
  at: string;
  outcome: ActionOutcome;
}

export interface OperatorApproval {
  incidentId: string;
  sopId: string;
  sopVersion: number;
  sopDigest: string;
  expiresAt: string;
}

export interface MaintenanceWindow {
  from: string;
  to: string;
}

export interface AuthorityInput {
  sop: SopDefinition;
  incident: Incident;
  /** One result per referenced check id. A missing entry is not a pass. */
  checkResults: Record<string, CheckResult>;
  history: AttemptRecord[];
  now: Date;
  approval?: OperatorApproval;
  maintenanceWindows?: MaintenanceWindow[];
}

export interface AuthorityDecision {
  eligible: boolean;
  authority: SopAuthority;
  /** Named refusals, in evaluation order. Empty when eligible. */
  reasons: string[];
}

/** The only three values the policy may resolve to. */
export function disposition(
  decision: AuthorityDecision,
): "eligible" | "approval-required" | "rejected" {
  if (!decision.eligible) return "rejected";
  return decision.authority === "approve" ? "approval-required" : "eligible";
}

export function decideAuthority(input: AuthorityInput): AuthorityDecision {
  const { sop, incident, checkResults, history, now } = input;
  const reasons: string[] = [];
  const at = now.getTime();

  if (sop.authority === "forbidden") reasons.push("authority-forbidden");
  if (sop.authority === "observe") reasons.push("authority-observe");

  if (incident.state !== "action-eligible") {
    reasons.push("incident-not-action-eligible");
  }
  if (sop.componentId !== incident.rootComponentId) {
    reasons.push("component-mismatch");
  }
  if (sop.matches.dimension !== incident.dimension) {
    reasons.push("dimension-mismatch");
  }
  if (sop.matches.failureClass !== incident.failureClass) {
    reasons.push("failure-class-mismatch");
  }

  // A precondition that failed, could not be evaluated, or was never evaluated
  // has not passed. All three are the same refusal.
  for (const ref of sop.preconditions) {
    const result = checkResults[ref];
    if (result !== "pass") {
      reasons.push(`precondition-${result ?? "missing"}:${ref}`);
    }
  }

  // `not-needed` still consumes an attempt: otherwise a component that keeps
  // looking healthy at baseline lets the controller loop forever. It is
  // excluded from automation CREDIT elsewhere, which is a different question.
  const attempts = history.filter(
    (h) => h.sopId === sop.id && h.incidentId === incident.key,
  );
  if (attempts.length >= sop.maxAttempts) reasons.push("max-attempts");

  const last = attempts
    .map((a) => Date.parse(a.at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  if (last !== undefined && at - last < sop.cooldownMs) reasons.push("cooldown");

  for (const window of input.maintenanceWindows ?? []) {
    if (Date.parse(window.from) <= at && at < Date.parse(window.to)) {
      reasons.push("maintenance-window");
    }
  }

  if (sop.authority === "approve") {
    reasons.push(...approvalReasons(sop, incident, input.approval, at));
  }

  return { eligible: reasons.length === 0, authority: sop.authority, reasons };
}

function approvalReasons(
  sop: SopDefinition,
  incident: Incident,
  approval: OperatorApproval | undefined,
  at: number,
): string[] {
  if (approval === undefined) return ["approval-missing"];
  const reasons: string[] = [];
  // An approval is bound to one incident, one SOP, one version AND one digest.
  // Version alone is not enough: an SOP can be edited without its version
  // moving, and the approval would still look current.
  if (approval.incidentId !== incident.key) reasons.push("approval-incident-mismatch");
  if (approval.sopId !== sop.id) reasons.push("approval-sop-mismatch");
  if (approval.sopVersion !== sop.version) reasons.push("approval-version-mismatch");
  if (approval.sopDigest !== sop.digest) reasons.push("approval-digest-mismatch");
  if (Date.parse(approval.expiresAt) <= at) reasons.push("approval-expired");
  return reasons;
}

export interface ArbitrationResult {
  selected?: SopDefinition;
  /** Ids of equally ranked candidates in one exclusive group. */
  ambiguous?: string[];
}

/**
 * Order eligible SOPs by explicit priority, then match specificity, then
 * stable id.
 *
 * Two equally ranked candidates in the SAME exclusive group is the case where
 * guessing would run the wrong repair, so the result is `ambiguous` and NOTHING
 * is selected. Outside an exclusive group a tie is broken by id, which is
 * arbitrary but deterministic and replayable.
 */
export function arbitrate(candidates: SopDefinition[]): ArbitrationResult {
  if (candidates.length === 0) return { selected: undefined, ambiguous: undefined };

  const specificity = (sop: SopDefinition): number =>
    sop.exclusiveGroup === undefined ? 0 : 1;

  const ranked = [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      specificity(b) - specificity(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const top = ranked[0];
  const tied = ranked.filter(
    (s) =>
      s.priority === top.priority &&
      specificity(s) === specificity(top) &&
      s.exclusiveGroup !== undefined &&
      s.exclusiveGroup === top.exclusiveGroup,
  );
  if (tied.length > 1) {
    return { selected: undefined, ambiguous: tied.map((s) => s.id).sort() };
  }
  return { selected: top };
}
