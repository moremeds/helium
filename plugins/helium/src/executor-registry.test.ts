import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionTargetId,
  LeaseStore,
  conformanceAtFloor,
  type AgentResult,
  type ConformanceRecord,
  type ExecutionContext,
  type Executor,
  type IsolationClass,
  type WorkOrder,
} from "@helium/core";
import { describe, expect, it, vi } from "vitest";
import { ExecutorRegistry, asBoundarySubject } from "./executor-registry.js";

const now = new Date("2026-08-29T00:00:00.000Z");

const work = (overrides: Partial<WorkOrder> = {}): WorkOrder => ({
  id: "work-1",
  role: "verifier",
  taskClass: "test",
  requires: [],
  constraints: {
    tools: ["artifact_read"],
    mutations: "forbidden",
    minIsolationClass: "in-process",
  },
  inputs: { artifacts: [], prompt: "probe" },
  acceptance: { outputSchema: "any-v1" },
  ...overrides,
});

const result = (workId: string, isolationClass: IsolationClass): AgentResult => ({
  workId,
  outcome: "completed",
  structured: "ok",
  artifacts: [],
  usage: { ms: 1 },
  executionSnapshot: {
    targetId: "t",
    providerId: "stub",
    model: "stub-1",
    providerVersion: "0.0.0",
    isolationClass,
    recordedAt: now.toISOString(),
  },
  runtimeMetadata: { opaque: { nested: [1, 2, 3] } },
});

const stub = (
  id: string,
  isolationClass: IsolationClass = "in-process",
  run?: Executor["run"],
): Executor => ({
  targetId: ExecutionTargetId(id),
  isolationClass,
  run:
    run ??
    (async (w: WorkOrder) => result(w.id, isolationClass)),
  drain: async () => {},
});

const proven = (id: string, provenClass: IsolationClass): ConformanceRecord => ({
  targetId: ExecutionTargetId(id),
  provenClass,
  basis: "execution-boundary-conformance",
  recordedAt: now.toISOString(),
});

const leaseFor = (store: LeaseStore, targetId: string, workId = "work-1") =>
  store.issue({
    targetId: ExecutionTargetId(targetId),
    workId,
    reservedCost: 0,
    expiresAt: "2026-08-29T01:00:00.000Z",
  });

const dirs = () => ({
  workspacesDir: mkdtempSync(join(tmpdir(), "helium-exec-")),
  env: { PATH: process.env.PATH ?? "" },
});

describe("registration", () => {
  it("registers an executor against a conformance record and disposes it", () => {
    const registry = new ExecutorRegistry();
    const dispose = registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("a")));
    expect(registry.list()).toHaveLength(1);
    dispose();
    expect(registry.get(ExecutionTargetId("a"))).toBeUndefined();
  });

  it("refuses a duplicate executor for the same target", () => {
    const registry = new ExecutorRegistry();
    registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("a")));
    expect(() =>
      registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("a"))),
    ).toThrow(/duplicate executor/);
  });

  it("refuses a conformance record issued for a different target", () => {
    const registry = new ExecutorRegistry();
    expect(() =>
      registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("b"))),
    ).toThrow(/conformance record is for b/);
  });

  // The suite is the admission gate: an executor that declares `sandboxed` but
  // demonstrates only `process` fails registration rather than downgrading
  // silently to what it can prove.
  it("refuses an executor whose declared class exceeds its proven one", () => {
    const registry = new ExecutorRegistry();
    expect(() =>
      registry.register(stub("a", "sandboxed"), proven("a", "process")),
    ).toThrow(/declares "sandboxed" but its conformance record proves only "process"/);
  });

  it("admits an executor that declares less than it proved", () => {
    const registry = new ExecutorRegistry();
    expect(() =>
      registry.register(stub("a", "process"), proven("a", "sandboxed")),
    ).not.toThrow();
  });
});

