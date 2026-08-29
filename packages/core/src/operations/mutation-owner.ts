/**
 * Single mutation ownership per component.
 *
 * The action lease excludes a second Helium controller. It says nothing about
 * the legacy watchdogs, which are independent host jobs outside every lease,
 * lock and event log -- and that is the one crash-matrix cell that can produce
 * a genuine duplicate production mutation.
 *
 * This module is PURE and holds no host knowledge. It knows there is such a
 * thing as a competing controller; it does not know what a service manager is,
 * and it contains no label strings. Enumerating controllers is a probe's job,
 * in the operations plugin.
 *
 * Everything here is fail-closed. `clear` is the only probe result that
 * permits a mutation; `unknown` -- from a timeout, truncated output or
 * unparseable output -- refuses, because a controller you cannot see is not a
 * controller that is absent.
 * @module @helium/core/operations/mutation-owner
 */
import type { ComponentSpec } from "./component.js";

export const CONTROLLER_PROBE_RESULTS = ["clear", "competing", "unknown"] as const;
export type ControllerProbeResult = (typeof CONTROLLER_PROBE_RESULTS)[number];

export interface ControllerProbeOutcome {
  result: ControllerProbeResult;
  /** Opaque labels observed. Core neither parses nor understands them. */
  observedLabels: string[];
  /** Persisted raw enumeration used for this exact admission decision. */
  evidenceRef: string;
  /** Why the probe could not answer, when `result` is `unknown`. */
  detail?: string;
}

export type MutationRefusal =
  | "external-owner"
  | "no-owner"
  | "competing-controller"
  | "ownership-unverifiable";

export type MutationPermission =
  | { ok: true }
  | { ok: false; reason: MutationRefusal };

/**
 * May this component be mutated right now?
 *
 * `{ ok: true }` only when the recorded owner is `opsd` AND the probe came
 * back `clear`. Every other combination is a typed refusal:
 *
 *   - `external`  -- another controller owns this component, so every mutating
 *                    SOP behaves as `forbidden` regardless of its own authority.
 *   - `none`      -- nobody has been given ownership; refuse rather than assume.
 *   - `competing` -- we hold ownership on paper and something else is loaded
 *                    anyway. That contradiction is an incident, and it is never
 *                    self-resolved by unloading the other controller.
 *   - `unknown`   -- the probe could not answer. Absence of evidence is not
 *                    evidence of absence.
 */
export function canMutate(
  component: ComponentSpec,
  probe: ControllerProbeOutcome,
): MutationPermission {
  const owner = component.mutationOwner.owner;
  if (owner === "external") return { ok: false, reason: "external-owner" };
  if (owner === "none") return { ok: false, reason: "no-owner" };

  switch (probe.result) {
    case "clear":
      return { ok: true };
    case "competing":
      return { ok: false, reason: "competing-controller" };
    case "unknown":
      return { ok: false, reason: "ownership-unverifiable" };
  }
}

/**
 * Whether a `competing` probe contradicts a recorded `opsd` ownership.
 *
 * This is an incident to raise, not a condition to fix in place. Unloading the
 * other controller would be a mutation performed to make a mutation legal, by
 * a controller that has just been shown not to have exclusive ownership.
 */
export function isOwnershipContradiction(
  component: ComponentSpec,
  probe: ControllerProbeOutcome,
): boolean {
  return component.mutationOwner.owner === "opsd" && probe.result === "competing";
}

/**
 * The ordered handoff sequence: move mutation ownership onto this controller.
 *
 * The order is the safety property. Ownership is surrendered BEFORE it is
 * claimed, so no prefix of this sequence ever has two enabled controllers --
 * and a crash in the middle leaves ZERO, which is monitored and non-mutating
 * rather than doubly-mutating.
 */
export const HANDOFF_STEPS = [
  "record-intent",
  "disable-external",
  "verify-quiescent",
  "enable-opsd",
  "record-ownership",
] as const;
export type HandoffStep = (typeof HANDOFF_STEPS)[number];

/** The reverse: give ownership back, ending with exactly one loaded controller. */
export const ROLLBACK_STEPS = [
  "record-intent",
  "disable-opsd",
  "verify-quiescent",
  "enable-external",
  "record-ownership",
] as const;
export type RollbackStep = (typeof ROLLBACK_STEPS)[number];

export interface ControllerSet {
  externalEnabled: boolean;
  opsdEnabled: boolean;
}

export const enabledCount = (set: ControllerSet): number =>
  Number(set.externalEnabled) + Number(set.opsdEnabled);

export function applyHandoffStep(
  set: ControllerSet,
  step: HandoffStep,
): ControllerSet {
  switch (step) {
    case "disable-external":
      return { ...set, externalEnabled: false };
    case "enable-opsd":
      return { ...set, opsdEnabled: true };
    case "record-intent":
    case "verify-quiescent":
    case "record-ownership":
      return { ...set };
  }
}

export function applyRollbackStep(
  set: ControllerSet,
  step: RollbackStep,
): ControllerSet {
  switch (step) {
    case "disable-opsd":
      return { ...set, opsdEnabled: false };
    case "enable-external":
      return { ...set, externalEnabled: true };
    case "record-intent":
    case "verify-quiescent":
    case "record-ownership":
      return { ...set };
  }
}

/** The controller set after each prefix of a sequence, starting with none applied. */
export function sequenceStates<S extends string>(
  initial: ControllerSet,
  steps: readonly S[],
  apply: (set: ControllerSet, step: S) => ControllerSet,
): ControllerSet[] {
  const states = [initial];
  let current = initial;
  for (const step of steps) {
    current = apply(current, step);
    states.push(current);
  }
  return states;
}
