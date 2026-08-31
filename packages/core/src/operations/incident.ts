/**
 * Incident vocabulary and the deterministic dedupe key.
 *
 * The incident state enum is DISJOINT from the action outcome enum (design
 * sections 6.2 and 6.5, review XDOC-9): `recovered` and `escalated` are
 * incident states and are never action outcomes. Keeping them apart is what
 * stops "the component is healthy again" from being recorded as "my action
 * succeeded".
 * @module @helium/core/operations/incident
 */
import type { ObservationState } from "./observation.js";

export const INCIDENT_STATES = [
  "open",
  "diagnosing",
  "action-eligible",
  "recovering",
  "verifying",
  "recovered",
  "failed",
  "uncertain",
  "escalated",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

/**
 * Anything that is not `ok`. `unknown` is one of them: absence of proof is a
 * failure class, not a neutral state.
 *
 * Deliberately NOT named `FailureClass`. `work.ts` already owns that name for
 * why an agent RUN failed -- timeout, quota-exhausted, provider-error. This is
 * which observation state characterizes an INCIDENT. Two different planes; one
 * shared name in the barrel export would be an ambiguity a reader resolves
 * wrongly.
 */
export type IncidentFailureClass = Exclude<ObservationState, "ok">;

export interface Incident {
  /** Stable across runs; see {@link incidentKey}. */
  key: string;
  /** Optional exact work scope for callers that schedule a bounded repair. */
  scopeId?: string;
  rootComponentId: string;
  /** Components inhibited under this root, sorted. Never the root itself. */
  symptomComponentIds: string[];
  dimension: string;
  failureClass: IncidentFailureClass;
  state: IncidentState;
  /**
   * Every contributing observation, INCLUDING the inhibited children's.
   * Inhibition suppresses a redundant incident, never the evidence: recovery
   * verification has to be able to watch the children come back.
   */
  observationIds: string[];
  openedAt: string;
  updatedAt: string;
}

export interface Inhibition {
  child: string;
  parent: string;
  reason: "dependency-root-failing";
}

/**
 * Deterministic dedupe key: component, dimension, failure class, and the
 * active dependency root. The root is part of the key because the same
 * component failing on its own is a different incident from the same component
 * failing because its dependency did.
 */
export function incidentKey(parts: {
  componentId: string;
  dimension: string;
  failureClass: IncidentFailureClass;
  rootComponentId: string;
  scopeId?: string;
}): string {
  if (
    parts.scopeId !== undefined &&
    (parts.scopeId.length === 0 || parts.scopeId.length > 256 || parts.scopeId.includes("|"))
  ) {
    throw new Error("incident scope id must be an opaque bounded value without the key delimiter");
  }
  const base = [
    parts.componentId,
    parts.dimension,
    parts.failureClass,
    parts.rootComponentId,
  ];
  return (parts.scopeId === undefined ? base : [...base, parts.scopeId]).join("|");
}