describe("dispatch", () => {
  it("rejects a lease for a target that is not registered", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    await expect(
      registry.run({
        work: work(),
        lease: leaseFor(leases, "ghost"),
        leases,
        ...dirs(),
        now,
      }),
    ).rejects.toThrow(/missing target: ghost/);
  });

  it("rejects work requiring a stronger class BEFORE run() is called", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    const run = vi.fn();
    registry.register(
      stub("a", "in-process", run as unknown as Executor["run"]),
      conformanceAtFloor(ExecutionTargetId("a")),
    );
    await expect(
      registry.run({
        work: work({
          constraints: { ...work().constraints, minIsolationClass: "process" },
        }),
        lease: leaseFor(leases, "a"),
        leases,
        ...dirs(),
        now,
      }),
    ).rejects.toThrow(/requires "process" but a demonstrates "in-process"/);
    expect(run).not.toHaveBeenCalled();
    // The lease is not burned by a dispatch that never ran.
    expect(leases.outstanding()).toHaveLength(1);
  });

  it("refuses a lease bound to different work", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("a")));
    await expect(
      registry.run({
        work: work({ id: "work-2" }),
        lease: leaseFor(leases, "a", "work-1"),
        leases,
        ...dirs(),
        now,
      }),
    ).rejects.toThrow(/work mismatch/);
  });

  it("normalizes the result and carries runtime metadata through untouched", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    registry.register(stub("a"), conformanceAtFloor(ExecutionTargetId("a")));
    const out = await registry.run({
      work: work(),
      lease: leaseFor(leases, "a"),
      leases,
      ...dirs(),
      now,
    });
    expect(out.outcome).toBe("completed");
    expect(out.runtimeMetadata).toEqual({ opaque: { nested: [1, 2, 3] } });
  });

  it("rejects an executor result core's schema does not accept", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    registry.register(
      stub("a", "in-process", (async (w: WorkOrder) => ({
        ...result(w.id, "in-process"),
        model: "leaked-model-name",
      })) as unknown as Executor["run"]),
      conformanceAtFloor(ExecutionTargetId("a")),
    );
    await expect(
      registry.run({
        work: work(),
        lease: leaseFor(leases, "a"),
        leases,
        ...dirs(),
        now,
      }),
    ).rejects.toThrow();
  });

  it("gives each run its own empty workspace", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    const seen: string[] = [];
    registry.register(
      stub("a", "in-process", (async (
        w: WorkOrder,
        _s: AbortSignal,
        c: ExecutionContext,
      ) => {
        seen.push(c.workspace);
        return result(w.id, "in-process");
      }) as unknown as Executor["run"]),
      conformanceAtFloor(ExecutionTargetId("a")),
    );
    const shared = dirs();
    await registry.run({ work: work(), lease: leaseFor(leases, "a"), leases, ...shared, now });
    await registry.run({
      work: work({ id: "work-2" }),
      lease: leaseFor(leases, "a", "work-2"),
      leases,
      ...shared,
      now,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((workspace) => !existsSync(workspace))).toBe(true);
  });

  it("removes the owned workspace after a failed executor settles", async () => {
    const registry = new ExecutorRegistry();
    const leases = new LeaseStore();
    let seen = "";
    registry.register(
      stub("a", "in-process", (async (
        _w: WorkOrder,
        _s: AbortSignal,
        context: ExecutionContext,
      ) => {
        seen = context.workspace;
        writeFileSync(join(seen, "partial.txt"), "partial");
        throw new Error("provider failed");
      }) as Executor["run"]),
      conformanceAtFloor(ExecutionTargetId("a")),
    );
    await expect(
      registry.run({
        work: work(),
        lease: leaseFor(leases, "a"),
        leases,
        ...dirs(),
        now,
      }),
    ).rejects.toThrow(/provider failed/);
    expect(existsSync(seen)).toBe(false);
  });

  it("drains every registered executor", async () => {
    const registry = new ExecutorRegistry();
    const drained: string[] = [];
    for (const id of ["a", "b"]) {
      registry.register(
        { ...stub(id), drain: async () => void drained.push(id) },
        conformanceAtFloor(ExecutionTargetId(id)),
      );
    }
    await registry.drain();
    expect(drained.sort()).toEqual(["a", "b"]);
  });
});

describe("boundary subject adapter", () => {
  it("presents an executor to the shared suite under its declared class", async () => {
    const captured: ExecutionContext[] = [];
    const subject = asBoundarySubject(
      stub("a", "process", (async (
        w: WorkOrder,
        _s: AbortSignal,
        c: ExecutionContext,
      ) => {
        captured.push(c);
        return { ...result(w.id, "process"), structured: '{"proof":true}' };
      }) as unknown as Executor["run"]),
      "fake-subject",
    );
    expect(subject.declaredIsolationClass).toBe("process");
    const out = await subject.invoke({
      prompt: "probe",
      allowedTools: ["mcp__helium__thesis_read"],
      mcpConfigPath: "/tmp/mcp.json",
      expectedWorkspace: "/tmp/ws",
      env: { PATH: "/bin" },
    });
    expect(out.text).toBe('{"proof":true}');
    expect(captured[0]).toEqual({
      workspace: "/tmp/ws",
      env: { PATH: "/bin" },
      allowedTools: ["mcp__helium__thesis_read"],
      mcpConfigPath: "/tmp/mcp.json",
    });
  });
});
