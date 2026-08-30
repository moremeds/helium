import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleContract, TeamEvent } from "../src/team/events.js";
import { openTeamStore, type TeamStore } from "../src/team/store.js";
import { TaskGraph } from "../src/team/tasks.js";

const noSync = () => {};
const at = (minute: number) => `2026-08-30T08:${String(minute).padStart(2, "0")}:00.000Z`;
const role = (roleId: string): RoleContract => ({
  roleId,
  requires: [roleId],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 0.5,
});

function setup(): { store: TeamStore; graph: TaskGraph } {
  const store = openTeamStore(mkdtempSync(join(tmpdir(), "helium-task-")), "case-tasks", {
    sync: noSync,
  });
  const events: TeamEvent[] = [
    { version: 1, eventId: "open", at: at(0), caseId: "case-tasks", type: "case/opened", payload: { subject: "macro" } },
    { version: 1, eventId: "start", at: at(1), caseId: "case-tasks", teamRunId: "team-tasks", type: "team/started", payload: {} },
    { version: 1, eventId: "lead", at: at(2), caseId: "case-tasks", teamRunId: "team-tasks", type: "agent/rostered", payload: { agentId: "lead", role: role("lead") } },
    { version: 1, eventId: "reviewer", at: at(3), caseId: "case-tasks", teamRunId: "team-tasks", type: "agent/rostered", payload: { agentId: "reviewer", role: role("reviewer") } },
  ];
  for (const event of events) store.append(event);
  return {
    store,
    graph: new TaskGraph(store, "team-tasks", {
      now: () => at(4),
      eventId: (() => { let n = 0; return () => `task-event-${++n}`; })(),
    }),
  };
}

describe("TaskGraph", () => {
  it("adds a CAS-versioned DAG and derives ready state from dependencies", () => {
    const { graph } = setup();
    expect(graph.add({
      id: "research",
      ownerAgentId: "lead",
      dependsOn: [],
      acceptance: { outputSchema: "claims/v1" },
    }, 0)).toMatchObject({ revision: 1, state: "ready" });
    expect(graph.add({
      id: "review",
      ownerAgentId: "reviewer",
      dependsOn: ["research"],
      acceptance: { outputSchema: "review/v1" },
    }, 1)).toMatchObject({ revision: 1, state: "pending" });
    expect(graph.revision()).toBe(2);
  });

  it("rejects stale graph and task revisions", () => {
    const { graph } = setup();
    graph.add({ id: "a", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "a/v1" } }, 0);
    expect(() => graph.add(
      { id: "b", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "b/v1" } },
      0,
    )).toThrow(/stale graph revision/);
    graph.update("a", 1, { state: "running" });
    expect(() => graph.update("a", 1, { state: "needs-input" })).toThrow(/stale task revision/);
  });

  it("rejects cycles introduced by an update", () => {
    const { graph } = setup();
    graph.add({ id: "a", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "a/v1" } }, 0);
    graph.add({ id: "b", ownerAgentId: "reviewer", dependsOn: ["a"], acceptance: { outputSchema: "b/v1" } }, 1);
    expect(() => graph.update("a", 1, { dependsOn: ["b"] })).toThrow(/cycle/);
  });

  it("rejects unknown owners and ownership conflicts", () => {
    const { graph } = setup();
    expect(() => graph.add(
      { id: "a", ownerAgentId: "missing", dependsOn: [], acceptance: { outputSchema: "a/v1" } },
      0,
    )).toThrow(/unknown owner/);
    graph.add({ id: "a", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "a/v1" } }, 0);
    expect(() => graph.lease("a", 1, {
      leaseId: "lease-a",
      ownerAgentId: "reviewer",
      expiresAt: at(8),
    })).toThrow(/ownership conflict/);
  });

  it("expires a lease deterministically and makes the task ready again", () => {
    const { graph } = setup();
    graph.add({ id: "a", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "a/v1" } }, 0);
    expect(graph.lease("a", 1, {
      leaseId: "lease-a",
      ownerAgentId: "lead",
      expiresAt: at(8),
    })).toMatchObject({ state: "leased", revision: 2 });
    expect(graph.expireLeases(new Date(at(9)))).toEqual(["a"]);
    expect(graph.get("a")).toMatchObject({ state: "ready", revision: 3 });
    expect(graph.get("a").lease).toBeUndefined();
  });

  it("rejects an update after a task becomes terminal", () => {
    const { graph } = setup();
    graph.add({ id: "a", ownerAgentId: "lead", dependsOn: [], acceptance: { outputSchema: "a/v1" } }, 0);
    graph.update("a", 1, { state: "completed" });
    expect(() => graph.update("a", 2, { state: "running" })).toThrow(/already terminal/);
  });
});
