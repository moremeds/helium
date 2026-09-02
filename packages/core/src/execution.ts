/**
 * The model-blind execution boundary: what an executor is, the context it is
 * handed, and the conformance record that admits it.
 *
 * The `Executor` interface first exists here. It INHERITS the
 * execution-boundary contract already shipped as a harness and does not
 * redefine it: the harness is still the only place the assertions live, so a
 * second execution backend cannot quietly grade itself on an easier exam.
 *
 * v2 note: leases are gone. They were mutual exclusion for a mutating ops lane
 * that no longer exists; a run's blast radius is now the sandbox it runs in.
 * @module @helium/core/execution
 */
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
