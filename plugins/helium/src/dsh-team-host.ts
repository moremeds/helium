import {
  ISOLATION_CLASSES,
  type AgentResult,
  type ExecutionLease,
  type Executor,
  type LeaseStore,
  type WorkOrder,
} from "@helium/core";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { ExecutorRegistry } from "./executor-registry.js";

export interface TeamParentHandle {
  parent: unknown;
  resumed: boolean;
  dispose(): Promise<void>;
}

export interface TeamParentFactory {
  ensure(input: {
    teamRunId: string;
    workspace: string;
    signal?: AbortSignal;
  }): Promise<TeamParentHandle>;
}

export interface TeamSubagentTerminal {
  output: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structured?: unknown;
  diagnostic?: string;
  stopReason: string;
}

export interface TeamSubagentRun {
  id: unknown;
  result: Promise<TeamSubagentTerminal>;
  dispose(): Promise<void>;
}

export interface TeamSubagentRuntime {
  start(
    providerName: string,
    request: {
      prompt: Array<{ type: "text"; text: string }>;
      parent: unknown;
      signal: AbortSignal;
      agentOptions: Record<string, unknown>;
      outputSchema: object;
      maxDepth: number;
      toolFilter: { allow: string[] };
      persona: string;
    },
  ): Promise<TeamSubagentRun>;
  drainDescendants(parent: unknown): Promise<void>;
  followup(
    parent: unknown,
    childId: unknown,
    content: Array<{ type: "text"; text: string }>,
    signal: AbortSignal,
  ): Promise<unknown>;
  interrupt(childId: unknown, parent: unknown): void;
  listChildren(parent: unknown, signal?: AbortSignal): Promise<unknown[]>;
  listDescendants(parent: unknown, signal?: AbortSignal): Promise<unknown[]>;
}

export interface DshSubagentExecutor extends Executor {
  readonly isolationClass: "in-process";
  readonly dsh: {
    providerName: string;
    agentOptions: Record<string, unknown>;
    persona: string;
  };
  fromSubagentResult(
    work: WorkOrder,
    result: TeamSubagentTerminal,
    elapsedMs: number,
  ): AgentResult;
  failureResult(
    work: WorkOrder,
    failureClass: "tool-boundary-violation" | "provider-error" | "cancelled",
    detail: string,
  ): AgentResult;
}

const RANK: Readonly<Record<string, number>> = Object.fromEntries(
  ISOLATION_CLASSES.map((value, index) => [value, index]),
);

function isDshExecutor(executor: Executor): executor is DshSubagentExecutor {
  const candidate = executor as Partial<DshSubagentExecutor>;
  return (
    executor.isolationClass === "in-process" &&
    typeof candidate.dsh?.providerName === "string" &&
    typeof candidate.fromSubagentResult === "function" &&
    typeof candidate.failureResult === "function"
  );
}

export class DshTeamHost {
  readonly #registry: ExecutorRegistry;
  readonly #leases: LeaseStore;
  readonly #subagents: TeamSubagentRuntime;
  readonly #parents: TeamParentFactory;
  readonly #workspacesDir: string;
  readonly #env: Record<string, string>;
  readonly #mcpConfigPath?: string;
  readonly #outputSchemaFor: (schemaId: string) => object;
  readonly #maxDepth: number;
  readonly #parentHandles = new Map<string, Promise<TeamParentHandle>>();

  constructor(input: {
    registry: ExecutorRegistry;
    leases: LeaseStore;
    subagents: TeamSubagentRuntime;
    parents: TeamParentFactory;
    workspacesDir: string;
    env: Record<string, string>;
    mcpConfigPath?: string;
    outputSchemaFor(schemaId: string): object;
    maxDepth: number;
  }) {
    if (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0) {
      throw new Error("team subagent maxDepth must be a non-negative safe integer");
    }
    this.#registry = input.registry;
    this.#leases = input.leases;
    this.#subagents = input.subagents;
    this.#parents = input.parents;
    this.#workspacesDir = input.workspacesDir;
    this.#env = { ...input.env };
    this.#mcpConfigPath = input.mcpConfigPath;
    this.#outputSchemaFor = input.outputSchemaFor;
    this.#maxDepth = input.maxDepth;
  }

