/** Deterministic, durable operations controller. */
import { createHash, randomUUID } from "node:crypto";
import {
  arbitrate,
  decideAuthority,
  type AttemptRecord,
} from "@helium/core/operations/authority.js";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import type { CheckDefinition } from "@helium/core/operations/check.js";
import { correlate } from "@helium/core/operations/correlate.js";
import type { OperationsEvent } from "@helium/core/operations/events.js";
import type { Incident } from "@helium/core/operations/incident.js";
import type { ActionLease, ActionLeaseController } from "@helium/core/operations/lease.js";
import {
  canMutate,
  type ControllerProbeOutcome,
} from "@helium/core/operations/mutation-owner.js";
import type { Observation } from "@helium/core/operations/observation.js";
import {
  reconcileOnStartup,
} from "@helium/core/operations/reconcile.js";
import type {
  ActionProjection,
  OperationsState,
} from "@helium/core/operations/reducer.js";
import type { RecoveryEvidence } from "@helium/core/operations/recovery-evidence.js";
import type { SopDefinition } from "@helium/core/operations/sop.js";
import {
  runGraceWindow,
  verifyAction,
} from "@helium/core/operations/verify.js";
import type { CollectionResult, ObservationSink } from "./collector.js";
import type { ComponentRegistry, LoadedSop } from "./component-registry.js";
import { decideRuntimeMode, type OpsMode } from "./mode.js";
import type { ApprovalLedger } from "./approval.js";
import type { ComponentActionLockPort } from "./component-action-lock.js";
import type { RecoveryEvidencePort } from "./recovery-evidence-store.js";
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
    checks: readonly CheckDefinition[],
    phase: "baseline" | "postcondition",
  ) => Promise<PostconditionSample[]>;
  controllerProbe: ControllerProbePort;
  leases: ActionLeaseController;
  componentLocks: ComponentActionLockPort;
  approvals: ApprovalLedger;
  evidence: RecoveryEvidencePort;
  createExecutor: () => ActionExecutor;
  argvFor: (sop: SopDefinition, incident: Incident) => string[];
  nextId?: (prefix: string) => string;
  sleep?: (ms: number) => Promise<void>;
  graceIntervalMs?: number;
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
  #startupReconciled = false;

  constructor(private readonly options: OpsControllerOptions) {
    this.#nextId =
      options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<ControllerTickResult> {
    await this.#reconcileStartup();
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
    const verificationPolicy = {
      postconditions: this.options.registry.checks(candidate.sop.postconditions),
      graceMs: candidate.sop.graceMs,
    };
    let leaseId: string | undefined;
    let componentLock: { release(): void } | undefined;
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

      const locked = this.options.componentLocks.acquire({
        componentId: component.id,
        leaseId: acquired.lease.leaseId,
        sopDigest: candidate.sop.digest,
        acquiredAt: acquired.lease.acquiredAt,
        expiresAt: acquired.lease.expiresAt,
      });
      if (!locked.ok) {
        return {
          incidentId: candidate.incident.key,
          sopId: candidate.sop.id,
          disposition: "observe",
          reason: locked.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      componentLock = locked.handle;

      const baselineCapturedAt = this.options.now().toISOString();
      const samples = await this.options.sampleChecks(
        verificationPolicy.postconditions,
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
        this.#recordTerminal(action.actionId, "not-needed", baseline.samples, {
          lease: acquired.lease,
          baseline: { capturedAt: baselineCapturedAt, ...baseline },
          controllerProbe: initialProbe,
        });
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
            operationId: acquired.lease.operationId,
            argv,
            baseline: {
              capturedAt: baselineCapturedAt,
              samples: baseline.samples,
              allPassing: false,
            },
            controllerProbe: atSpawn,
            eligibility: {
              eligible: candidate.eligible,
              reasons: [
                ...candidate.loaded.certificationReasons,
                ...candidate.policyReasons,
              ],
            },
            mutationOwner: component.mutationOwner,
            dependencyIds: this.options.registry
              .graph()
              .transitiveDependenciesOf(component.id),
            verificationPolicy: {
              postconditions: verificationPolicy.postconditions,
              graceMs: verificationPolicy.graceMs,
            },
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
        outputDigest: receipt.outputDigest,
        outputTail: receipt.outputTail,
        outputBytes: receipt.outputBytes,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
      });
      const verified = await this.#sampleGrace(verificationPolicy);
      const verdict = verifyAction({
        baseline,
        intentRecorded: true,
        receipt: { exitCode: receipt.exit.code, timedOut: receipt.timedOut },
        postconditions: verified.verdict,
        operatorConfirmed:
          this.options.store.state().actions[action.actionId]?.supersededAt !== undefined,
      });
      if (verdict.decision !== "outcome") {
        throw new Error(`unexpected verification refusal: ${verdict.reason}`);
      }
      this.#recordTerminal(action.actionId, verdict.outcome, verified.samples);
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
        this.#recordTerminal(action.actionId, "uncertain", []);
        return this.#executedResult(candidate, action.actionId, boundaryRef, error);
      }
      throw error;
    } finally {
      componentLock?.release();
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

  #recordTerminal(
    actionId: string,
    requestedOutcome: RecoveryEvidence["outcome"],
    samples: PostconditionSample[],
    overrides: {
      lease?: ActionLease;
      baseline?: {
        capturedAt: string;
        samples: PostconditionSample[];
        allPassing: boolean;
      };
      controllerProbe?: ControllerProbeOutcome;
    } = {},
  ): void {
    const action = this.options.store.state().actions[actionId];
    if (action === undefined) throw new Error(`cannot verify missing action: ${actionId}`);
    const outcome = action.supersededAt === undefined
      ? requestedOutcome
      : "superseded-by-operator";
    const evidence = this.#buildRecoveryEvidence(action, outcome, samples, overrides);
    const persisted = this.options.evidence.persistBundle(evidence);
    this.options.store.append({
      v: 1,
      id: this.#nextId("evt-action-verified"),
      at: this.options.now().toISOString(),
      type: "action-verified",
      actionId,
      outcome,
      ...(evidence.attribution === undefined
        ? {}
        : { attribution: evidence.attribution }),
      postconditionRefs: samples.map((sample) => sample.checkId),
      postconditionSamples: samples,
      recoveryEvidence: persisted,
    });
  }

  #buildRecoveryEvidence(
    action: ActionProjection,
    outcome: RecoveryEvidence["outcome"],
    samples: PostconditionSample[],
    overrides: {
      lease?: ActionLease;
      baseline?: {
        capturedAt: string;
        samples: PostconditionSample[];
        allPassing: boolean;
      };
      controllerProbe?: ControllerProbeOutcome;
    },
  ): RecoveryEvidence {
    const component = this.options.registry.component(action.componentId);
    const loaded = this.options.registry.sop(action.sopId);
    const incident = this.options.store.state().incidents[action.incidentId];
    if (incident === undefined) {
      throw new Error(`cannot build recovery evidence for unresolved action: ${action.actionId}`);
    }
    const persistedDecision = action.eligibility !== undefined &&
      action.mutationOwner !== undefined && action.dependencyIds !== undefined;
    if (!persistedDecision && (component === undefined || loaded === undefined)) {
      throw new Error(`cannot build recovery evidence for unresolved action: ${action.actionId}`);
    }
    if (action.authorityManifestEntry === undefined || action.authority === undefined) {
      throw new Error(`cannot verify action without signed authority evidence: ${action.actionId}`);
    }
    const controllerProbe = overrides.controllerProbe ?? action.controllerProbe;
    if (controllerProbe === undefined) {
      throw new Error(`cannot verify action without controller probe evidence: ${action.actionId}`);
    }
    const observationValues = incident.observationIds.map((id) => {
      const observation = this.options.store.state().observations[id];
      if (observation === undefined) throw new Error(`missing incident observation: ${id}`);
      return observation;
    });
    const observations = observationValues.map((observation) =>
      this.options.evidence.persistArtifact("observation", observation));
    const incidentSnapshot = this.options.evidence.persistArtifact("incident", {
      incident,
      dependencyIds: action.dependencyIds ??
        this.options.registry.graph().transitiveDependenciesOf(component!.id),
      capturedAt: this.options.now().toISOString(),
    });
    const baseline = overrides.baseline ?? action.baseline;
    const lease = overrides.lease ?? (
      action.leaseId === undefined || action.operationId === undefined
        ? undefined
        : { leaseId: action.leaseId, operationId: action.operationId }
    );
    const receipt = action.outputDigest === undefined
      ? undefined
      : {
          exitCode: action.exitCode ?? null,
          timedOut: action.timedOut ?? false,
          outputDigest: action.outputDigest,
          evidence: this.options.evidence.persistArtifact("receipt", {
            actionId: action.actionId,
            exitCode: action.exitCode ?? null,
            timedOut: action.timedOut ?? false,
            outputDigest: action.outputDigest,
            outputTail: action.outputTail ?? "",
            outputBytes: action.outputBytes ?? 0,
            startedAt: action.startedAt,
            finishedAt: action.finishedAt,
          }),
        };
    const attribution = outcome === "superseded-by-operator"
      ? "operator"
      : outcome === "external-recovery"
        ? "external"
        : outcome === "uncertain"
          ? "unknown"
          : outcome === "not-needed"
            ? undefined
            : "automatic";
    const status = outcome === "uncertain"
      ? "PARTIAL"
      : outcome === "failed"
        ? "FAILED"
        : "PROVEN";
    const missingIntent = action.argv === undefined || baseline === undefined;
    const missingReceipt = receipt === undefined;
    const missingLease = lease === undefined;
    const missingBaseline = baseline === undefined;
    const rawArtifacts = this.options.evidence.hashArtifacts([
      ...observationValues.flatMap((observation) => observation.evidenceRefs),
      controllerProbe.evidenceRef,
      ...(baseline === undefined
        ? []
        : baseline.samples.flatMap((sample) => sample.evidenceRefs)),
      ...samples.flatMap((sample) => sample.evidenceRefs),
    ]);
    return {
      assertionId: `recovery-${action.actionId}`,
      componentId: action.componentId,
      incidentId: action.incidentId,
      observations,
      rawArtifacts,
      incidentSnapshot,
      sopId: action.sopId,
      sopVersion: action.sopVersion,
      sopDigest: action.sopDigest,
      authorityManifestEntry: action.authorityManifestEntry,
      authority: action.authority as RecoveryEvidence["authority"],
      eligibility: action.eligibility ?? {
        eligible: loaded!.certified,
        reasons: [...loaded!.certificationReasons],
      },
      mutationOwner: action.mutationOwner ?? component!.mutationOwner,
      controllerProbe,
      ...(missingLease
        ? {}
        : { lease: { leaseId: lease!.leaseId, operationId: lease!.operationId } }),
      ...(missingBaseline
        ? {}
        : {
            baseline: {
              capturedAt: baseline!.capturedAt,
              samples: baseline!.samples,
              allPassing: baseline!.allPassing,
            },
          }),
      ...(missingIntent
        ? {}
        : {
            intent: {
              actionId: action.actionId,
              argv: action.argv!,
            },
          }),
      ...(missingReceipt ? {} : { receipt }),
      postconditionSamples: samples.map((sample) => ({
        checkId: sample.checkId,
        state: sample.state,
        observedAt: sample.observedAt,
        evidenceRefs: [...sample.evidenceRefs],
      })),
      outcome,
      ...(attribution === undefined ? {} : { attribution }),
      verifier: {
        identity: "helium-opsd",
        version: "verify/1",
        decision: outcome === "uncertain"
          ? "inconclusive"
          : outcome === "failed"
            ? "fail"
            : "pass",
      },
      replayRef: `eventlog://operations/action/${action.actionId}`,
      status,
      limitation: outcome === "uncertain"
        ? "The persisted action prefix cannot prove execution or attribution."
        : "",
      ...(missingBaseline || missingIntent || missingReceipt || missingLease
        ? {
            notApplicable: {
              ...(missingBaseline ? { baseline: "no pre-action baseline was recorded" } : {}),
              ...(missingIntent ? { intent: "no write-ahead intent was recorded" } : {}),
              ...(missingReceipt ? { receipt: "no executor receipt was recorded" } : {}),
              ...(missingLease ? { lease: "no durable action lease was recorded" } : {}),
            },
          }
        : {}),
    };
  }

  async #sampleGrace(policy: {
    postconditions: readonly CheckDefinition[];
    graceMs: number;
  }): Promise<{
    verdict: "pass" | "fail" | "unknown";
    samples: PostconditionSample[];
  }> {
    const allSamples: PostconditionSample[] = [];
    const sample = async () => {
      const rows = await this.options.sampleChecks(policy.postconditions, "postcondition");
      allSamples.push(...rows);
      return samplesVerdict(rows);
    };
    if (policy.graceMs === 0) return { verdict: await sample(), samples: allSamples };
    const intervalMs = Math.min(this.options.graceIntervalMs ?? 1_000, policy.graceMs);
    const result = await runGraceWindow(
      { initialDelayMs: intervalMs, intervalMs, timeoutMs: policy.graceMs },
      {
        sample,
        now: this.options.now,
        sleep: this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      },
    );
    return { verdict: result.verdict, samples: allSamples };
  }

  async #reconcileStartup(): Promise<void> {
    if (this.#startupReconciled) return;
    // A process can die after acquiring the OS lock but before its first
    // durable action event. Such a lock cannot be discovered by replaying the
    // action log, so reconcile every registered component once at startup.
    // Keep this out of acquire(): two live contenders must never race while
    // deciding whether the other's newly-created lock is stale.
    for (const component of this.options.registry
      .components()
      .sort((a, b) => a.id.localeCompare(b.id))) {
      this.options.componentLocks.reconcile(component.id);
    }
    const actions = Object.values(this.options.store.state().actions)
      .filter((action) => ["authorized", "intent-recorded", "executed"].includes(action.state))
      .sort((a, b) => a.actionId.localeCompare(b.actionId));
    for (const action of actions) {
      const policy = action.verificationPolicy;
      const loaded = policy === undefined ? this.options.registry.sop(action.sopId) : undefined;
      const currentPolicy = loaded === undefined
        ? undefined
        : {
            postconditions: this.options.registry.checks(loaded.definition.postconditions),
            graceMs: loaded.definition.graceMs,
          };
      const postconditions = policy === undefined && currentPolicy === undefined
        ? []
        : (await this.#sampleGrace(policy ?? currentPolicy!)).samples;
      const [decision] = reconcileOnStartup({
        actions: [action],
        evidence: {
          [action.actionId]: {
            intentRecorded: action.state === "intent-recorded" || action.state === "executed",
            ...(action.baseline === undefined
              ? {}
              : { baselineAllPassing: action.baseline.allPassing }),
            ...(action.outputDigest === undefined
              ? {}
              : {
                  receipt: {
                    exitCode: action.exitCode ?? null,
                    timedOut: action.timedOut ?? false,
                  },
                }),
            postconditions: samplesVerdict(postconditions),
            operatorConfirmed: action.supersededAt !== undefined,
          },
        },
      });
      if (decision === undefined) continue;
      let probe = action.controllerProbe;
      if (probe === undefined) {
        const component = this.options.registry.component(action.componentId);
        if (component === undefined) throw new Error(`missing action component: ${action.componentId}`);
        probe = await this.options.controllerProbe.check(component);
      }
      this.#recordTerminal(action.actionId, decision.outcome, postconditions, {
        controllerProbe: probe,
      });
    }
    this.#startupReconciled = true;
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
