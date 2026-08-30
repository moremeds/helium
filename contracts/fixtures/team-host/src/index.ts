import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type { AgentResult, Executor, WorkOrder } from "@helium/core";
import {
  ExecutionTargetId,
  LeaseStore,
  WorkOrderSchema,
  conformanceAtFloor,
} from "@helium/core";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from "@deepseek-ai/dsh-subagent";
import {
  CordisTeamParentFactory,
  CordisTeamSubagentRuntime,
  DshTeamHost,
  type TeamParentFactory,
  type TeamSubagentTerminal,
} from "dsh-plugin-helium/dsh-team-host";
import { ExecutorRegistry } from "dsh-plugin-helium/executor-registry";

export const name = "helium-team-host-fixture";
export const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
  "subagents",
];

export interface Config {
  outFile: string;
  workspacesDir: string;
}

function work(
  id: string,
  prompt: string,
  isolation: "in-process" | "process" = "in-process",
) {
  return WorkOrderSchema.parse({
    id,
    role: "fixture-worker",
    taskClass: "fixture",
    requires: [],
    constraints: {
      tools: [],
      mutations: "forbidden",
      minIsolationClass: isolation,
    },
    inputs: { artifacts: [], prompt },
    acceptance: { outputSchema: "fixture-v1" },
  });
}

function snapshot(targetId: string, isolation: "in-process" | "process") {
  return {
    targetId,
    providerId: "fixture",
    model: "fixture",
    providerVersion: "1",
    isolationClass: isolation,
    recordedAt: new Date().toISOString(),
  } as const;
}

function completed(input: WorkOrder, targetId: string, isolation: "in-process" | "process"): AgentResult {
  return {
    workId: input.id,
    outcome: "completed",
    structured: { ok: true },
    artifacts: [],
    usage: { ms: 1 },
    executionSnapshot: snapshot(targetId, isolation),
    runtimeMetadata: {},
  };
}

