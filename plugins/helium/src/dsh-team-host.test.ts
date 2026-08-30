import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionTargetId,
  LeaseStore,
  WorkOrderSchema,
  conformanceAtFloor,
  type AgentResult,
  type ConformanceRecord,
  type ExecutionContext,
  type Executor,
  type WorkOrder,
} from "@helium/core";
import {
  DshTeamHost,
  type TeamParentFactory,
  type TeamSubagentRuntime,
} from "./dsh-team-host.js";
import { ExecutorRegistry } from "./executor-registry.js";

const work = (minimum: "in-process" | "process" = "in-process") =>
  WorkOrderSchema.parse({
    id: "work-1",
    role: "evidence-verifier",
    taskClass: "research.verification",
    requires: [],
    constraints: {
      tools: ["artifact_read"],
      mutations: "forbidden",
      minIsolationClass: minimum,
    },
    inputs: { artifacts: ["artifact-1"], prompt: "verify this" },
    acceptance: { outputSchema: "claim-set-v1" },
  });

const result = (input: WorkOrder, isolation: "in-process" | "process"): AgentResult => ({
  workId: input.id,
  outcome: "completed",
  structured: { ok: true },
  artifacts: [],
  usage: { ms: 1 },
  executionSnapshot: {
    targetId: isolation === "in-process" ? "target-dsh" : "target-process",
    providerId: "fixture",
    model: "fixture",
    providerVersion: "1",
    isolationClass: isolation,
    recordedAt: "2026-08-30T00:00:00.000Z",
  },
  runtimeMetadata: {},
});

const processProof = (targetId: ReturnType<typeof ExecutionTargetId>): ConformanceRecord => ({
  targetId,
  provenClass: "process",
  basis: "execution-boundary-conformance",
  recordedAt: "2026-08-30T00:00:00.000Z",
});

function setup() {
  const registry = new ExecutorRegistry({ onResult: () => {} });
  const observed: AgentResult[] = [];
  const leases = new LeaseStore();
  const disposeRun = vi.fn(async () => {});
  const start = vi.fn<TeamSubagentRuntime["start"]>().mockResolvedValue({
    id: "child-1",
    result: Promise.resolve({
      output: [{ type: "text", text: "verified" }],
      structured: { ok: true },
      stopReason: "completed",
    }),
    dispose: disposeRun,
  });
  const drain = vi.fn(async () => {});
  const subagents: TeamSubagentRuntime = {
    start,
    drainDescendants: drain,
    followup: vi.fn(async () => "message-1"),
    interrupt: vi.fn(),
    listChildren: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
  };
  const parentDispose = vi.fn(async () => {});
  const ensure = vi.fn<TeamParentFactory["ensure"]>().mockResolvedValue({
    parent: { id: "parent-1" },
    resumed: false,
    dispose: parentDispose,
  });
  const parents: TeamParentFactory = { ensure };

  const inProcess: Executor & {
    dsh: {
      providerName: string;
      agentOptions: Record<string, unknown>;
      persona: string;
    };
    fromSubagentResult: (
      work: WorkOrder,
      terminal: unknown,
      elapsedMs: number,
    ) => AgentResult;
    failureResult: (
      work: WorkOrder,
      failureClass: "tool-boundary-violation" | "provider-error" | "cancelled",
      detail: string,
    ) => AgentResult;
  } = {
    targetId: ExecutionTargetId("target-dsh"),
    isolationClass: "in-process",
    dsh: {
      providerName: "registered-in-process-provider",
      agentOptions: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
      persona: "Verify evidence and report only the schema.",
    },
    fromSubagentResult: (input) => result(input, "in-process"),
    failureResult: (input, failureClass, detail) => ({
      ...result(input, "in-process"),
      outcome: "failed",
      structured: undefined,
      failure: { class: failureClass, safeDetail: detail },
    }),
    run: async () => {
      throw new Error("host must use the DSH lifecycle seam");
    },
    drain: async () => {},
  };
  registry.register(inProcess, conformanceAtFloor(inProcess.targetId));

  const processRun = vi.fn(
    async (input: WorkOrder, _signal: AbortSignal, _context: ExecutionContext) =>
      result(input, "process"),
  );
  const outOfProcess: Executor = {
    targetId: ExecutionTargetId("target-process"),
    isolationClass: "process",
    run: processRun,
    drain: async () => {},
  };
  registry.register(outOfProcess, processProof(outOfProcess.targetId));

  const host = new DshTeamHost({
    registry,
    leases,
    subagents,
    parents,
    workspacesDir: mkdtempSync(join(tmpdir(), "helium-team-host-")),
    env: { PATH: "/usr/bin" },
    outputSchemaFor: () => ({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    }),
    maxDepth: 1,
    observeResult: (value) => void observed.push(value),
  });
  return {
    registry,
    leases,
    host,
    start,
    disposeRun,
    drain,
    ensure,
    parentDispose,
    processRun,
    observed,
  };
}

