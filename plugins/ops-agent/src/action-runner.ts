/** Certified, reusable mutation transaction shared by Ops action adapters. */
import type { PostconditionSample } from "@helium/core/operations/action.js";
import type { CheckDefinition } from "@helium/core/operations/check.js";
import type { ComponentSpec, MutationOwnership } from "@helium/core/operations/component.js";
import type { OperationsEvent } from "@helium/core/operations/events.js";
import type { ActionLease, ActionLeaseController } from "@helium/core/operations/lease.js";
import {
  canMutate,
  type ControllerProbeOutcome,
} from "@helium/core/operations/mutation-owner.js";
import type { OperationsState } from "@helium/core/operations/reducer.js";
import type { RecoveryEvidence } from "@helium/core/operations/recovery-evidence.js";
import { verifyAction } from "@helium/core/operations/verify.js";
import type { ComponentActionLockPort } from "./component-action-lock.js";
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
  check(component: ComponentSpec): Promise<ControllerProbeOutcome>;
}

export interface CertifiedActionRequest {
  /** Opaque caller scope. Livewire uses workUnitId:scopeHash. */
  scopeId: string;
  actionId: string;
  attempt: number;
  incidentId: string;
  component: ComponentSpec;
  sop: {
    id: string;
    digest: string;
    executorId: string;
    postconditions: readonly string[];
  };
  argv: readonly string[];
  verificationPolicy: {
    postconditions: readonly CheckDefinition[];
    graceMs: number;
  };
  eligibility: {
    eligible: boolean;
    reasons: readonly string[];
  };
  mutationOwner: MutationOwnership;
  /** Exact content-addressed inputs persisted with a scoped write-ahead intent. */
  inputArtifacts?: readonly { ref: string; sha256: string }[];
  /** Resolve at the intent boundary, after the second controller probe. */
  dependencyIds: () => readonly string[];
  /** Last synchronous integrity check before write-ahead intent and spawn. */
  preSpawn?: () => void;
}

export interface CertifiedActionHooks {
  ensureProposed(): void;
  ensureAuthorized(): void;
  recordTerminal(
    outcome: RecoveryEvidence["outcome"],
    samples: PostconditionSample[],
    overrides?: {
      lease?: ActionLease;
      baseline?: {
        capturedAt: string;
        samples: PostconditionSample[];
        allPassing: boolean;
      };
      controllerProbe?: ControllerProbeOutcome;
    },
  ): void;
}

export interface CertifiedActionResult {
  disposition: "execute" | "observe";
  reason?: string;
  outcome?: string;
  controllerEvidenceRef: string;
}

export interface CertifiedActionRunnerOptions {
  store: OperationsStorePort;
  now: () => Date;
  nextId: (prefix: string) => string;
  sampleChecks: (
    checks: readonly CheckDefinition[],
    phase: "baseline" | "postcondition",
  ) => Promise<PostconditionSample[]>;
  sampleGrace: (policy: CertifiedActionRequest["verificationPolicy"]) => Promise<{
    verdict: "pass" | "fail" | "unknown";
    samples: PostconditionSample[];
  }>;
  controllerProbe: ControllerProbePort;
  leases: ActionLeaseController;
  componentLocks: ComponentActionLockPort;
  createExecutor: () => ActionExecutor;
}

export class CertifiedActionRunner {
  constructor(private readonly options: CertifiedActionRunnerOptions) {}

