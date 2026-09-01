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
// Type-only, same erased-at-emit idiom as the line above: 0.1.2 shrank the base
// SessionEventMap to 12 lifecycle keys and moved `todo/write` into this
// package's `declare module` merge. See the append() call below.
import type {} from "@deepseek-ai/dsh-tool-todo";
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
  effectiveReasoningEffort?: string;
  providerFailure?: {
    code: string;
    status?: number;
    retryAfterMs?: number;
  };
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
  readonly #observeResult: (result: AgentResult) => void;
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
    observeResult(result: AgentResult): void;
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
    this.#observeResult = input.observeResult;
  }

  async run(
    teamRunId: string,
    work: WorkOrder,
    lease: ExecutionLease,
    signal: AbortSignal,
    context?: { env?: Record<string, string>; mcpConfigPath?: string },
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
        env: context?.env ?? this.#env,
        ...((context?.mcpConfigPath ?? this.#mcpConfigPath) === undefined
          ? {}
          : { mcpConfigPath: context?.mcpConfigPath ?? this.#mcpConfigPath }),
        signal,
      });
    }

    this.#leases.consume(lease.id, work.id);
    if (
      RANK[executor.isolationClass] <
      RANK[work.constraints.minIsolationClass]
    ) {
      const result = executor.failureResult(
        work,
        "tool-boundary-violation",
        `work requires ${work.constraints.minIsolationClass}; target demonstrates ${executor.isolationClass}`,
      );
      this.#observeResult(result);
      return result;
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
      const terminal = await new Promise<TeamSubagentTerminal>((resolve, reject) => {
        const abort = () => {
          try {
            this.#subagents.interrupt(run!.id, parent.parent);
          } finally {
            reject(new Error("team subagent cancelled"));
          }
        };
        void run!.result.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
      const result = executor.fromSubagentResult(
        work,
        terminal,
        Date.now() - startedAt,
      );
      this.#observeResult(result);
      return result;
    } catch (error) {
      const result = executor.failureResult(
        work,
        signal.aborted ? "cancelled" : "provider-error",
        error instanceof Error ? error.message : String(error),
      );
      this.#observeResult(result);
      return result;
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
      //
      // KNOWN CONSTRAINT, introduced by dsh 0.1.2 — do not read this call as
      // blessed. @deepseek-ai/dsh-tool-todo now ships a package-owned invariant
      // that rejects exactly this call:
      //   if (!trace.open) fail("todo/write appended outside any open turn")
      // (dsh-tool-todo/lib/invariant.js:43). 0.1.1-rc.2's invariant file had no
      // turn check at all, so the upgrade is what made this invalid.
      //
      // It does not throw today because nothing mounts that invariant:
      // dsh-base/cordis.patch.yml:411 registers the tool (id `tool-todo`) but no
      // invariant, and no bundle here mounts @deepseek-ai/dsh-invariants. The
      // durable log nevertheless now holds an event upstream defines as invalid,
      // and any future invariant mount turns that into a hard failure. The fix is
      // a helium-owned log-only event declared in helium's own SessionEventMap
      // merge; that is a behaviour change, not a version bump, so it is tracked
      // separately rather than smuggled into this upgrade.
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
    const result = run.result.then((terminal) => {
      const events = run.localAgent?.session.events as
        | Array<{
            type: string;
            data?: {
              header?: { config?: { reasoningEffort?: unknown } };
              reason?: {
                kind?: unknown;
                error?: {
                  code?: unknown;
                  status?: unknown;
                  providerRetryAfterMs?: unknown;
                };
              };
            };
          }>
        | undefined;
      const request = events?.findLast((event) => event.type === "request/header");
      const ended = events?.findLast((event) => event.type === "turn/end");
      const effort = request?.data?.header?.config?.reasoningEffort;
      const failure = ended?.data?.reason?.error;
      return {
        output: terminal.output as TeamSubagentTerminal["output"],
        ...(terminal.structured === undefined ? {} : { structured: terminal.structured }),
        ...(terminal.diagnostic === undefined ? {} : { diagnostic: terminal.diagnostic }),
        stopReason: terminal.stopReason,
        ...(typeof effort === "string" ? { effectiveReasoningEffort: effort } : {}),
        ...(typeof failure?.code !== "string"
          ? {}
          : {
              providerFailure: {
                code: failure.code,
                ...(typeof failure.status === "number" ? { status: failure.status } : {}),
                ...(typeof failure.providerRetryAfterMs === "number"
                  ? { retryAfterMs: failure.providerRetryAfterMs }
                  : {}),
              },
            }),
      };
    });
    return {
      id: run.id,
      result,
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
