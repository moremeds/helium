/**
 * The executor registry: the ONE place a concrete execution mechanism appears.
 *
 * Core owns the model-blind `Executor` interface; this plugin owns the
 * concrete executors. Admission is the point of the module. An executor is
 * registered only against a conformance record that proves at least the class
 * it declares, so an executor claiming `sandboxed` while demonstrating only
 * `in-process` fails registration rather than downgrading silently.
 * @module dsh-plugin-helium/executor-registry
 */
import { randomUUID } from "node:crypto";
import { reapOrphanProviderProcesses } from "@helium/provider-sdk/process-receipt";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AgentResultSchema,
  ISOLATION_CLASSES,
  isConformant,
  type AgentResult,
  type ConformanceRecord,
  type ExecutionContext,
  type ExecutionLease,
  type ExecutionTargetId,
  type Executor,
  type IsolationClass,
  type LeaseStore,
  type WorkOrder,
} from "@helium/core";

const RANK: Readonly<Record<string, number>> = Object.fromEntries(
  ISOLATION_CLASSES.map((c, i) => [c, i]),
);

/**
 * The shape the shared execution-boundary harness accepts as a subject.
 *
 * Declared structurally rather than imported from `@helium/contracts`, so
 * production code carries no dependency on the contract suite. The harness
 * type is matched by structure; if it ever changes, the conformance contract
 * test stops compiling, which is where that breakage belongs.
 */
export interface BoundarySubjectLike {
  readonly name: string;
  readonly dialect?: "claude-cli" | "codex-cli";
  readonly declaredIsolationClass: IsolationClass;
  invoke(input: {
    prompt: string;
    allowedTools: string[];
    mcpConfigPath?: string;
    expectedWorkspace: string;
    env: Record<string, string>;
  }): Promise<{ text?: string }>;
}

/**
 * Present an `Executor` as a conformance subject, so every executor is graded
 * by the ONE suite Phase 0 shipped rather than by a second one of its own.
 */
export function asBoundarySubject(
  executor: Executor,
  name: string,
  dialect?: "claude-cli" | "codex-cli",
): BoundarySubjectLike {
  return {
    name,
    ...(dialect === undefined ? {} : { dialect }),
    declaredIsolationClass: executor.isolationClass,
    async invoke(input) {
      const work: WorkOrder = {
        id: `boundary-${randomUUID()}`,
        role: "execution-boundary-probe",
        taskClass: "conformance.boundary",
        requires: [],
        constraints: {
          tools: input.allowedTools,
          mutations: "forbidden",
          minIsolationClass: executor.isolationClass,
        },
        inputs: { artifacts: [], prompt: input.prompt },
        acceptance: { outputSchema: "boundary-report-v1" },
      };
      const result = await executor.run(work, new AbortController().signal, {
        workspace: input.expectedWorkspace,
        env: input.env,
        allowedTools: input.allowedTools,
        mcpConfigPath: input.mcpConfigPath,
      });
      return {
        text: typeof result.structured === "string" ? result.structured : undefined,
      };
    },
  };
}

export interface RegistryRunInput {
  work: WorkOrder;
  lease: ExecutionLease;
  leases: LeaseStore;
  /** Root under which each run is given its own empty workspace. */
  workspacesDir: string;
  env: Record<string, string>;
  mcpConfigPath?: string;
  now?: Date;
  signal?: AbortSignal;
}

export class ExecutorRegistry {
  readonly #executors = new Map<string, Executor>();
  readonly #conformance = new Map<string, ConformanceRecord>();
  readonly #onResult: (result: AgentResult) => void;

  constructor(input: { onResult(result: AgentResult): void }) {
    this.#onResult = input.onResult;
  }

  /**
   * @throws on a duplicate target, on a record issued for a different target,
   * or on a record that proves less than the executor declares.
   */
  register(executor: Executor, conformance: ConformanceRecord): () => void {
    const id = String(executor.targetId);
    if (this.#executors.has(id)) {
      throw new Error(`duplicate executor for target: ${id}`);
    }
    if (String(conformance.targetId) !== id) {
      throw new Error(
        `conformance record is for ${String(conformance.targetId)}, not ${id}`,
      );
    }
    if (!isConformant(executor.isolationClass, conformance)) {
      throw new Error(
        `${id} declares "${executor.isolationClass}" but its conformance record proves only "${conformance.provenClass}"`,
      );
    }
    this.#executors.set(id, executor);
    this.#conformance.set(id, conformance);
    return () => {
      this.#executors.delete(id);
      this.#conformance.delete(id);
    };
  }

  get(targetId: ExecutionTargetId): Executor | undefined {
    return this.#executors.get(String(targetId));
  }

  conformanceOf(targetId: ExecutionTargetId): ConformanceRecord | undefined {
    return this.#conformance.get(String(targetId));
  }

  list(): Executor[] {
    return [...this.#executors.values()];
  }

  /**
   * Resolve a lease to an executor and run one work order.
   *
   * The isolation check happens BEFORE `run()` is called, not after: a work
   * order that requires a stronger boundary than the resolved executor
   * demonstrates must never reach the executor at all, because by then the
   * child already exists.
   */
  async run(input: RegistryRunInput): Promise<AgentResult> {
    const { work, lease, leases, workspacesDir, env, mcpConfigPath } = input;
    const executor = this.#executors.get(String(lease.targetId));
    if (executor === undefined) {
      throw new Error(`missing target: ${String(lease.targetId)}`);
    }
    if (
      RANK[executor.isolationClass] < RANK[work.constraints.minIsolationClass]
    ) {
      throw new Error(
        `work ${work.id} requires "${work.constraints.minIsolationClass}" but ${String(lease.targetId)} demonstrates "${executor.isolationClass}"`,
      );
    }
    // Consumed only once the run is authorized: a lease burned on a rejected
    // dispatch would charge a reservation nothing ever ran against.
    leases.consume(lease.id, work.id, input.now ?? new Date());

    const workspace = join(workspacesDir, work.id, randomUUID());
    mkdirSync(workspace, { recursive: true });
    const context: ExecutionContext = {
      workspace,
      env,
      allowedTools: work.constraints.tools,
      mcpConfigPath,
    };

    try {
      const result = await executor.run(
        work,
        input.signal ?? new AbortController().signal,
        context,
      );
      // Normalized at the boundary: a provider adapter returning a shape core
      // does not accept fails here rather than downstream in the ledger.
      const parsed = AgentResultSchema.parse(result);
      this.#onResult(parsed);
      return parsed;
    } finally {
      // `run()` settles only after the executor's child has quiesced. Remove
      // exactly the UUID workspace this registry created, never its caller-owned root.
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.list().map((e) => e.drain()));
  }

  async reconcileOrphanProcesses(workspacesDir: string) {
    return await reapOrphanProviderProcesses(workspacesDir);
  }
}
