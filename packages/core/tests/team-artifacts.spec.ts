import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleContract, TeamEvent } from "../src/team/events.js";
import { ArtifactRegistry } from "../src/team/artifacts.js";
import { openTeamStore, type TeamStore } from "../src/team/store.js";
import { TaskGraph } from "../src/team/tasks.js";

const noSync = () => {};
const hash = (char: string) => `sha256:${char.repeat(64)}`;
const role: RoleContract = {
  roleId: "worker",
  requires: ["research"],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 1,
};

function setup(): { root: string; store: TeamStore; graph: TaskGraph; artifacts: ArtifactRegistry } {
  const root = mkdtempSync(join(tmpdir(), "helium-artifact-"));
  const store = openTeamStore(root, "case-artifacts", { sync: noSync });
  const events: TeamEvent[] = [
    { version: 1, eventId: "open", at: "2026-08-30T09:00:00.000Z", caseId: "case-artifacts", type: "case/opened", payload: { subject: "macro" } },
    { version: 1, eventId: "start", at: "2026-08-30T09:01:00.000Z", caseId: "case-artifacts", teamRunId: "team-artifacts", type: "team/started", payload: {} },
    { version: 1, eventId: "worker", at: "2026-08-30T09:02:00.000Z", caseId: "case-artifacts", teamRunId: "team-artifacts", type: "agent/rostered", payload: { agentId: "worker", role } },
  ];
  for (const event of events) store.append(event);
  let n = 0;
  const graph = new TaskGraph(store, "team-artifacts", {
    now: () => "2026-08-30T09:03:00.000Z",
    eventId: () => `graph-${++n}`,
  });
  graph.add({ id: "source", ownerAgentId: "worker", dependsOn: [], acceptance: { outputSchema: "source/v1" } }, 0);
  graph.add({ id: "consumer", ownerAgentId: "worker", dependsOn: ["source"], acceptance: { outputSchema: "consumer/v1" } }, 1);
  graph.add({ id: "outsider", ownerAgentId: "worker", dependsOn: [], acceptance: { outputSchema: "outsider/v1" } }, 2);
  const artifacts = new ArtifactRegistry(store, "team-artifacts", {
    now: () => "2026-08-30T09:04:00.000Z",
    eventId: () => `artifact-${++n}`,
  });
  return { root, store, graph, artifacts };
}

describe("ArtifactRegistry", () => {
  it("hands an immutable artifact to a downstream task through its dependency edge", () => {
    const { artifacts } = setup();
    artifacts.publish({ taskId: "source", ref: "artifact://case/source.json", hash: hash("a") });
    expect(artifacts.inputsFor("consumer")).toEqual(["artifact://case/source.json"]);
    expect(artifacts.inputsFor("outsider")).toEqual([]);
  });

  it("is idempotent for the same content and rejects a changed hash", () => {
    const { store, artifacts } = setup();
    const manifest = { taskId: "source", ref: "artifact://case/source.json", hash: hash("a") };
    artifacts.publish(manifest);
    const count = store.events().length;
    artifacts.publish(manifest);
    expect(store.events()).toHaveLength(count);
    expect(() => artifacts.publish({ ...manifest, hash: hash("b") })).toThrow(
      /immutable artifact/,
    );
  });

  it("persists artifact reachability across restart", () => {
    const { root, artifacts } = setup();
    artifacts.publish({ taskId: "source", ref: "artifact://case/source.json", hash: hash("a") });
    const reopened = openTeamStore(root, "case-artifacts", { sync: noSync });
    const registry = new ArtifactRegistry(reopened, "team-artifacts", {
      now: () => "2026-08-30T09:05:00.000Z",
      eventId: () => "artifact-reopened",
    });
    expect(registry.inputsFor("consumer")).toEqual(["artifact://case/source.json"]);
  });

  it("refuses publication for an unknown task", () => {
    const { artifacts } = setup();
    expect(() => artifacts.publish({
      taskId: "missing",
      ref: "artifact://case/missing.json",
      hash: hash("a"),
    })).toThrow(/unknown task/);
  });
});

