import {
  ExecutionTargetId,
  select,
  type CapabilityCatalog,
  type ExecutionLease,
  type LeaseStore,
  type SelectionDecision,
  type SelectionPolicy,
  type TargetSnapshot,
  type WorkOrder,
} from "@helium/core";
import {
  parseActiveExactTargetOverride,
  type ExactTargetOverride,
} from "./exact-target-override.js";

export interface RoutingAuditRecord {
  at: string;
  mode: "normal" | "exact-target";
  workId: string;
  policyVersion: string;
  catalogVersion: string;
  decision: SelectionDecision;
  targetSnapshot?: TargetSnapshot;
  override?: ExactTargetOverride;
}

export interface RoutingResult {
  decision: SelectionDecision;
  lease?: ExecutionLease;
  audit: RoutingAuditRecord;
}

export class RoutingService {
  readonly #catalog: CapabilityCatalog;
  readonly #leases: LeaseStore;
  readonly #policy: SelectionPolicy;
  readonly #now: () => Date;
  readonly #audit: (record: RoutingAuditRecord) => void;

  constructor(input: {
    catalog: CapabilityCatalog;
    leases: LeaseStore;
    policy: SelectionPolicy;
    now?: () => Date;
    audit: (record: RoutingAuditRecord) => void;
  }) {
    this.#catalog = input.catalog;
    this.#leases = input.leases;
    this.#policy = input.policy;
    this.#now = input.now ?? (() => new Date());
    if (typeof input.audit !== "function") {
      throw new Error("routing audit sink is required");
    }
    this.#audit = input.audit;
  }

  route(input: {
    work: WorkOrder;
    exactTarget?: unknown;
    reservedCost: number;
    leaseExpiresAt: string;
  }): RoutingResult {
    const now = this.#now();
    if (!Number.isFinite(input.reservedCost) || input.reservedCost < 0) {
      throw new Error("reserved cost must be finite and non-negative");
    }
    if (
      input.work.constraints.maxCost !== undefined &&
      input.reservedCost > input.work.constraints.maxCost
    ) {
      throw new Error(
        `reserved cost ${input.reservedCost} exceeds work limit ${input.work.constraints.maxCost}`,
      );
    }
    if (Date.parse(input.leaseExpiresAt) <= now.getTime()) {
      throw new Error(`lease expiry is not in the future: ${input.leaseExpiresAt}`);
    }

    const snapshot = this.#catalog.snapshot(now);
    const override =
      input.exactTarget === undefined
        ? undefined
        : parseActiveExactTargetOverride(input.exactTarget, now);
    if (
      override !== undefined &&
      Date.parse(input.leaseExpiresAt) > Date.parse(override.expiresAt)
    ) {
      throw new Error("lease expiry exceeds exact-target authority expiry");
    }
    const policy =
      override === undefined
        ? this.#policy
        : {
            policyVersion: `${this.#policy.policyVersion}:exact-target`,
            roles: {
              [input.work.role]: {
                preferred: ExecutionTargetId(override.targetRef),
                fallback: [],
              },
            },
          };
    const decision = select(input.work, policy, snapshot);
    const chosenId = decision.selected ??
      (override === undefined ? undefined : ExecutionTargetId(override.targetRef));
    const targetSnapshot = chosenId === undefined
      ? undefined
      : snapshot.targets.find((target) => target.targetId === chosenId);
    const audit: RoutingAuditRecord = {
      at: now.toISOString(),
      mode: override === undefined ? "normal" : "exact-target",
      workId: input.work.id,
      policyVersion: policy.policyVersion,
      catalogVersion: snapshot.catalogVersion,
      decision,
      ...(targetSnapshot === undefined ? {} : { targetSnapshot }),
      ...(override === undefined ? {} : { override }),
    };
    // Audit before lease issuance: a failed durable sink cannot leave an
    // authorized-but-unrecorded execution reservation behind.
    this.#audit(audit);
    if (decision.selected === undefined) return { decision, audit };
    const lease = this.#leases.issue({
      targetId: decision.selected,
      workId: input.work.id,
      reservedCost: input.reservedCost,
      expiresAt: input.leaseExpiresAt,
    });
    return { decision, lease, audit };
  }
}
