import { randomUUID } from "node:crypto";
import type { AppendCoordination } from "./append-coordination.js";
import type { ShepherdEvent } from "./events.js";
import type { ShepherdStore } from "./store.js";
import type { ShepherdState } from "./work-unit.js";

export interface ShepherdAttemptLease {
  workUnitId: string;
  attemptId: string;
  leaseId: string;
  ownerId: string;
  expiresAt: string;
}

export type LeaseDecision =
  | { acquired: true; lease: ShepherdAttemptLease }
  | { acquired: false; reason: "append-lock-held" | "active-lease" | "unknown-work-unit" };

export interface AttemptOutcome {
  outcome: "completed" | "no-op" | "quota-exhausted" | "temporary-unavailable" | "awaiting-user" | "failed" | "uncertain";
  availabilityDomain?: string;
  retryAt?: string;
  nextState?: ShepherdState;
}

export interface ReconciliationResult {
  readOnlyExpired: string[];
  mutationRecovery: Array<ShepherdAttemptLease & {
    operation: "stage" | "publish" | "rollback";
  }>;
}

export interface ShepherdCoordinatorOptions {
  ownerId: string;
  now?: () => string;
  id?: (prefix: string) => string;
}

export class ShepherdCoordinator {
  readonly #now: () => string;
  readonly #id: (prefix: string) => string;

  constructor(
    private readonly store: ShepherdStore,
    private readonly coordination: AppendCoordination,
    private readonly options: ShepherdCoordinatorOptions,
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  lease(workUnitId: string, expiresAt: string): LeaseDecision {
    const result = this.coordination.run<LeaseDecision>(() => {
      const unit = this.store.load().workUnits[workUnitId];
      if (unit === undefined) return { acquired: false, reason: "unknown-work-unit" };
      if (unit.activeLease !== undefined) return { acquired: false, reason: "active-lease" };
      const lease: ShepherdAttemptLease = {
        workUnitId,
        attemptId: this.#id("attempt"),
        leaseId: this.#id("lease"),
        ownerId: this.options.ownerId,
        expiresAt,
      };
      this.store.append({
        version: 1,
        eventId: this.#id("event"),
        at: this.#now(),
        type: "attempt/lease-acquired",
        payload: {
          workUnitId,
          expectedRevision: unit.revision,
          revision: unit.revision + 1,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
          ownerId: lease.ownerId,
          expiresAt,
        },
      });
      return { acquired: true, lease };
    });
    return result.acquired ? result.value : { acquired: false, reason: "append-lock-held" };
  }

  recordIntent(
    lease: ShepherdAttemptLease,
    operation: "probe" | "analysis" | "stage" | "publish" | "verify" | "rollback",
  ): void {
    this.#withLease(lease, (revision) => ({
      version: 1,
      eventId: this.#id("event"),
      at: this.#now(),
      type: "attempt/execution-intent",
      payload: {
        workUnitId: lease.workUnitId,
        expectedRevision: revision,
        revision: revision + 1,
        attemptId: lease.attemptId,
        leaseId: lease.leaseId,
        operation,
      },
    }));
  }

  recordOutcome(lease: ShepherdAttemptLease, outcome: AttemptOutcome): void {
    const coordinated = this.coordination.run(() => {
      let unit = this.#requireLease(lease);
      this.store.append({
        version: 1,
        eventId: this.#id("event"),
        at: this.#now(),
        type: "attempt/outcome-recorded",
        payload: {
          workUnitId: lease.workUnitId,
          expectedRevision: unit.revision,
          revision: unit.revision + 1,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
          outcome: outcome.outcome,
          ...(outcome.availabilityDomain === undefined ? {} : { availabilityDomain: outcome.availabilityDomain }),
          ...(outcome.retryAt === undefined ? {} : { retryAt: outcome.retryAt }),
          ...(outcome.nextState === undefined ? {} : { nextState: outcome.nextState }),
        },
      });
      if (outcome.outcome !== "quota-exhausted" && outcome.outcome !== "temporary-unavailable") return;
      if (outcome.availabilityDomain === undefined || outcome.retryAt === undefined) {
        throw new Error("quota exhaustion requires availability domain and retry time");
      }
      unit = this.store.load().workUnits[lease.workUnitId]!;
      this.store.append({
        version: 1,
        eventId: this.#id("event"),
        at: this.#now(),
        type: "work-unit/retry-scheduled",
        payload: {
          workUnitId: lease.workUnitId,
          expectedRevision: unit.revision,
          revision: unit.revision + 1,
          wakeAt: outcome.retryAt,
          trigger: "provider-availability",
          reason: "provider quota exhausted",
          domain: outcome.availabilityDomain,
        },
      });
    });
    if (!coordinated.acquired) throw new Error("append coordination lock held");
  }

  reconcileExpired(): ReconciliationResult {
    const coordinated = this.coordination.run(() => {
      const result: ReconciliationResult = { readOnlyExpired: [], mutationRecovery: [] };
      for (const unit of Object.values(this.store.load().workUnits)) {
        const active = unit.activeLease;
        if (active === undefined || Date.parse(active.expiresAt) > Date.parse(this.#now())) continue;
        if (active.operation === "stage" || active.operation === "publish" || active.operation === "rollback") {
          result.mutationRecovery.push({
            workUnitId: unit.unit.workUnitId,
            attemptId: active.attemptId,
            leaseId: active.leaseId,
            ownerId: active.ownerId,
            expiresAt: active.expiresAt,
            operation: active.operation,
          });
          continue;
        }
        const current = this.store.load().workUnits[unit.unit.workUnitId]!;
        this.store.append({
          version: 1,
          eventId: this.#id("event"),
          at: this.#now(),
          type: "attempt/lease-expired",
          payload: {
            workUnitId: unit.unit.workUnitId,
            expectedRevision: current.revision,
            revision: current.revision + 1,
            attemptId: active.attemptId,
            leaseId: active.leaseId,
          },
        });
        result.readOnlyExpired.push(unit.unit.workUnitId);
      }
      return result;
    });
    return coordinated.acquired
      ? coordinated.value
      : { readOnlyExpired: [], mutationRecovery: [] };
  }

  #withLease(lease: ShepherdAttemptLease, event: (revision: number) => ShepherdEvent): void {
    const coordinated = this.coordination.run(() => {
      const unit = this.#requireLease(lease);
      this.store.append(event(unit.revision));
    });
    if (!coordinated.acquired) throw new Error("append coordination lock held");
  }

  #requireLease(lease: ShepherdAttemptLease) {
    const unit = this.store.load().workUnits[lease.workUnitId];
    if (unit?.activeLease?.leaseId !== lease.leaseId ||
        unit.activeLease.attemptId !== lease.attemptId) {
      throw new Error(`attempt lease mismatch: ${lease.attemptId}/${lease.leaseId}`);
    }
    return unit;
  }
}
