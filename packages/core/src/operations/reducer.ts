/**
 * The operations reducer: a pure fold from the event log to current state.
 *
 * The rule this module exists to enforce is the one the audited
 * container-runtime incident taught: **time proximity is not action
 * provenance**. An action does
 * not become a success because the component later looked healthy. An operator
 * intervention on the component supersedes any action still in flight, and the
 * later verification cannot take the credit back.
 * @module @helium/core/operations/reducer
 */
import type { ActionOutcome } from "./action.js";
import type { Attribution, OperationsEvent } from "./events.js";
import type { IncidentState } from "./incident.js";
import type { MutationOwnership } from "./component.js";
import type { AuthorityManifestEntry } from "./authority-manifest.js";
import type { Observation } from "./observation.js";
import type { PostconditionSample } from "./action.js";
import type { ControllerProbeOutcome } from "./mutation-owner.js";
import type { EvidenceRef } from "../evidence/bundle.js";
import type { CheckDefinition } from "./check.js";

/** Non-terminal action states, plus the six terminal outcomes. */
export const ACTION_PROGRESS = [
  "proposed",
  "authorized",
  "intent-recorded",
  "executed",
] as const;
export type ActionProgress = (typeof ACTION_PROGRESS)[number];
export type ActionState = ActionProgress | ActionOutcome;

export interface ActionProjection {
  actionId: string;
  incidentId: string;
  componentId: string;
  sopId: string;
  sopVersion: number;
  sopDigest: string;
  state: ActionState;
  attribution?: Attribution;
  authority?: string;
  authorityManifestEntry?: AuthorityManifestEntry;
  leaseId?: string;
  operationId?: string;
  argv?: string[];
  scopeId?: string;
  inputArtifacts?: Array<{ ref: string; sha256: string }>;
  baseline?: { capturedAt: string; samples: PostconditionSample[]; allPassing: boolean };
  controllerProbe?: ControllerProbeOutcome;
  eligibility?: { eligible: boolean; reasons: string[] };
  mutationOwner?: MutationOwnership;
  dependencyIds?: string[];
  verificationPolicy?: { postconditions: CheckDefinition[]; graceMs: number };
  childPid?: number;
  childAdoptedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputDigest?: string;
  outputTail?: string;
  outputBytes?: number;
  startedAt?: string;
  finishedAt?: string;
  postconditionSamples?: PostconditionSample[];
  recoveryEvidence?: EvidenceRef & {
    schema: "helium.ops.recovery-evidence/v1";
    assertionId: string;
  };
  /** Set when an operator intervened while this action was still in flight. */
  supersededAt?: string;
}

export interface IncidentProjection {
  incidentId: string;
  componentId: string;
  dimension: string;
  state: IncidentState;
  observationIds: string[];
}

export interface AlertProjection {
  incidentId: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  at: string;
}

export interface OperationsState {
  observations: Record<string, Observation>;
  /** componentId -> current mutation ownership, as last recorded by an event. */
  ownership: Record<string, MutationOwnership>;
  incidents: Record<string, IncidentProjection>;
  actions: Record<string, ActionProjection>;
  alerts: AlertProjection[];
  interventions: { componentId: string; kind: string; at: string; confirmed: boolean }[];
  analysis: {
    analysisId: string;
    status: "available" | "unavailable";
    consecutiveFailures: number;
    reason?: string;
    retryAt?: string;
    at: string;
  }[];
  controllerCycles: {
    controllerId: string;
    releaseRef: string;
    observationCount: number;
    collectionFailureCount: number;
    at: string;
  }[];
}

const TERMINAL = new Set<ActionState>([
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
]);

/** Which progress state each event may legally advance an action from. */
const REQUIRED_PRIOR: Readonly<Record<string, ActionState[]>> = {
  "action-authorized": ["proposed"],
  "action-intent-recorded": ["authorized"],
  "action-child-adopted": ["intent-recorded"],
  "action-receipt-recorded": ["intent-recorded"],
};