  async run(
    teamRunId: string,
    work: WorkOrder,
    lease: ExecutionLease,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const executor = this.#registry.get(lease.targetId);
    if (executor === undefined) {
      throw new Error(`missing target: ${String(lease.targetId)}`);
    }
    if (!isDshExecutor(executor)) {
      return await this.#registry.run({
        work,
        lease,
        leases: this.#leases,
        workspacesDir: this.#workspacesDir,
        env: this.#env,
        ...(this.#mcpConfigPath === undefined
          ? {}
          : { mcpConfigPath: this.#mcpConfigPath }),
        signal,
      });
    }

    this.#leases.consume(lease.id, work.id);
    if (
      RANK[executor.isolationClass] <
      RANK[work.constraints.minIsolationClass]
    ) {
      return executor.failureResult(
        work,
        "tool-boundary-violation",
        `work requires ${work.constraints.minIsolationClass}; target demonstrates ${executor.isolationClass}`,
      );
    }

    const parent = await this.#parent(teamRunId, signal);
    const startedAt = Date.now();
    let run: TeamSubagentRun | undefined;
    try {
      run = await this.#subagents.start(executor.dsh.providerName, {
        prompt: [
          {
            type: "text",
            text:
              work.inputs.prompt ??
              `Complete ${work.taskClass} using artifacts ${work.inputs.artifacts.join(", ")}`,
          },
        ],
        parent: parent.parent,
        signal,
        agentOptions: { ...executor.dsh.agentOptions },
        outputSchema: this.#outputSchemaFor(work.acceptance.outputSchema),
        maxDepth: this.#maxDepth,
        toolFilter: { allow: [...work.constraints.tools] },
        persona: executor.dsh.persona,
      });
      const terminal = await run.result;
      return executor.fromSubagentResult(
        work,
        terminal,
        Date.now() - startedAt,
      );
    } catch (error) {
      return executor.failureResult(
        work,
        signal.aborted ? "cancelled" : "provider-error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await run?.dispose();
    }
  }

  async closeTeam(teamRunId: string): Promise<void> {
    const pending = this.#parentHandles.get(teamRunId);
    if (pending === undefined) return;
    this.#parentHandles.delete(teamRunId);
    const handle = await pending;
    await this.#subagents.drainDescendants(handle.parent);
    await handle.dispose();
  }

  async followup(
    teamRunId: string,
    childId: unknown,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const parent = await this.#parent(teamRunId, signal);
    return await this.#subagents.followup(
      parent.parent,
      childId,
      [{ type: "text", text }],
      signal,
    );
  }

  async interrupt(teamRunId: string, childId: unknown): Promise<void> {
    const parent = await this.#parent(teamRunId, new AbortController().signal);
    this.#subagents.interrupt(childId, parent.parent);
  }

  async listChildren(
    teamRunId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const parent = await this.#parent(
      teamRunId,
      signal ?? new AbortController().signal,
    );
    return await this.#subagents.listChildren(parent.parent, signal);
  }

  async listDescendants(
    teamRunId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const parent = await this.#parent(
      teamRunId,
      signal ?? new AbortController().signal,
    );
    return await this.#subagents.listDescendants(parent.parent, signal);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#parentHandles.keys()].map((id) => this.closeTeam(id)));
    await this.#registry.drain();
  }

  #parent(teamRunId: string, signal: AbortSignal): Promise<TeamParentHandle> {
    const existing = this.#parentHandles.get(teamRunId);
    if (existing !== undefined) return existing;
    const workspace = join(this.#workspacesDir, teamRunId, "host");
    const pending = this.#parents.ensure({ teamRunId, workspace, signal });
    this.#parentHandles.set(teamRunId, pending);
    void pending.catch(() => {
      if (this.#parentHandles.get(teamRunId) === pending) {
        this.#parentHandles.delete(teamRunId);
      }
    });
    return pending;
  }
}

type TeamHostContext = Pick<
  Context,
  "agents" | "sessions" | "sessionPersistence" | "subagents"
>;

function parentSessionId(teamRunId: string) {
  return SessionId(
    `helium-team-${createHash("sha256").update(teamRunId).digest("hex").slice(0, 32)}`,
  );
}

/** DSH-backed durable parent owner. The parent never schedules; Helium does. */
export class CordisTeamParentFactory implements TeamParentFactory {
  constructor(private readonly ctx: TeamHostContext) {}

  async ensure(input: {
    teamRunId: string;
    workspace: string;
    signal?: AbortSignal;
  }): Promise<TeamParentHandle> {
    mkdirSync(input.workspace, { recursive: true });
    const id = parentSessionId(input.teamRunId);
    if (this.ctx.agents.get(id) !== undefined) {
      throw new Error(`team parent already has a live owner: ${String(id)}`);
    }
    const persisted = (await this.ctx.sessionPersistence.list(input.signal)).some(
      (header: SessionHeader) => header.id === id,
    );
    const handle = persisted
      ? await this.ctx.agents.resume({
          resumeSessionId: id,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : await this.ctx.agents.create({
          sessionId: id,
          meta: { cwd: input.workspace },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    if (!persisted) {
      // A session with no events may be absent from lazy persistence. This
      // harmless, known log-only event materializes the host identity without
      // waking the parent or creating a model turn.
      handle.agent.session.append("todo/write", { todos: [] });
      await this.ctx.sessions.flush(handle.agent.session);
    }
    return {
      parent: handle.agent,
      resumed: persisted,
      dispose: async () => {
        await this.ctx.sessions.flush(handle.agent.session);
        await handle.dispose();
      },
    };
  }
}

/** Exact adapter over the pinned DSH lifecycle service. */
export class CordisTeamSubagentRuntime implements TeamSubagentRuntime {
  constructor(private readonly runtime: SubagentRuntime) {}

  async start(
    providerName: string,
    request: Parameters<TeamSubagentRuntime["start"]>[1],
  ): Promise<TeamSubagentRun> {
    const run = await this.runtime.start(providerName, request as never);
    return {
      id: run.id,
      result: run.result as Promise<TeamSubagentTerminal>,
      dispose: () => run.dispose(),
    };
  }

  async drainDescendants(parent: unknown): Promise<void> {
    await this.runtime.drainContinuableDescendants([parent as Agent]);
  }

  async followup(
    parent: unknown,
    childId: unknown,
    content: Array<{ type: "text"; text: string }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.runtime.followup(
      parent as Agent,
      childId as never,
      content,
      { signal, source: { kind: "user" } } as never,
    );
  }

  interrupt(childId: unknown, parent: unknown): void {
    this.runtime.interrupt(childId as never, {
      kind: "ancestor",
      agent: parent as Agent,
    });
  }

  async listChildren(parent: unknown, signal?: AbortSignal): Promise<unknown[]> {
    return await this.runtime.listChildren((parent as Agent).session.id, signal);
  }

  async listDescendants(
    parent: unknown,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    return await this.runtime.listDescendants((parent as Agent).session.id, signal);
  }
}
