/** Deterministic, durable operations controller. */
import { createHash, randomUUID } from "node:crypto";
import {
  arbitrate,
  decideAuthority,
  type AttemptRecord,
} from "@helium/core/operations/authority.js";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import { correlate } from "@helium/core/operations/correlate.js";
import type { OperationsEvent } from "@helium/core/operations/events.js";
import type { Incident } from "@helium/core/operations/incident.js";
import type { ActionLeaseController } from "@helium/core/operations/lease.js";
import {
  canMutate,
  type ControllerProbeOutcome,
} from "@helium/core/operations/mutation-owner.js";
import type { Observation } from "@helium/core/operations/observation.js";
import type { OperationsState } from "@helium/core/operations/reducer.js";
import type { SopDefinition } from "@helium/core/operations/sop.js";
import { verifyAction } from "@helium/core/operations/verify.js";
import type { CollectionResult, ObservationSink } from "./collector.js";
import type { ComponentRegistry, LoadedSop } from "./component-registry.js";
import { decideRuntimeMode, type OpsMode } from "./mode.js";
import type { ApprovalLedger } from "./approval.js";
import {
  ExecutionSuppressedError,
  type ExecutionGate,
  type ExecutionReceipt,
  type ExecutionRequest,
} from "./script-executor.js";

export interface OperationsStorePort {
  append(raw: unknown): OperationsEvent;
  state(): OperationsState;
  replay(): OperationsEvent[];
}

export interface ActionExecutor {
  run(
    request: ExecutionRequest,
    signal: AbortSignal,
    gate?: ExecutionGate,
  ): Promise<ExecutionReceipt>;
}

export interface ControllerProbePort {
  check(component: NonNullable<ReturnType<ComponentRegistry["component"]>>):
    Promise<ControllerProbeOutcome>;
}

export interface OpsControllerOptions {
  mode: OpsMode;
  registry: ComponentRegistry;
  store: OperationsStorePort;
  now: () => Date;
  /** The caller constructs Collector with this injected authoritative sink. */
  collect: (sink: ObservationSink) => Promise<CollectionResult>;
  runChecks: (ids: readonly string[]) => Promise<Record<string, "pass" | "fail" | "unknown">>;
  sampleChecks: (
    ids: readonly string[],
    phase: "baseline" | "postcondition",
  ) => Promise<PostconditionSample[]>;
  controllerProbe: ControllerProbePort;
  leases: ActionLeaseController;
  approvals: ApprovalLedger;
  createExecutor: () => ActionExecutor;
  argvFor: (sop: SopDefinition, incident: Incident) => string[];
  nextId?: (prefix: string) => string;
}

export interface ControllerActionResult {
  incidentId: string;
  sopId: string;
  disposition: "observe" | "propose" | "execute";
  reason?: string;
  actionId?: string;
  outcome?: string;
  controllerEvidenceRef?: string;
}

export interface ControllerTickResult {
  observations: Observation[];
  incidents: Incident[];
  actions: ControllerActionResult[];
  collectionFailures: CollectionResult["failures"];
}

interface Candidate {
  loaded: LoadedSop;
  sop: SopDefinition;
  incident: Incident;
  approved: boolean;
  approvedBy?: string;
  eligible: boolean;
  policyReasons: string[];
}

export class OpsController {
  readonly #nextId: (prefix: string) => string;
  readonly #incidentKeys = new Map<string, string>();