export function emptyOperationsState(): OperationsState {
  return {
    observations: {},
    ownership: {},
    incidents: {},
    actions: {},
    alerts: [],
    interventions: [],
    analysis: [],
    controllerCycles: [],
  };
}

/**
 * Fold events into state.
 *
 * @throws on a duplicate event id or an illegal transition. Both are
 * corruption rather than a condition to route around: a log that advanced an
 * action from a state it was never in cannot be replayed to the same answer.
 */
export function reduceOperations(
  events: OperationsEvent[],
  initial: OperationsState = emptyOperationsState(),
): OperationsState {
  const state: OperationsState = {
    observations: { ...initial.observations },
    ownership: { ...initial.ownership },
    incidents: { ...initial.incidents },
    actions: { ...initial.actions },
    alerts: [...initial.alerts],
    interventions: [...initial.interventions],
    analysis: [...initial.analysis],
    controllerCycles: [...initial.controllerCycles],
  };
  const seen = new Set<string>();

  for (const event of events) {
    if (seen.has(event.id)) {
      throw new Error(`duplicate operations event id: ${event.id}`);
    }
    seen.add(event.id);

    const required = REQUIRED_PRIOR[event.type];
    if (required !== undefined) {
      const actionId = (event as { actionId: string }).actionId;
      const current = state.actions[actionId];
      if (current === undefined) {
        throw new Error(`${event.type} for unknown action: ${actionId}`);
      }
      if (!required.includes(current.state)) {
        throw new Error(
          `illegal transition: ${event.type} requires ${required.join("|")}, action ${actionId} is ${current.state}`,
        );
      }
    }

    switch (event.type) {
      case "observation-recorded":
        state.observations[event.observation.id] = event.observation;
        break;

      case "incident-opened":
        state.incidents[event.incidentId] = {
          incidentId: event.incidentId,
          componentId: event.componentId,
          dimension: event.dimension,
          state: "open",
          observationIds: [...event.observationIds],
        };
        break;

      case "incident-updated": {
        const incident = state.incidents[event.incidentId];
        if (incident === undefined) {
          throw new Error(`incident-updated for unknown incident: ${event.incidentId}`);
        }
        incident.state = event.state;
        break;
      }

      case "action-proposed":
        if (state.actions[event.actionId] !== undefined) {
          throw new Error(`action already proposed: ${event.actionId}`);
        }
        state.actions[event.actionId] = {
          actionId: event.actionId,
          incidentId: event.incidentId,
          componentId: event.componentId,
          sopId: event.sopId,
          sopVersion: event.sopVersion,
          sopDigest: event.sopDigest,
          ...(event.scopeId === undefined ? {} : { scopeId: event.scopeId }),
          ...(event.proposedAuthority === undefined ? {} : { authority: event.proposedAuthority }),
          ...(event.proposedAuthorityManifestEntry === undefined
            ? {}
            : { authorityManifestEntry: { ...event.proposedAuthorityManifestEntry } }),
          state: "proposed",
        };
        break;

      case "action-authorized": {
        const action = state.actions[event.actionId];
        action.state = "authorized";
        action.authority = event.authority;
        if (event.authorityManifestEntry !== undefined) {
          action.authorityManifestEntry = { ...event.authorityManifestEntry };
        }
        break;
      }

      case "action-intent-recorded": {
        const action = state.actions[event.actionId];
        action.state = "intent-recorded";
        action.leaseId = event.leaseId;
        action.operationId = event.operationId;
        action.argv = [...event.argv];
        if (event.scopeId !== undefined && event.inputArtifacts !== undefined) {
          if (action.scopeId !== undefined && action.scopeId !== event.scopeId) {
            throw new Error(`action intent scope differs from proposal: ${event.actionId}`);
          }
          action.scopeId = event.scopeId;
          action.inputArtifacts = event.inputArtifacts.map((artifact) => ({ ...artifact }));
        }
        action.baseline = {
          capturedAt: event.baseline.capturedAt,
          samples: event.baseline.samples.map((sample) => ({
            ...sample,
            evidenceRefs: [...sample.evidenceRefs],
          })),
          allPassing: event.baseline.allPassing,
        };
        action.controllerProbe = {
          ...event.controllerProbe,
          observedLabels: [...event.controllerProbe.observedLabels],
        };
        action.eligibility = {
          eligible: event.eligibility.eligible,
          reasons: [...event.eligibility.reasons],
        };
        action.mutationOwner = {
          ...event.mutationOwner,
          competingLabels: [...event.mutationOwner.competingLabels],
        };
        action.dependencyIds = [...event.dependencyIds];
        action.verificationPolicy = {
          postconditions: event.verificationPolicy.postconditions.map((check) => ({
            ...check,
            probe: { ...check.probe, args: { ...check.probe.args } },
            expect: { ...check.expect },
          })),
          graceMs: event.verificationPolicy.graceMs,
        };
        break;
      }

      case "action-receipt-recorded": {
        const action = state.actions[event.actionId];
        // A receipt records the PROCESS result and advances no further. A zero
        // exit is not a verification; the postcondition set decides that.
        action.state = "executed";
        action.exitCode = event.exitCode;
        action.timedOut = event.timedOut;
        action.outputDigest = event.outputDigest;
        action.outputTail = event.outputTail;
        action.outputBytes = event.outputBytes;
        action.startedAt = event.startedAt;
        action.finishedAt = event.finishedAt;
        break;
      }

      case "action-child-adopted": {
        const action = state.actions[event.actionId];
        action.childPid = event.pid;
        action.childAdoptedAt = event.at;
        break;
      }

      case "operator-intervened": {
        state.interventions.push({
          componentId: event.componentId,
          kind: event.kind,
          at: event.at,
          confirmed: event.confirmed,
        });
        // Any action still in flight on this component is superseded. The
        // controller may not later claim the recovery that follows.
        for (const action of Object.values(state.actions)) {
          if (action.componentId !== event.componentId) continue;
          if (TERMINAL.has(action.state)) continue;
          action.supersededAt = event.at;
        }
        break;
      }

      case "action-verified": {
        const action = state.actions[event.actionId];
        if (action === undefined) {
          throw new Error(`action-verified for unknown action: ${event.actionId}`);
        }
        if (TERMINAL.has(action.state)) {
          throw new Error(
            `illegal transition: action ${event.actionId} is already terminal (${action.state})`,
          );
        }
        if (action.supersededAt !== undefined) {
          // The verification still happened and its postconditions may well
          // pass -- but an operator fixed this component while the action was
          // in flight, so the automation gets no credit for the outcome.
          action.state = "superseded-by-operator";
          action.attribution = "operator";
          action.postconditionSamples = event.postconditionSamples.map((sample) => ({
            ...sample,
            evidenceRefs: [...sample.evidenceRefs],
          }));
          action.recoveryEvidence = { ...event.recoveryEvidence };
          break;
        }
        action.state = event.outcome;
        action.attribution = event.attribution ?? (
          event.outcome === "external-recovery"
            ? "external"
            : event.outcome === "uncertain"
              ? "unknown"
              : event.outcome === "not-needed"
                ? undefined
                : "automatic"
        );
        action.postconditionSamples = event.postconditionSamples.map((sample) => ({
          ...sample,
          evidenceRefs: [...sample.evidenceRefs],
        }));
        action.recoveryEvidence = { ...event.recoveryEvidence };
        break;
      }

      case "mutation-ownership-changed":
        state.ownership[event.componentId] = event.ownership;
        break;

      case "alert-raised":
        state.alerts.push({
          incidentId: event.incidentId,
          severity: event.severity,
          summary: event.summary,
          at: event.at,
        });
        break;

      case "analysis-status-recorded":
        state.analysis.push({
          analysisId: event.analysisId,
          status: event.status,
          consecutiveFailures: event.consecutiveFailures,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
          at: event.at,
        });
        break;

      case "controller-cycle-recorded":
        state.controllerCycles.push({
          controllerId: event.controllerId,
          releaseRef: event.releaseRef,
          observationCount: event.observationCount,
          collectionFailureCount: event.collectionFailureCount,
          at: event.at,
        });
        break;
    }
  }

  return state;
}
