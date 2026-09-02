import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/jsonl.js";
import type { AgentResult, WorkOrder } from "../src/work.js";
import type { RoleContract, TeamEvent } from "../src/team/events.js";
import {
  TeamRecoveryCoordinator,
  type ExecutionAttemptInput,
} from "../src/team/recovery.js";
import { openTeamStore, type TeamStore } from "../src/team/store.js";
import { TaskGraph } from "../src/team/tasks.js";

const noSync = () => {};
const at = (minute: number) => `2026-08-30T11:${String(minute).padStart(2, "0")}:00.000Z`;
const role = (roleId: string): RoleContract => ({
  roleId,
  requires: [roleId],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 0.5,
});
const work: WorkOrder = {
  id: "work-root",
  role: "lead",
  taskClass: "research",
  requires: ["research"],
  constraints: {
    tools: ["artifact_read"],
    mutations: "forbidden",
    minIsolationClass: "process",
    maxCost: 2,
  },
  inputs: { artifacts: ["artifact://input/source"], prompt: "analyze" },
  acceptance: { outputSchema: "claims/v1" },
};

interface Fixture {
  store: TeamStore;
  graph: TaskGraph;
  recovery: TeamRecoveryCoordinator;
}

function setup(): Fixture {
  const store = openTeamStore(mkdtempSync(join(tmpdir(), "helium-recovery-")), "case-recovery", {
    sync: noSync,
  });
  const events: TeamEvent[] = [
    { version: 1, eventId: "open", at: at(0), caseId: "case-recovery", type: "case/opened", payload: { subject: "macro" } },
    { version: 1, eventId: "start", at: at(1), caseId: "case-recovery", teamRunId: "team-recovery", type: "team/started", payload: {} },
    { version: 1, eventId: "lead", at: at(2), caseId: "case-recovery", teamRunId: "team-recovery", type: "agent/rostered", payload: { agentId: "lead", role: role("lead") } },
    { version: 1, eventId: "child", at: at(3), caseId: "case-recovery", teamRunId: "team-recovery", type: "agent/rostered", payload: { agentId: "child", parentAgentId: "lead", role: role("child") } },
  ];
  for (const event of events) store.append(event);
  let n = 0;
  const options = {
    now: () => at(4),
    eventId: () => `recovery-${++n}`,
  };
  const graph = new TaskGraph(store, "team-recovery", options);
  graph.add({ id: "root", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "claims/v1" } }, 0);
  graph.add({ id: "child", ownerAgentId: "child", dependsOn: ["root"], acceptance: { outputSchema: "review/v1" } }, 1);
  return {
    store,
    graph,
    recovery: new TeamRecoveryCoordinator(store, "team-recovery", options),
  };
}

function intent(overrides: Partial<ExecutionAttemptInput> = {}): ExecutionAttemptInput {
  return {
    attemptId: "attempt-1",
    taskId: "root",
    leaseId: "lease-1",
    targetId: "target-a",
    catalogSnapshotId: "catalog-1",
    workOrder: work,
    artifactRefs: ["artifact://input/source"],
    remainingBudget: { tokens: 10_000, cost: 2, ms: 60_000 },
    exactTarget: false,
    ...overrides,
  };
}

function result(failureClass?: "quota-exhausted" | "provider-error"): AgentResult {
  return {
    workId: work.id,
    outcome: failureClass === undefined ? "completed" : "failed",
    ...(failureClass === undefined ? {} : {
      failure: {
        class: failureClass,
        ...(failureClass === "quota-exhausted" ? { retryAfter: "opaque-reset" } : {}),
      },
    }),
    structured: { ok: failureClass === undefined },
    artifacts: [],
    usage: { ms: 10 },
    executionSnapshot: {
      targetId: "target-a",
      providerId: "opaque-provider",
      model: "opaque-model",
      providerVersion: "1",
      isolationClass: "process",
      recordedAt: at(5),
    },
    runtimeMetadata: {},
  };
}

function begin(fixture: Fixture, input: ExecutionAttemptInput = intent()): void {
  fixture.graph.lease(input.taskId, 1, {
    leaseId: input.leaseId,
    ownerAgentId: "lead",
    expiresAt: at(20),
  });
  fixture.recovery.recordExecutionIntent(input);
}