  constructor(private readonly options: OpsControllerOptions) {
    this.#nextId =
      options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<ControllerTickResult> {
    await this.#recordRegistryObservations();
    const collection = await this.options.collect(this.#observationSink());
    for (const observation of collection.observations) {
      if (this.options.store.state().observations[observation.id] === undefined) {
        throw new Error(
          `collector returned observation ${observation.id} without authoritative append`,
        );
      }
    }

    const observations = latestObservations(
      Object.values(this.options.store.state().observations),
    );
    const correlated = correlate(
      { graph: this.options.registry.graph(), observations, previous: [] },
      this.options.now(),
    );
    this.#recordIncidents(correlated.incidents);

    const actions: ControllerActionResult[] = [];
    for (const incident of correlated.incidents) {
      const candidate = await this.#selectCandidate(incident);
      if (candidate === undefined) continue;
      actions.push(await this.#act(candidate, signal));
    }

    return {
      observations: collection.observations,
      incidents: correlated.incidents,
      actions,
      collectionFailures: collection.failures,
    };
  }

  #observationSink(): ObservationSink {
    return {
      append: async (observation) => {
        this.options.store.append({
          v: 1,
          id: this.#nextId("evt-observation"),
          at: this.options.now().toISOString(),
          type: "observation-recorded",
          observation,
        });
      },
    };
  }

  async #recordRegistryObservations(): Promise<void> {
    const state = this.options.store.state();
    for (const observation of this.options.registry.observations()) {
      if (state.observations[observation.id] !== undefined) continue;
      await this.#observationSink().append(observation);
    }
  }

  #recordIncidents(incidents: Incident[]): void {
    const state = this.options.store.state();
    const currentIds = new Set<string>();
    for (const incident of incidents) {
      const incidentId = persistedIncidentId(incident.key);
      this.#incidentKeys.set(incidentId, incident.key);
      currentIds.add(incidentId);
      const existing = state.incidents[incidentId];
      if (existing === undefined) {
        this.options.store.append({
          v: 1,
          id: this.#nextId("evt-incident-opened"),
          at: this.options.now().toISOString(),
          type: "incident-opened",
          incidentId,
          componentId: incident.rootComponentId,
          dimension: incident.dimension,
          observationIds: incident.observationIds,
        });
        if (incident.state !== "open") {
          this.options.store.append({
            v: 1,
            id: this.#nextId("evt-incident-updated"),
            at: this.options.now().toISOString(),
            type: "incident-updated",
            incidentId,
            state: incident.state,
          });
        }
      } else if (existing.state !== incident.state) {
        this.options.store.append({
          v: 1,
          id: this.#nextId("evt-incident-updated"),
          at: this.options.now().toISOString(),
          type: "incident-updated",
          incidentId,
          state: incident.state,
        });
      }
    }

    for (const existing of Object.values(this.options.store.state().incidents)) {
      if (currentIds.has(existing.incidentId) || existing.state === "recovered") continue;
      this.options.store.append({
        v: 1,
        id: this.#nextId("evt-incident-recovered"),
        at: this.options.now().toISOString(),
        type: "incident-updated",
        incidentId: existing.incidentId,
        state: "recovered",
      });
    }
  }

  async #selectCandidate(incident: Incident): Promise<Candidate | undefined> {
    const candidates: Candidate[] = [];
    for (const loaded of this.options.registry.sops()) {
      const definition = loaded.definition;
      if (
        definition.componentId !== incident.rootComponentId ||
        definition.matches.dimension !== incident.dimension ||
        definition.matches.failureClass !== incident.failureClass
      ) {
        continue;
      }
      const sop: SopDefinition = { ...definition, authority: loaded.authority };
      const approval = this.options.approvals.find(incident.key, sop.id);
      const policySop: SopDefinition =
        this.options.mode === "approve" && sop.authority === "auto"
          ? { ...sop, authority: "approve" }
          : sop;
      const decision = decideAuthority({
        sop: policySop,
        incident,
        checkResults: await this.options.runChecks(sop.preconditions),
        history: this.#history(),
        now: this.options.now(),
        ...(approval === undefined ? {} : { approval }),
      });
      const ignorable = new Set([
        "approval-missing",
        "authority-observe",
        "authority-forbidden",
      ]);
      const policyReasons = decision.reasons.filter((reason) => !ignorable.has(reason));
      candidates.push({
        loaded,
        sop,
        incident,
        approved: approval !== undefined,
        ...(approval === undefined ? {} : { approvedBy: approval.operatorId }),
        eligible: loaded.certified && policyReasons.length === 0,
        policyReasons,
      });
    }