function localFixtureProvider(ctx: Context, active: Set<string>): SubagentProvider {
  return {
    name: "fixture-local",
    capabilities: {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    inheritsParentContext: true,
    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      const id = SessionId(`fixture-child-${randomUUID()}`);
      const handle = await ctx.agents.create({
        sessionId: id,
        meta: {
          cwd: request.parent.session.header.cwd,
          parentSession: request.parent.session.id,
          origin: "subagent",
          delegationDepth: 1,
        },
        agentOptions: request.agentOptions,
        signal: request.signal,
      });
      active.add(String(id));
      const asksCancel = request.prompt.some(
        (block) => block.type === "text" && block.text.includes("cancel"),
      );
      let settled = false;
      let settle!: (result: SubagentResult) => void;
      const result = new Promise<SubagentResult>((resolve) => {
        settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
      });
      const timer = setTimeout(
        () =>
          settle({
            output: [{ type: "text", text: "fixture completed" }],
            structured: { ok: true },
            stopReason: "completed",
          }),
        asksCancel ? 60_000 : 20,
      );
      const abort = () =>
        settle({ output: [], diagnostic: "fixture cancelled", stopReason: "aborted" });
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      let disposed = false;
      return {
        id,
        localAgent: handle.agent,
        result,
        async dispose() {
          if (disposed) return;
          disposed = true;
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          settle({ output: [], diagnostic: "fixture disposed", stopReason: "aborted" });
          await result;
          await ctx.sessions.flush(handle.agent.session);
          await handle.dispose();
          active.delete(String(id));
        },
      };
    },
  };
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const activeChildren = new Set<string>();
    const removeProvider = ctx.subagents.registerProvider(
      localFixtureProvider(ctx, activeChildren),
    );
    let cancelled = false;
    void (async () => {
      await ctx.get("loader")?.await();
      const registry = new ExecutorRegistry();
      const leases = new LeaseStore();
      const dshTarget = ExecutionTargetId("fixture-dsh-target");
      const processTarget = ExecutionTargetId("fixture-process-target");
      const inProcess: Executor & {
        dsh: { providerName: string; agentOptions: Record<string, unknown>; persona: string };
        fromSubagentResult(work: WorkOrder, terminal: TeamSubagentTerminal, elapsedMs: number): AgentResult;
        failureResult(work: WorkOrder, failureClass: "tool-boundary-violation" | "provider-error" | "cancelled", detail: string): AgentResult;
      } = {
        targetId: dshTarget,
        isolationClass: "in-process",
        dsh: {
          providerName: "fixture-local",
          agentOptions: { provider: "fixture", model: "fixture", maxTokens: 64 },
          persona: "Fixture worker",
        },
        fromSubagentResult(input, terminal, elapsedMs) {
          if (terminal.stopReason === "completed") {
            return { ...completed(input, String(dshTarget), "in-process"), usage: { ms: elapsedMs } };
          }
          return this.failureResult(
            input,
            terminal.stopReason === "aborted" ? "cancelled" : "provider-error",
            terminal.diagnostic ?? terminal.stopReason,
          );
        },
        failureResult(input, failureClass, detail) {
          return {
            ...completed(input, String(dshTarget), "in-process"),
            outcome: "failed",
            structured: undefined,
            failure: { class: failureClass, safeDetail: detail },
          };
        },
        async run() {
          throw new Error("in-process work bypassed DSH seam");
        },
        async drain() {},
      };
      registry.register(inProcess, conformanceAtFloor(dshTarget));

      let processCalls = 0;
      registry.register(
        {
          targetId: processTarget,
          isolationClass: "process",
          async run(input) {
            processCalls += 1;
            return completed(input, String(processTarget), "process");
          },
          async drain() {},
        },
        {
          targetId: processTarget,
          provenClass: "process",
          basis: "execution-boundary-conformance",
          recordedAt: new Date(0).toISOString(),
        },
      );

      const parentStates: boolean[] = [];
      const realParents = new CordisTeamParentFactory(ctx);
      const parents: TeamParentFactory = {
        async ensure(input) {
          const handle = await realParents.ensure(input);
          parentStates.push(handle.resumed);
          return handle;
        },
      };
      const host = new DshTeamHost({
        registry,
        leases,
        subagents: new CordisTeamSubagentRuntime(ctx.subagents),
        parents,
        workspacesDir: config.workspacesDir,
        env: { PATH: process.env.PATH ?? "" },
        outputSchemaFor: () => ({
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        }),
        maxDepth: 1,
      });

      const completeWork = work("complete", "complete");
      const cancelWork = work("cancel", "cancel");
      const completeLease = leases.issue({
        targetId: dshTarget,
        workId: completeWork.id,
        reservedCost: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const cancelLease = leases.issue({
        targetId: dshTarget,
        workId: cancelWork.id,
        reservedCost: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const cancelSignal = new AbortController();
      const completePromise = host.run(
        "fixture-team",
        completeWork,
        completeLease,
        new AbortController().signal,
      );
      const cancelPromise = host.run(
        "fixture-team",
        cancelWork,
        cancelLease,
        cancelSignal.signal,
      );
      setTimeout(() => cancelSignal.abort(), 5);
      const [completeResult, cancelResult] = await Promise.all([
        completePromise,
        cancelPromise,
      ]);

      const processWork = work("process", "process", "process");
      const processResult = await host.run(
        "fixture-team",
        processWork,
        leases.issue({
          targetId: processTarget,
          workId: processWork.id,
          reservedCost: 0,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        new AbortController().signal,
      );
      await host.closeTeam("fixture-team");

      const resumedWork = work("resumed", "complete again");
      const resumedResult = await host.run(
        "fixture-team",
        resumedWork,
        leases.issue({
          targetId: dshTarget,
          workId: resumedWork.id,
          reservedCost: 0,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        new AbortController().signal,
      );
      await host.closeTeam("fixture-team");
      if (cancelled) return;
      writeFileSync(
        config.outFile,
        JSON.stringify({
          completeOutcome: completeResult.outcome,
          cancelledClass: cancelResult.failure?.class,
          processOutcome: processResult.outcome,
          processCalls,
          resumedOutcome: resumedResult.outcome,
          parentStates,
          activeChildren: activeChildren.size,
          liveFixtureChildren: ctx.agents
            .list()
            .filter((agent) => String(agent.id).startsWith("fixture-child-"))
            .length,
        }),
      );
    })().catch((error: unknown) => {
      writeFileSync(
        `${config.outFile}.error`,
        String((error as Error)?.stack ?? error),
      );
    });
    return async () => {
      cancelled = true;
      removeProvider();
    };
  }, "helium-team-host-fixture.run()");
}