describe("TeamRecoveryCoordinator", () => {
  it("reconciles an in-process attempt as uncertain and never blindly retries it", () => {
    const fixture = setup();
    begin(fixture);
    const events = fixture.recovery.reconcile(new Date(at(10)));
    expect(events).toContainEqual(expect.objectContaining({
      type: "task/interrupted",
      payload: expect.objectContaining({ reason: "startup-recovery", outcome: "uncertain" }),
    }));
    expect(fixture.recovery.attempt("attempt-1").state).toBe("interrupted");
    expect(fixture.graph.get("root")).toMatchObject({ state: "needs-input" });
    expect(fixture.graph.get("root").lease).toBeUndefined();
    expect(fixture.recovery.reconcile(new Date(at(11)))).toEqual([]);
  });

  it("reclaims an expired assignment that never reached execution intent", () => {
    const fixture = setup();
    fixture.graph.lease("root", 1, { leaseId: "lease-1", ownerAgentId: "lead", expiresAt: at(8) });
    expect(fixture.recovery.reconcile(new Date(at(9))).map((event) => event.type))
      .toEqual(["task/lease-expired"]);
    expect(fixture.graph.get("root")).toMatchObject({ state: "ready" });
  });

  it("terminalizes quota exhaustion and creates one fallback with immutable inputs", () => {
    const fixture = setup();
    begin(fixture);
    fixture.recovery.recordExecutionResult("attempt-1", result("quota-exhausted"));
    const revisionAfterQuota = fixture.graph.get("root").revision;
    const fallback = fixture.recovery.routeQuota("attempt-1", {
      attemptId: "attempt-2",
      targetId: "target-b",
      catalogSnapshotId: "catalog-2",
    });
    expect(fallback?.state).toBe("created");
    expect(canonicalJson(fallback?.workOrder)).toBe(canonicalJson(work));
    expect(fallback?.artifactRefs).toEqual(intent().artifactRefs);
    expect(fallback?.remainingBudget).toEqual(intent().remainingBudget);
    expect(fixture.graph.get("root").revision).toBe(revisionAfterQuota + 1);
    expect(fixture.recovery.routeQuota("attempt-1", {
      attemptId: "attempt-3",
      targetId: "target-c",
      catalogSnapshotId: "catalog-3",
    })?.attemptId).toBe("attempt-2");
  });

  it("refuses fallback for an exact-target override and waits durably", () => {
    const fixture = setup();
    begin(fixture, intent({ exactTarget: true }));
    fixture.recovery.recordExecutionResult("attempt-1", result("quota-exhausted"));
    expect(fixture.recovery.routeQuota("attempt-1", {
      attemptId: "attempt-2",
      targetId: "target-b",
      catalogSnapshotId: "catalog-2",
    })).toBeUndefined();
    expect(fixture.recovery.waiting("root")).toMatchObject({ exhaustedAttemptId: "attempt-1" });
    expect(() => fixture.recovery.resumeCapacity("root", "availability-1", {
      attemptId: "attempt-2",
      targetId: "target-b",
      catalogSnapshotId: "catalog-2",
    })).toThrow(/exact-target resume must keep target target-a/);
  });

  it("waits without a busy loop and resumes exactly one attempt per wait", () => {
    const fixture = setup();
    begin(fixture);
    fixture.recovery.recordExecutionResult("attempt-1", result("quota-exhausted"));
    fixture.recovery.routeQuota("attempt-1");
    const count = fixture.store.events().length;
    fixture.recovery.routeQuota("attempt-1");
    expect(fixture.store.events()).toHaveLength(count);

    const resumed = fixture.recovery.resumeCapacity("root", "availability-1", {
      attemptId: "attempt-2",
      targetId: "target-b",
      catalogSnapshotId: "catalog-2",
    });
    expect(resumed.attemptId).toBe("attempt-2");
    const afterResume = fixture.store.events().length;
    expect(fixture.recovery.resumeCapacity("root", "availability-1", {
      attemptId: "attempt-3",
      targetId: "target-c",
      catalogSnapshotId: "catalog-3",
    }).attemptId).toBe("attempt-2");
    expect(fixture.store.events()).toHaveLength(afterResume);
  });

  it("cancels dependent tasks and descendant agents child-first, then drains", async () => {
    const fixture = setup();
    const calls: string[] = [];
    await fixture.recovery.cancel("operator", {
      interruptAgent: async (agentId) => { calls.push(`interrupt:${agentId}`); },
      drain: async () => { calls.push("drain"); },
    });
    expect(calls).toEqual(["interrupt:child", "interrupt:lead", "drain"]);
    const events = fixture.store.events();
    const childTask = events.findIndex((event) => event.type === "task/cancelled" && event.payload.taskId === "child");
    const rootTask = events.findIndex((event) => event.type === "task/cancelled" && event.payload.taskId === "root");
    expect(childTask).toBeLessThan(rootTask);
    expect(fixture.store.load().teams["team-recovery"].state).toBe("cancelled");
  });

  it("leaves no running attempt when a team is cancelled", async () => {
    const fixture = setup();
    begin(fixture);
    await fixture.recovery.cancel("operator", {
      interruptAgent: async () => {},
      drain: async () => {},
    });
    expect(fixture.recovery.attempt("attempt-1")).toMatchObject({
      state: "interrupted",
      interruptedOutcome: "uncertain",
    });
  });

  it("reconciles a delivery intent with unknown outcome as uncertain, once", () => {
    const fixture = setup();
    fixture.recovery.recordDeliveryIntent("delivery-1", ["artifact://output/report"]);
    expect(fixture.recovery.reconcile(new Date(at(10))).map((event) => event.type))
      .toEqual(["delivery/outcome-recorded"]);
    expect(fixture.recovery.delivery("delivery-1").state).toBe("uncertain");
    expect(fixture.recovery.reconcile(new Date(at(11)))).toEqual([]);
  });
});