function lease(leases: LeaseStore, targetId: string, workId = "work-1") {
  return leases.issue({
    targetId: ExecutionTargetId(targetId),
    workId,
    reservedCost: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

describe("DshTeamHost", () => {
  it("creates one durable parent, resolves the leased executor, and always disposes the child run", async () => {
    const fx = setup();
    const out = await fx.host.run(
      "team-1",
      work(),
      lease(fx.leases, "target-dsh"),
      new AbortController().signal,
    );
    expect(out.outcome).toBe("completed");
    expect(fx.observed).toEqual([out]);
    expect(fx.ensure).toHaveBeenCalledTimes(1);
    expect(fx.start).toHaveBeenCalledWith(
      "registered-in-process-provider",
      expect.objectContaining({
        parent: { id: "parent-1" },
        maxDepth: 1,
        toolFilter: { allow: ["artifact_read"] },
        outputSchema: expect.any(Object),
        persona: "Verify evidence and report only the schema.",
      }),
    );
    expect(fx.disposeRun).toHaveBeenCalledOnce();

    await fx.host.run(
      "team-1",
      { ...work(), id: "work-2" },
      lease(fx.leases, "target-dsh", "work-2"),
      new AbortController().signal,
    );
    expect(fx.ensure).toHaveBeenCalledTimes(1);
  });

  it("dispatches an out-of-process target through the registry without starting a DSH child", async () => {
    const fx = setup();
    const out = await fx.host.run(
      "team-1",
      work("process"),
      lease(fx.leases, "target-process"),
      new AbortController().signal,
    );
    expect(out.outcome).toBe("completed");
    expect(fx.processRun).toHaveBeenCalledOnce();
    expect(fx.start).not.toHaveBeenCalled();
    expect(fx.ensure).not.toHaveBeenCalled();
  });

  it("fails closed before DSH start when work requires stronger isolation", async () => {
    const fx = setup();
    const out = await fx.host.run(
      "team-1",
      work("process"),
      lease(fx.leases, "target-dsh"),
      new AbortController().signal,
    );
    expect(out).toMatchObject({
      outcome: "failed",
      failure: { class: "tool-boundary-violation" },
    });
    expect(fx.observed).toEqual([out]);
    expect(fx.start).not.toHaveBeenCalled();
    expect(fx.ensure).not.toHaveBeenCalled();
  });

  it("drains descendants before disposing the team parent", async () => {
    const fx = setup();
    await fx.host.run(
      "team-1",
      work(),
      lease(fx.leases, "target-dsh"),
      new AbortController().signal,
    );
    await fx.host.closeTeam("team-1");
    expect(fx.drain).toHaveBeenCalledWith({ id: "parent-1" });
    expect(fx.parentDispose).toHaveBeenCalledOnce();
  });

  it("classifies an aborted child as cancelled and still disposes it", async () => {
    const fx = setup();
    const controller = new AbortController();
    fx.start.mockResolvedValueOnce({
      id: "child-aborted",
      result: Promise.reject(new Error("aborted")),
      dispose: fx.disposeRun,
    });
    controller.abort();
    const out = await fx.host.run(
      "team-1",
      work(),
      lease(fx.leases, "target-dsh"),
      controller.signal,
    );
    expect(out).toMatchObject({
      outcome: "failed",
      failure: { class: "cancelled" },
    });
    expect(fx.disposeRun).toHaveBeenCalledOnce();
  });
});
