/** Crash-resumable projection of durable Ops action outcomes back into Shepherd state. */
import { randomUUID } from "node:crypto";
import { ACTION_OUTCOMES, canonicalJson } from "@helium/core";
import type { AppendCoordination } from "./append-coordination.js";
import { repairScopeId } from "./repair-ops-adapter.js";
import type { ShepherdStore } from "./store.js";
import type { HashedArtifactRef } from "./work-unit.js";

interface ProjectedReceipt {
  version: 1;
  actionId: string;
  workUnitId: string;
  scopeId: string;
  outcome: string;
  recordedAt: string;
  recoveryEvidence: HashedArtifactRef;
  opsRecoveryEvidence: { ref: string; sha256: string };
}

export interface ShepherdRepairOutcomeProjectorOptions {
  store: ShepherdStore;
  coordination: AppendCoordination;
  now?: () => string;
  id?: (prefix: string) => string;
  failpoint?: (point: string) => void;
  componentId: string;
  sopId: string;
  readRecoveryEvidence: (ref: { ref: string; sha256: string }) => Buffer;
}

interface DurableOpsActions {
  state(): {
    actions: Record<string, {
      actionId: string;
      componentId: string;
      sopId: string;
      scopeId?: string;
      state: string;
      recoveryEvidence?: { ref: string; sha256: string };
    }>;
  };
}

export class ShepherdRepairOutcomeProjector {
  readonly #now: () => string;
  readonly #id: (prefix: string) => string;

  constructor(private readonly options: ShepherdRepairOutcomeProjectorOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  /** Recover the handoff even when the process died before onTickSuccess ran. */
  recordOperations(operations: DurableOpsActions): void {
    const result = this.options.coordination.run(() => {
      for (const action of Object.values(operations.state().actions)
        .sort((a, b) => a.actionId.localeCompare(b.actionId))) {
        if (action.componentId !== this.options.componentId || action.sopId !== this.options.sopId ||
            action.scopeId === undefined || action.recoveryEvidence === undefined ||
            !isTerminalOutcome(action.state)) continue;
        this.#recordReceipt(
          action.actionId,
          action.scopeId,
          action.state,
          {
            ref: action.recoveryEvidence.ref,
            sha256: action.recoveryEvidence.sha256,
          },
        );
      }
      this.#reconcileWithinLock();
    });
    if (!result.acquired) throw new Error("Shepherd repair outcome append lock is held");
  }

