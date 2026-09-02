/**
 * The dsh runtime host, salvaged from v1's `dsh-team-host.ts` (design §8:
 * keep-trim, move here, be the only file naming `@deepseek-ai/*`).
 *
 * What was dropped in the move: the lease consume/expire dance, the executor
 * registry indirection and the isolation-class rank check. Leases were mutual
 * exclusion for a mutating ops lane v2 does not have, and blast radius is now
 * the sandbox a run is placed in. What survives is the part that works: a
 * durable parent session per run, and an exact adapter over the pinned
 * subagent lifecycle service.
 *
 * The run's SESSION LOG is what leaves this file for the audit projection.
 * Core folds it (`foldSessionLog`); nothing here computes a token count.
 * @module dsh-plugin-provider-dsh/host
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent, ModelSelection, WorkOrder } from "@helium/core";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-session-persistence";

export interface RunHandle {
  parent: unknown;
  resumed: boolean;
  dispose(): Promise<void>;
}

export interface RunParentFactory {
  ensure(input: {
    runId: string;
    workspace: string;
    signal?: AbortSignal;
  }): Promise<RunHandle>;
}

export interface SubagentTerminal {
  output: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structured?: unknown;
  diagnostic?: string;
  stopReason: string;
  /** The child's own append-only session log, for the audit fold. */
  events: LogEvent[];
  effectiveReasoningEffort?: string;
  providerFailure?: { code: string; status?: number; retryAfterMs?: number; message?: string };
}

export interface SubagentRun {
  id: unknown;
  result: Promise<SubagentTerminal>;
  dispose(): Promise<void>;
}

export interface DshSubagentRuntime {
  start(
    providerName: string,
    request: {
      prompt: Array<{ type: "text"; text: string }>;
      parent: unknown;
      signal: AbortSignal;
      agentOptions: Record<string, unknown>;
      outputSchema?: object;
      maxDepth: number;
      toolFilter?: { allow: string[] };
      persona: string;
    },
  ): Promise<SubagentRun>;
  drainDescendants(parent: unknown): Promise<void>;
  interrupt(childId: unknown, parent: unknown): void;
}

/**
 * Runs one work order on a dsh subagent and returns its text plus the session
 * log the audit projection folds. It does NOT summarise, price or count: those
 * are core's, precisely so a second runtime cannot compute them differently.
 */
export class DshHost {
  readonly #handles = new Map<string, Promise<RunHandle>>();

  constructor(
    private readonly deps: {
      subagents: DshSubagentRuntime;
      parents: RunParentFactory;
      workspacesDir: string;
      maxDepth: number;
      persona?: string;
    },
  ) {
    if (!Number.isSafeInteger(deps.maxDepth) || deps.maxDepth < 0) {
      throw new Error("subagent maxDepth must be a non-negative safe integer");
    }
  }

