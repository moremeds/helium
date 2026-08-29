/**
 * The `ActionLease`: the MUTATION-plane lease.
 *
 * Deliberately distinct from the work-execution `ExecutionLease` of the
 * multi-agent plan. That one authorizes a model call; this one authorizes a
 * side effect on a real component, and the two must never be conflated or
 * share a store.
 *
 * The property under test is **at most one active lease**, not exactly-once
 * execution. A losing controller correctly does nothing; a crashed winner
 * reconciles rather than retries. An arbitrary external script cannot be made
 * to run exactly once, and claiming otherwise hides the case the reconciler
 * exists to handle.
 *
 * Exclusivity is per COMPONENT, not per key. Two different SOPs mutating one
 * component at the same time is the same disaster as one SOP running twice.
 * @module @helium/core/operations/lease
 */
import { z } from "zod";
import { OpsIdSchema } from "./component.js";

export const ActionLeaseKeySchema = z.strictObject({
  componentId: OpsIdSchema,
  incidentId: OpsIdSchema,
  sopId: OpsIdSchema,
  /** The FULL digest, not just the version: an SOP can be edited in place. */
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  attempt: z.number().int().positive(),
});
export type ActionLeaseKey = z.infer<typeof ActionLeaseKeySchema>;

export interface ActionLease {
  leaseId: string;
  key: ActionLeaseKey;
  /** Stable across replays of the same reservation. */
  operationId: string;
  acquiredAt: string;
  expiresAt: string;
  /** The table revision this lease was written at. */
  revision: number;
}

export type LeaseAcquisition =
  | { ok: true; lease: ActionLease }
  | { ok: false; reason: "lease-held" | "stale-revision"; holder?: ActionLease };

export type LeaseRelease =
  | { ok: true }
  | { ok: false; reason: "unknown-lease" | "release-mismatch" };

export function leaseKeyOf(key: ActionLeaseKey): string {
  return [key.componentId, key.incidentId, key.sopId, key.sopDigest, key.attempt].join(
    "|",
  );
}

export class ActionLeaseTable {
  /** componentId -> the one lease that may mutate it. */
  readonly #byComponent = new Map<string, ActionLease>();
  readonly #reservations = new Map<string, string>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  /** The active lease on a component, or undefined when free or expired. */
  active(componentId: string, now: Date): ActionLease | undefined {
    const lease = this.#byComponent.get(componentId);
    if (lease === undefined) return undefined;
    return Date.parse(lease.expiresAt) > now.getTime() ? lease : undefined;
  }

  /**
   * Compare-and-swap acquire.
   *
   * @param expectedRevision - when supplied, the acquire is refused unless the
   * table is still at that revision. This is what makes a lost update
   * detectable rather than silently overwriting a decision made from a state
   * the caller has not seen.
   */
  acquire(input: {
    key: ActionLeaseKey;
    leaseId: string;
    operationId: string;
    now: Date;
    ttlMs: number;
    expectedRevision?: number;
  }): LeaseAcquisition {
    const key = ActionLeaseKeySchema.parse(input.key);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== this.#revision
    ) {
      return { ok: false, reason: "stale-revision" };
    }

    const holder = this.active(key.componentId, input.now);
    if (holder !== undefined) {
      return { ok: false, reason: "lease-held", holder };
    }

    this.reserve(input.operationId, leaseKeyOf(key));
    this.#revision += 1;
    const lease: ActionLease = {
      leaseId: input.leaseId,
      key,
      operationId: input.operationId,
      acquiredAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
      revision: this.#revision,
    };
    this.#byComponent.set(key.componentId, lease);
    return { ok: true, lease };
  }

  release(leaseId: string, componentId: string): LeaseRelease {
    const holder = this.#byComponent.get(componentId);
    if (holder === undefined) return { ok: false, reason: "unknown-lease" };
    // Releasing someone else's lease is how a slow controller frees a
    // component another one is actively mutating.
    if (holder.leaseId !== leaseId) return { ok: false, reason: "release-mismatch" };
    this.#byComponent.delete(componentId);
    this.#revision += 1;
    return { ok: true };
  }

  /**
   * Reserve a stable recovery operation id.
   *
   * Replaying the same reservation is a no-op -- that is what makes recovery
   * after a crash safe. Replaying the same id with DIFFERENT values is
   * corruption, not a retry, and throws.
   */
  reserve(operationId: string, value: string): void {
    const existing = this.#reservations.get(operationId);
    if (existing === undefined) {
      this.#reservations.set(operationId, value);
      return;
    }
    if (existing !== value) {
      throw new Error(
        `operation id ${operationId} was reserved for a different lease`,
      );
    }
  }

  reservationOf(operationId: string): string | undefined {
    return this.#reservations.get(operationId);
  }
}

/** One controller's view of a shared lease table. */
export class ActionLeaseController {
  constructor(
    private readonly table: ActionLeaseTable,
    private readonly opts: { controllerId: string; ttlMs: number; now: () => Date },
  ) {}

  acquire(key: ActionLeaseKey): LeaseAcquisition {
    const now = this.opts.now();
    return this.table.acquire({
      key,
      leaseId: `${this.opts.controllerId}:${leaseKeyOf(key)}`,
      operationId: `op:${leaseKeyOf(key)}`,
      now,
      ttlMs: this.opts.ttlMs,
    });
  }

  release(leaseId: string, componentId: string): LeaseRelease {
    return this.table.release(leaseId, componentId);
  }
}