  reconcile(): void {
    const result = this.options.coordination.run(() => this.#reconcileWithinLock());
    if (!result.acquired) throw new Error("Shepherd repair outcome append lock is held");
  }

  #reconcileWithinLock(): void {
    for (const { receipt, evidence } of this.#receipts()) {
      let projection = this.options.store.load().workUnits[receipt.workUnitId];
      if (projection === undefined || repairScopeId(projection) !== receipt.scopeId) {
        throw new Error(`Ops repair receipt scope no longer matches Shepherd state: ${receipt.actionId}`);
      }
      if (projection.state === "VERIFIED" || projection.state === "QUARANTINED") continue;
      if (projection.state === "REPAIR_READY") {
        this.#transition(projection.unit.workUnitId, "REPAIR_READY", "REPAIRING", "durable Ops repair receipt recorded");
        this.options.failpoint?.("after-repairing");
        projection = this.options.store.load().workUnits[receipt.workUnitId]!;
      }
      if (projection.state === "REPAIRING") {
        if (!this.#hasVerification(receipt.actionId)) {
          const decision = terminalDecision(receipt.outcome);
          this.options.store.append({
            version: 1,
            eventId: this.#id("event-repair-ops-verification"),
            at: this.#now(),
            type: "repair/verification-recorded",
            payload: {
              workUnitId: receipt.workUnitId,
              expectedRevision: projection.revision,
              revision: projection.revision + 1,
              repairId: receipt.actionId,
              verifierRole: "independent-verifier",
              decision,
              evidence: [receipt.recoveryEvidence, evidence],
            },
          });
          this.options.failpoint?.("after-verification");
          projection = this.options.store.load().workUnits[receipt.workUnitId]!;
        }
        const success = terminalDecision(receipt.outcome) === "pass";
        this.#transition(
          receipt.workUnitId,
          "REPAIRING",
          success ? "VERIFYING" : "QUARANTINED",
          success ? "Ops repair postconditions passed" : "Ops repair was not proven successful",
        );
        projection = this.options.store.load().workUnits[receipt.workUnitId]!;
      }
      if (projection.state === "VERIFYING") {
        this.#transition(receipt.workUnitId, "VERIFYING", "VERIFIED", "Ops recovery evidence replayed");
      }
    }
  }

  #recordReceipt(
    actionId: string,
    scopeId: string,
    outcome: string,
    opsRecoveryEvidence: { ref: string; sha256: string },
  ): void {
    if (this.#hasReceipt(actionId)) return;
    const projection = Object.values(this.options.store.load().workUnits)
      .find((candidate) => repairScopeId(candidate) === scopeId);
    if (projection === undefined) return;
    const recoveryBytes = this.options.readRecoveryEvidence(opsRecoveryEvidence);
    const persistedRecoveryEvidence = this.options.store.artifacts.put(recoveryBytes);
    const recoveryEvidence: HashedArtifactRef = {
      ref: persistedRecoveryEvidence.ref,
      hash: persistedRecoveryEvidence.hash,
    };
    if (recoveryEvidence.hash !== `sha256:${opsRecoveryEvidence.sha256}`) {
      throw new Error(`Ops recovery evidence hash mismatch: ${actionId}`);
    }
    const receipt: ProjectedReceipt = {
      version: 1,
      actionId,
      workUnitId: projection.unit.workUnitId,
      scopeId,
      outcome,
      recordedAt: this.#now(),
      recoveryEvidence,
      opsRecoveryEvidence,
    };
    const saved = this.options.store.artifacts.put(canonicalJson(receipt));
    const current = this.options.store.load().workUnits[projection.unit.workUnitId]!;
    this.options.store.append({
      version: 1,
      eventId: this.#id("event-repair-ops-receipt"),
      at: this.#now(),
      type: "repair/receipt-recorded",
      payload: {
        workUnitId: projection.unit.workUnitId,
        expectedRevision: current.revision,
        revision: current.revision + 1,
        repairId: actionId,
        receipt: { ref: saved.ref, hash: saved.hash },
      },
    });
    this.options.failpoint?.("after-receipt");
  }

  #transition(
    workUnitId: string,
    from: "REPAIR_READY" | "REPAIRING" | "VERIFYING",
    to: "REPAIRING" | "VERIFYING" | "VERIFIED" | "QUARANTINED",
    reason: string,
  ): void {
    const projection = this.options.store.load().workUnits[workUnitId];
    if (projection === undefined || projection.state !== from) return;
    this.options.store.append({
      version: 1,
      eventId: this.#id("event-repair-ops-transition"),
      at: this.#now(),
      type: "work-unit/transitioned",
      payload: {
        workUnitId,
        expectedRevision: projection.revision,
        revision: projection.revision + 1,
        from,
        to,
        reason,
      },
    });
  }

  #hasReceipt(actionId: string): boolean {
    return this.options.store.events().some((event) =>
      event.type === "repair/receipt-recorded" && event.payload.repairId === actionId);
  }

  #hasVerification(actionId: string): boolean {
    return this.options.store.events().some((event) =>
      event.type === "repair/verification-recorded" && event.payload.repairId === actionId);
  }

  #receipts(): Array<{ receipt: ProjectedReceipt; evidence: HashedArtifactRef }> {
    return this.options.store.events()
      .filter((event) => event.type === "repair/receipt-recorded")
      .map((event) => {
        if (event.type !== "repair/receipt-recorded") throw new Error("unreachable receipt event");
        const raw = JSON.parse(this.options.store.artifacts.read(event.payload.receipt.ref).toString("utf8")) as unknown;
        const receipt = parseReceipt(raw);
        if (receipt.actionId !== event.payload.repairId || receipt.workUnitId !== event.payload.workUnitId) {
          throw new Error(`Shepherd repair receipt event binding mismatch: ${event.payload.repairId}`);
        }
        return { receipt, evidence: event.payload.receipt };
      })
      .sort((a, b) => a.receipt.actionId.localeCompare(b.receipt.actionId));
  }
}

function isTerminalOutcome(value: string): boolean {
  return (ACTION_OUTCOMES as readonly string[]).includes(value);
}

function terminalDecision(outcome: string): "pass" | "fail" | "inconclusive" {
  if (outcome === "succeeded" || outcome === "not-needed") return "pass";
  if (outcome === "failed") return "fail";
  return "inconclusive";
}

function parseReceipt(raw: unknown): ProjectedReceipt {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid Shepherd Ops repair receipt");
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.actionId !== "string" ||
      typeof value.workUnitId !== "string" || typeof value.scopeId !== "string" ||
      typeof value.outcome !== "string" || typeof value.recordedAt !== "string") {
    throw new Error("invalid Shepherd Ops repair receipt fields");
  }
  return value as unknown as ProjectedReceipt;
}
