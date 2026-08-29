/**
 * The model-blind execution boundary: what an executor is, the context it is
 * handed, the lease that authorizes one run, and the conformance record that
 * admits it.
 *
 * The `Executor` interface first exists here. It INHERITS the
 * execution-boundary contract Phase 0 already shipped as a harness and does
 * not redefine it: the harness is still the only place the assertions live, so
 * a second execution backend cannot quietly grade itself on an easier exam.
 * @module @helium/core/execution
 */
import { randomUUID } from "node:crypto";
import type { ExecutionTargetId } from "./capabilities.js";
import {
  ISOLATION_CLASSES,
  type AgentResult,
  type IsolationClass,
  type WorkOrder,
} from "./work.js";

export { ISOLATION_CLASSES, type IsolationClass } from "./work.js";

const RANK: Readonly<Record<string, number>> = Object.fromEntries(
  ISOLATION_CLASSES.map((c, i) => [c, i]),
);

/**
 * What the registry hands an executor for one run: the workspace it owns, the
 * complete environment it may pass on, the declared tool allow-list, and the
 * MCP config path if there is one.
 *
 * This is an addition to the interface sketched in the plan, and a load-bearing
 * one: without it no executor can be given a workspace, and the shared
 * conformance harness grades a subject precisely on whether its child stayed
 * inside the workspace it was handed and saw only the environment it was
 * declared.
 */
export interface ExecutionContext {
  workspace: string;
  env: Record<string, string>;
  allowedTools: string[];
  mcpConfigPath?: string;
}

export interface Executor {
  readonly targetId: ExecutionTargetId;
  /** What this executor's child actually inherits; proven, not asserted. */
  readonly isolationClass: IsolationClass;
  run(
    work: WorkOrder,
    signal: AbortSignal,
    context: ExecutionContext,
  ): Promise<AgentResult>;
  drain(): Promise<void>;
}

/**
 * Proof that an executor demonstrated a boundary.
 *
 * `basis` is deliberately explicit. `execution-boundary-conformance` means the
 * shared suite ran and graded the subject; `floor` means the executor declares
 * `in-process` and there is no boundary to demonstrate.
 *
 * The floor is not a loophole. The suite exists to catch a claim STRONGER than
 * reality -- an executor declaring `sandboxed` while demonstrating only
 * `in-process`. `in-process` is the weakest class there is, so it cannot be
 * over-claimed, and the shared suite cannot grade it in any case: every
 * assertion in that suite reads a report written by a spawned CLI child, and
 * an in-process executor has no child to write one. Admitting it at the floor
 * and refusing it any work that requires more is the honest handling; pretending
 * a suite ran would not be.
 */
export interface ConformanceRecord {
  targetId: ExecutionTargetId;
  provenClass: IsolationClass;
  basis: "execution-boundary-conformance" | "floor";
  recordedAt: string;
}

export function conformanceAtFloor(
  targetId: ExecutionTargetId,
): ConformanceRecord {
  return {
    targetId,
    provenClass: "in-process",
    basis: "floor",
    recordedAt: new Date(0).toISOString(),
  };
}

/** Whether a record proves at least the class an executor declares. */
export function isConformant(
  declared: IsolationClass,
  record: ConformanceRecord,
): boolean {
  return RANK[record.provenClass] >= RANK[declared];
}

export interface ExecutionLease {
  id: string;
  targetId: ExecutionTargetId;
  workId: string;
  /** Reserved, not charged. Budget is charged on completion from the ledger. */
  reservedCost: number;
  expiresAt: string;
}

/**
 * Leases are consumed exactly once, in process, and append-audited by their
 * caller. The store itself keeps no history: it is the mutual-exclusion
 * primitive, not the audit trail.
 */
export class LeaseStore {
  readonly #open = new Map<string, ExecutionLease>();

  issue(input: Omit<ExecutionLease, "id">): ExecutionLease {
    const lease: ExecutionLease = { id: randomUUID(), ...input };
    this.#open.set(lease.id, lease);
    return lease;
  }

  /**
   * @throws when the lease is unknown, already consumed, expired, or bound to
   * different work. A lease that authorizes anything other than the work it
   * names is not a lease.
   */
  consume(leaseId: string, workId: string, now: Date = new Date()): ExecutionLease {
    const lease = this.#open.get(leaseId);
    if (lease === undefined) {
      throw new Error(
        this.#consumed.has(leaseId)
          ? `lease already consumed: ${leaseId}`
          : `unknown lease: ${leaseId}`,
      );
    }
    if (lease.workId !== workId) {
      throw new Error(
        `lease work mismatch: ${leaseId} authorizes ${lease.workId}, not ${workId}`,
      );
    }
    if (Date.parse(lease.expiresAt) < now.getTime()) {
      throw new Error(`lease expired at ${lease.expiresAt}: ${leaseId}`);
    }
    this.#open.delete(leaseId);
    this.#consumed.add(leaseId);
    return lease;
  }

  readonly #consumed = new Set<string>();

  outstanding(): ExecutionLease[] {
    return [...this.#open.values()];
  }
}