  async run(
    request: CertifiedActionRequest,
    hooks: CertifiedActionHooks,
    signal: AbortSignal,
  ): Promise<CertifiedActionResult> {
    if (request.scopeId.length === 0 || request.scopeId.length > 256 || request.scopeId.includes("|")) {
      throw new Error("certified action scope id is invalid");
    }
    const initialProbe = await this.options.controllerProbe.check(request.component);
    const initialPermission = canMutate(request.component, initialProbe);
    if (!initialPermission.ok) {
      return {
        disposition: "observe",
        reason: initialPermission.reason,
        controllerEvidenceRef: initialProbe.evidenceRef,
      };
    }

    let leaseId: string | undefined;
    let componentLock: { release(): void } | undefined;
    let boundaryRef = initialProbe.evidenceRef;
    let suppressionReason: string | undefined;

    try {
      const acquired = this.options.leases.acquire({
        componentId: request.component.id,
        incidentId: request.incidentId,
        sopId: request.sop.id,
        sopDigest: request.sop.digest,
        attempt: request.attempt,
      });
      if (!acquired.ok) {
        return {
          disposition: "observe",
          reason: acquired.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      leaseId = acquired.lease.leaseId;

      const locked = this.options.componentLocks.acquire({
        componentId: request.component.id,
        leaseId: acquired.lease.leaseId,
        sopDigest: request.sop.digest,
        acquiredAt: acquired.lease.acquiredAt,
        expiresAt: acquired.lease.expiresAt,
      });
      if (!locked.ok) {
        return {
          disposition: "observe",
          reason: locked.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      componentLock = locked.handle;

      const baselineCapturedAt = this.options.now().toISOString();
      const samples = await this.options.sampleChecks(
        request.verificationPolicy.postconditions,
        "baseline",
      );
      if (samples.length !== request.sop.postconditions.length) {
        throw new Error("baseline did not sample every postcondition");
      }
      const baseline = {
        samples,
        allPassing: samples.every((sample) => sample.state === "pass"),
      };
      if (samples.some((sample) => sample.state === "unknown")) {
        return {
          disposition: "observe",
          reason: "baseline-unavailable",
          controllerEvidenceRef: boundaryRef,
        };
      }
      if (baseline.allPassing) {
        hooks.ensureProposed();
        hooks.ensureAuthorized();
        hooks.recordTerminal("not-needed", baseline.samples, {
          lease: acquired.lease,
          baseline: { capturedAt: baselineCapturedAt, ...baseline },
          controllerProbe: initialProbe,
        });
        return this.#executed(request.actionId, boundaryRef);
      }

      const executor = this.options.createExecutor();
      const receipt = await executor.run(
        {
          actionId: request.actionId,
          executorId: request.sop.executorId,
          argv: [...request.argv],
        },
        signal,
        async () => {
          const atSpawn = await this.options.controllerProbe.check(request.component);
          boundaryRef = atSpawn.evidenceRef;
          const permission = canMutate(request.component, atSpawn);
          if (!permission.ok) {
            suppressionReason = permission.reason;
            return { admitted: false, reason: permission.reason };
          }
          request.preSpawn?.();
          hooks.ensureProposed();
          hooks.ensureAuthorized();
          this.options.store.append({
            v: 1,
            id: this.options.nextId("evt-action-intent"),
            at: this.options.now().toISOString(),
            type: "action-intent-recorded",
            actionId: request.actionId,
            leaseId,
            operationId: acquired.lease.operationId,
            argv: [...request.argv],
            ...(request.inputArtifacts === undefined
              ? {}
              : {
                  scopeId: request.scopeId,
                  inputArtifacts: request.inputArtifacts.map((artifact) => ({ ...artifact })),
                }),
            baseline: {
              capturedAt: baselineCapturedAt,
              samples: baseline.samples,
              allPassing: false,
            },
            controllerProbe: atSpawn,
            eligibility: {
              eligible: request.eligibility.eligible,
              reasons: [...request.eligibility.reasons],
            },
            mutationOwner: request.mutationOwner,
            dependencyIds: [...request.dependencyIds()],
            verificationPolicy: {
              postconditions: request.verificationPolicy.postconditions,
              graceMs: request.verificationPolicy.graceMs,
            },
          });
          return { admitted: true };
        },
      );

      this.options.store.append({
        v: 1,
        id: this.options.nextId("evt-action-receipt"),
        at: this.options.now().toISOString(),
        type: "action-receipt-recorded",
        actionId: request.actionId,
        exitCode: receipt.exit.code,
        timedOut: receipt.timedOut,
        outputDigest: receipt.outputDigest,
        outputTail: receipt.outputTail,
        outputBytes: receipt.outputBytes,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
      });
      const verified = await this.options.sampleGrace(request.verificationPolicy);
      const verdict = verifyAction({
        baseline,
        intentRecorded: true,
        receipt: { exitCode: receipt.exit.code, timedOut: receipt.timedOut },
        postconditions: verified.verdict,
        operatorConfirmed:
          this.options.store.state().actions[request.actionId]?.supersededAt !== undefined,
      });
      if (verdict.decision !== "outcome") {
        throw new Error(`unexpected verification refusal: ${verdict.reason}`);
      }
      hooks.recordTerminal(verdict.outcome, verified.samples);
      return this.#executed(request.actionId, boundaryRef);
    } catch (error) {
      if (error instanceof ExecutionSuppressedError) {
        return {
          disposition: "observe",
          reason: suppressionReason ?? error.reason,
          controllerEvidenceRef: boundaryRef,
        };
      }
      if (this.options.store.state().actions[request.actionId]?.state === "intent-recorded") {
        hooks.recordTerminal("uncertain", []);
        return this.#executed(request.actionId, boundaryRef, error);
      }
      throw error;
    } finally {
      componentLock?.release();
      if (leaseId !== undefined) {
        this.options.leases.release(leaseId, request.component.id);
      }
    }
  }

  #executed(actionId: string, controllerEvidenceRef: string, error?: unknown): CertifiedActionResult {
    const state = this.options.store.state().actions[actionId]?.state;
    return {
      disposition: "execute",
      ...(state === undefined ? {} : { outcome: state }),
      controllerEvidenceRef,
      ...(error instanceof Error ? { reason: error.message } : {}),
    };
  }
}