    const eligible = candidates.filter((candidate) => candidate.eligible);
    const selected = arbitrate(eligible.map((candidate) => candidate.sop)).selected;
    return selected === undefined
      ? undefined
      : eligible.find((candidate) => candidate.sop.id === selected.id);
  }

  async #act(candidate: Candidate, signal: AbortSignal): Promise<ControllerActionResult> {
    const modeDecision = decideRuntimeMode({
      mode: this.options.mode,
      authority: candidate.sop.authority,
      eligible: candidate.eligible,
      approved: candidate.approved,
    });
    if (modeDecision.disposition === "observe") {
      return {
        incidentId: candidate.incident.key,
        sopId: candidate.sop.id,
        disposition: "observe",
        reason: modeDecision.reason,
      };
    }

    const action = this.#actionIdentity(candidate);
    if (action.inFlight) {
      return {
        incidentId: candidate.incident.key,
        sopId: candidate.sop.id,
        disposition: "observe",
        reason: "action-in-flight",
        actionId: action.actionId,
      };
    }
    if (modeDecision.disposition === "propose") {
      this.#ensureProposed(action.actionId, candidate);
      return {
        incidentId: candidate.incident.key,
        sopId: candidate.sop.id,
        disposition: "propose",
        ...(modeDecision.reason === undefined ? {} : { reason: modeDecision.reason }),
        actionId: action.actionId,
      };
    }

    const component = this.options.registry.component(candidate.sop.componentId);
    if (component === undefined) {
      return {
        incidentId: candidate.incident.key,
        sopId: candidate.sop.id,
        disposition: "observe",
        reason: "component-missing",
      };
    }
    const initialProbe = await this.options.controllerProbe.check(component);
    const initialPermission = canMutate(component, initialProbe);
    if (!initialPermission.ok) {
      return {
        incidentId: candidate.incident.key,
        sopId: candidate.sop.id,
        disposition: "observe",
        reason: initialPermission.reason,
        controllerEvidenceRef: initialProbe.evidenceRef,
      };
    }

    const argv = this.options.argvFor(candidate.sop, candidate.incident);
    let leaseId: string | undefined;
    let boundaryRef = initialProbe.evidenceRef;
    let suppressionReason: string | undefined;

    try {
      const acquired = this.options.leases.acquire({
        componentId: component.id,
        incidentId: persistedIncidentId(candidate.incident.key),
        sopId: candidate.sop.id,
        sopDigest: candidate.sop.digest,
        attempt: action.attempt,
      });
      if (!acquired.ok) {
        return {
          incidentId: candidate.incident.key,
          sopId: candidate.sop.id,
          disposition: "observe",
          reason: acquired.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      leaseId = acquired.lease.leaseId;

      const samples = await this.options.sampleChecks(
        candidate.sop.postconditions,
        "baseline",
      );
      if (samples.length !== candidate.sop.postconditions.length) {
        throw new Error("baseline did not sample every postcondition");
      }
      const baseline = {
        samples,
        allPassing: samples.every((sample) => sample.state === "pass"),
      };
      if (baseline.allPassing) {
        // This is a terminal policy result, not an intent to mutate. Recording
        // an intent here would make a crash replay look as if a spawn may have
        // happened, which is precisely what `not-needed` rules out.
        this.#ensureProposed(action.actionId, candidate);
        this.#ensureAuthorized(action.actionId, candidate);
        this.#verify(action.actionId, "not-needed", baseline.samples);
        return this.#executedResult(candidate, action.actionId, boundaryRef);
      }

      const executor = this.options.createExecutor();
      const receipt = await executor.run(
        {
          actionId: action.actionId,
          executorId: candidate.sop.action.executorId,
          argv,
        },
        signal,
        async () => {
          // Baseline sampling may take time. Enumerate competing controllers
          // only after it finishes, then append intent synchronously. The
          // executor performs no asynchronous step between this gate and
          // spawn.
          const atSpawn = await this.options.controllerProbe.check(component);
          boundaryRef = atSpawn.evidenceRef;
          const permission = canMutate(component, atSpawn);
          if (!permission.ok) {
            suppressionReason = permission.reason;
            return { admitted: false, reason: permission.reason };
          }
          this.#ensureProposed(action.actionId, candidate);
          this.#ensureAuthorized(action.actionId, candidate);
          this.options.store.append({
            v: 1,
            id: this.#nextId("evt-action-intent"),
            at: this.options.now().toISOString(),
            type: "action-intent-recorded",
            actionId: action.actionId,
            leaseId,
            argv,
            baselineAllPassing: false,
          });
          return { admitted: true };
        },
      );

      this.options.store.append({
        v: 1,
        id: this.#nextId("evt-action-receipt"),
        at: this.options.now().toISOString(),
        type: "action-receipt-recorded",
        actionId: action.actionId,
        exitCode: receipt.exit.code,
        timedOut: receipt.timedOut,
      });
      const postconditions = await this.options.sampleChecks(
        candidate.sop.postconditions,
        "postcondition",
      );
      const postconditionVerdict = samplesVerdict(postconditions);
      const verdict = verifyAction({
        baseline,
        intentRecorded: true,
        receipt: { exitCode: receipt.exit.code, timedOut: receipt.timedOut },
        postconditions: postconditionVerdict,
        operatorConfirmed:
          this.options.store.state().actions[action.actionId]?.supersededAt !== undefined,
      });
      if (verdict.decision !== "outcome") {
        throw new Error(`unexpected verification refusal: ${verdict.reason}`);
      }
      this.#verify(action.actionId, verdict.outcome, postconditions);
      return this.#executedResult(candidate, action.actionId, boundaryRef);
    } catch (error) {
      if (error instanceof ExecutionSuppressedError) {
        return {
          incidentId: candidate.incident.key,
          sopId: candidate.sop.id,
          disposition: "observe",
          reason: suppressionReason ?? error.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      if (this.options.store.state().actions[action.actionId]?.state === "intent-recorded") {
        this.#verify(action.actionId, "uncertain", []);
        return this.#executedResult(candidate, action.actionId, boundaryRef, error);
      }
      throw error;
    } finally {
      if (leaseId !== undefined) {
        this.options.leases.release(leaseId, component.id);
      }
    }
  }

  #ensureProposed(actionId: string, candidate: Candidate): void {
    if (this.options.store.state().actions[actionId] !== undefined) return;
    this.options.store.append({
      v: 1,
      id: this.#nextId("evt-action-proposed"),
      at: this.options.now().toISOString(),
      type: "action-proposed",
      actionId,
      incidentId: persistedIncidentId(candidate.incident.key),
      componentId: candidate.sop.componentId,
      sopId: candidate.sop.id,
      sopVersion: candidate.sop.version,
      sopDigest: candidate.sop.digest,
    });
  }

  #ensureAuthorized(actionId: string, candidate: Candidate): void {
    const action = this.options.store.state().actions[actionId];
    if (action?.state === "authorized") return;
    if (action?.state !== "proposed") {
      throw new Error(`cannot authorize action ${actionId} from ${action?.state ?? "missing"}`);
    }
    this.options.store.append({
      v: 1,
      id: this.#nextId("evt-action-authorized"),
      at: this.options.now().toISOString(),
      type: "action-authorized",
      actionId,
      authority: candidate.sop.authority,
      ...(candidate.approvedBy === undefined
        ? {}
        : { approvedBy: candidate.approvedBy }),
      ...(candidate.loaded.authorityManifestEntry === undefined
        ? {}
        : { authorityManifestEntry: candidate.loaded.authorityManifestEntry }),
    });
  }

  #verify(actionId: string, outcome: string, samples: PostconditionSample[]): void {
    this.options.store.append({
      v: 1,
      id: this.#nextId("evt-action-verified"),
      at: this.options.now().toISOString(),
      type: "action-verified",
      actionId,
      outcome,
      postconditionRefs: samples.map((sample) => sample.checkId),
    });
  }

  #executedResult(
    candidate: Candidate,
    actionId: string,
    controllerEvidenceRef: string,
    error?: unknown,
  ): ControllerActionResult {
    const state = this.options.store.state().actions[actionId]?.state;
    return {
      incidentId: candidate.incident.key,
      sopId: candidate.sop.id,
      disposition: "execute",
      actionId,
      ...(state === undefined ? {} : { outcome: state }),
      controllerEvidenceRef,
      ...(error instanceof Error ? { reason: error.message } : {}),
    };
  }

  #actionIdentity(candidate: Candidate): {
    actionId: string;
    attempt: number;
    inFlight: boolean;
  } {
    const matching = Object.values(this.options.store.state().actions).filter(
      (action) =>
        action.incidentId === persistedIncidentId(candidate.incident.key) &&
        action.sopId === candidate.sop.id,
    );
    const inFlight = matching.find((action) =>
      ["authorized", "intent-recorded", "executed"].includes(action.state),
    );
    if (inFlight !== undefined) {
      return {
        actionId: inFlight.actionId,
        attempt: matching.length,
        inFlight: true,
      };
    }
    const proposed = matching.find((action) => action.state === "proposed");
    const attempt = proposed === undefined ? matching.length + 1 : matching.length;
    return {
      actionId:
        proposed?.actionId ??
        stableId(
          "act",
          `${candidate.incident.key}|${candidate.sop.id}|${candidate.sop.digest}|${attempt}`,
        ),
      attempt,
      inFlight: false,
    };
  }

  #history(): AttemptRecord[] {
    const state = this.options.store.state();
    return this.options.store
      .replay()
      .filter((event) => event.type === "action-verified")
      .map((event) => {
        const action = state.actions[event.actionId];
        return action === undefined
          ? undefined
          : {
              sopId: action.sopId,
              incidentId: this.#incidentKeys.get(action.incidentId) ?? action.incidentId,
              at: event.at,
              outcome: event.outcome,
            };
      })
      .filter((record): record is AttemptRecord => record !== undefined);
  }
}

function latestObservations(observations: Observation[]): Observation[] {
  const latest = new Map<string, Observation>();
  for (const observation of observations) {
    const key = [
      observation.componentId,
      observation.dimension,
      observation.probeId,
    ].join("\u0000");
    const previous = latest.get(key);
    if (
      previous === undefined ||
      Date.parse(observation.observedAt) >= Date.parse(previous.observedAt)
    ) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

function samplesVerdict(samples: PostconditionSample[]): "pass" | "fail" | "unknown" {
  if (samples.length === 0 || samples.some((sample) => sample.state === "unknown")) {
    return "unknown";
  }
  return samples.every((sample) => sample.state === "pass") ? "pass" : "fail";
}

function persistedIncidentId(key: string): string {
  return stableId("inc", key);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