  async run(
    runId: string,
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<{ text: string; structured?: unknown; events: LogEvent[] }> {
    const parent = await this.#parent(runId, signal);
    // `providerName` is the subagent TRANSPORT the child is materialised on
    // (the name `dsh-subagent-spawn-in-process` registers itself under), never
    // an LLM vendor. It shipped once as "deepseek", which resolves to no
    // transport at all. It is stripped from agentOptions for the same reason:
    // the vendor there is `provider`.
    // `tools` comes out too: those are the tool IMPLEMENTATIONS the provider
    // registers, not a model option, and they must never be serialised into
    // the child's agent options.
    const { providerName, tools: _tools, ...agentOptions } = selection.options ?? {};
    const transport = String(providerName ?? "default");
    // An EMPTY allow-list is not "allow nothing" to dsh — `tools.restrict()`
    // rejects an empty filter outright. A role with no tools gets no filter.
    const allow = [...work.constraints.tools];
    let child: SubagentRun | undefined;
    try {
      child = await this.deps.subagents.start(transport, {
        prompt: [
          {
            type: "text",
            text: work.inputs.prompt ?? `Complete ${work.taskClass}`,
          },
        ],
        parent: parent.parent,
        signal,
        agentOptions: { model: selection.model, ...agentOptions },
        maxDepth: this.deps.maxDepth,
        ...(allow.length === 0 ? {} : { toolFilter: { allow } }),
        persona: this.deps.persona ?? work.role,
      });
      const terminal = await child.result;
      // A vendor refusal arrives as a turn/end ERROR EVENT, not as a rejected
      // promise: dsh ends the turn cleanly and records why. Returning that as
      // an ordinary empty result is how a 429 came back looking like a model
      // that had nothing to say — indistinguishable from a genuinely silent
      // step, and unroutable, because the runner re-routes a spent quota and
      // has no reason to re-route silence. Raising it here is what lets
      // `DshProvider.run` classify it.
      const failure = terminal.providerFailure;
      if (failure !== undefined) {
        const error = new Error(
          `dsh subagent failed: ${failure.code}` +
            `${failure.status === undefined ? "" : ` ${String(failure.status)}`}` +
            `${failure.message === undefined ? "" : ` — ${failure.message}`}`,
        );
        Object.assign(error, { code: failure.code, status: failure.status });
        throw error;
      }
      return {
        text: terminal.output
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join(""),
        ...(terminal.structured === undefined
          ? {}
          : { structured: terminal.structured }),
        events: terminal.events,
      };
    } finally {
      await child?.dispose();
    }
  }

  async close(runId: string): Promise<void> {
    const pending = this.#handles.get(runId);
    if (pending === undefined) return;
    this.#handles.delete(runId);
    const handle = await pending;
    await this.deps.subagents.drainDescendants(handle.parent);
    await handle.dispose();
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#handles.keys()].map((id) => this.close(id)));
  }

  #parent(runId: string, signal: AbortSignal): Promise<RunHandle> {
    const existing = this.#handles.get(runId);
    if (existing !== undefined) return existing;
    const workspace = join(this.deps.workspacesDir, runId, "host");
    const pending = this.deps.parents.ensure({ runId, workspace, signal });
    this.#handles.set(runId, pending);
    void pending.catch(() => {
      if (this.#handles.get(runId) === pending) this.#handles.delete(runId);
    });
    return pending;
  }
}

type HostContext = Pick<
  Context,
  "agents" | "sessions" | "sessionPersistence" | "subagents"
>;

function parentSessionId(runId: string) {
  return SessionId(
    `helium-run-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`,
  );
}

/** Durable parent owner. The parent never schedules; the runner does. */
export class CordisRunParentFactory implements RunParentFactory {
  constructor(private readonly ctx: HostContext) {}

  async ensure(input: {
    runId: string;
    workspace: string;
    signal?: AbortSignal;
  }): Promise<RunHandle> {
    mkdirSync(input.workspace, { recursive: true });
    const id = parentSessionId(input.runId);
    if (this.ctx.agents.get(id) !== undefined) {
      throw new Error(`run parent already has a live owner: ${String(id)}`);
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

/**
 * Exact adapter over the pinned subagent lifecycle service.
 *
 * The one thing it adds is handing the child's session events out with the
 * terminal, because that log is the only honest source of per-step token
 * accounting available to the audit projection.
 */
export class CordisSubagentRuntime implements DshSubagentRuntime {
  constructor(private readonly runtime: SubagentRuntime) {}

  async start(
    providerName: string,
    request: Parameters<DshSubagentRuntime["start"]>[1],
  ): Promise<SubagentRun> {
    const run = await this.runtime.start(providerName, request as never);
    const result = run.result.then((terminal) => {
      const events = (run.localAgent?.session.events ?? []) as unknown as LogEvent[];
      const header = [...events]
        .reverse()
        .find((event) => event.type === "request/header") as
        | { data?: { header?: { config?: { reasoningEffort?: unknown } } } }
        | undefined;
      const ended = [...events].reverse().find((event) => event.type === "turn/end") as
        | {
            data?: {
              reason?: {
                error?: {
                code?: unknown;
                status?: unknown;
                providerRetryAfterMs?: unknown;
                message?: unknown;
              };
              };
            };
          }
        | undefined;
      const effort = header?.data?.header?.config?.reasoningEffort;
      const failure = ended?.data?.reason?.error;
      return {
        output: terminal.output as SubagentTerminal["output"],
        ...(terminal.structured === undefined ? {} : { structured: terminal.structured }),
        ...(terminal.diagnostic === undefined ? {} : { diagnostic: terminal.diagnostic }),
        stopReason: terminal.stopReason,
        events,
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
                // The code alone says a request was rejected; only the message
                // says WHICH field the vendor objected to, and a rejection you
                // cannot act on is barely better than silence.
                ...(typeof failure.message === "string" ? { message: failure.message } : {}),
              },
            }),
      };
    });
    return { id: run.id, result, dispose: () => run.dispose() };
  }

  async drainDescendants(parent: unknown): Promise<void> {
    await this.runtime.drainContinuableDescendants([parent as Agent]);
  }

  interrupt(childId: unknown, parent: unknown): void {
    this.runtime.interrupt(childId as never, {
      kind: "ancestor",
      agent: parent as Agent,
    });
  }
}
