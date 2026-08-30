/** Pure, deterministic projection of the durable team event stream. */
import type {
  RoleContract,
  TaskDefinition,
  TaskLease,
  TaskState,
  TeamEvent,
} from "./events.js";

export interface CaseProjection {
  caseId: string;
  subject: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
}

export interface RosterProjection {
  agentId: string;
  role: RoleContract;
  state: "idle";
}

export interface TaskProjection extends TaskDefinition {
  revision: number;
  state: TaskState;
  lease?: TaskLease;
}

export interface ArtifactProjection {
  taskId: string;
  ref: string;
  hash: string;
  publishedAt: string;
}

export interface TeamRunProjection {
  teamRunId: string;
  caseId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  roster: Record<string, RosterProjection>;
  graphRevision: number;
  tasks: Record<string, TaskProjection>;
  artifacts: Record<string, ArtifactProjection>;
  artifactRefs: string[];
  startedAt: string;
  terminalAt?: string;
  terminalReason?: string;
}

export interface TeamState {
  cases: Record<string, CaseProjection>;
  teams: Record<string, TeamRunProjection>;
  eventIds: string[];
}

export function emptyTeamState(): TeamState {
  return { cases: {}, teams: {}, eventIds: [] };
}

const copyRole = (role: RoleContract): RoleContract => ({
  ...role,
  requires: [...role.requires],
  tools: [...role.tools],
});

const copyTeam = (value: TeamRunProjection): TeamRunProjection => ({
  ...value,
  roster: Object.fromEntries(Object.entries(value.roster).map(([agentId, agent]) => [
    agentId,
    { ...agent, role: copyRole(agent.role) },
  ])),
  tasks: Object.fromEntries(Object.entries(value.tasks).map(([taskId, task]) => [
    taskId,
    {
      ...task,
      dependsOn: [...task.dependsOn],
      acceptance: { ...task.acceptance },
      ...(task.lease === undefined ? {} : { lease: { ...task.lease } }),
    },
  ])),
  artifacts: Object.fromEntries(Object.entries(value.artifacts).map(([ref, artifact]) => [
    ref,
    { ...artifact },
  ])),
  artifactRefs: [...value.artifactRefs],
});

export function reduceTeam(
  events: readonly TeamEvent[],
  initial: TeamState = emptyTeamState(),
): TeamState {
  const state: TeamState = {
    cases: Object.fromEntries(Object.entries(initial.cases).map(([id, value]) => [id, { ...value }])),
    teams: Object.fromEntries(Object.entries(initial.teams).map(([id, value]) => [id, copyTeam(value)])),
    eventIds: [...initial.eventIds],
  };
  const seen = new Set(state.eventIds);

  for (const event of events) {
    if (seen.has(event.eventId)) throw new Error(`duplicate team event id: ${event.eventId}`);
    seen.add(event.eventId);

    switch (event.type) {
      case "case/opened":
        if (state.cases[event.caseId] !== undefined) throw new Error(`case already opened: ${event.caseId}`);
        state.cases[event.caseId] = {
          caseId: event.caseId,
          subject: event.payload.subject,
          state: "open",
          openedAt: event.at,
        };
        break;

      case "case/closed": {
        const current = state.cases[event.caseId];
        if (current === undefined) throw new Error(`case/closed for unknown case: ${event.caseId}`);
        if (current.state === "closed") throw new Error(`case already terminal: ${event.caseId}`);
        current.state = "closed";
        current.closedAt = event.at;
        if (event.payload.reason !== undefined) current.closeReason = event.payload.reason;
        break;
      }

      case "team/started": {
        const owner = state.cases[event.caseId];
        if (owner === undefined) throw new Error(`team/started for unknown case: ${event.caseId}`);
        if (owner.state !== "open") throw new Error(`cannot start team for closed case: ${event.caseId}`);
        if (state.teams[event.teamRunId] !== undefined) throw new Error(`team already started: ${event.teamRunId}`);
        state.teams[event.teamRunId] = {
          teamRunId: event.teamRunId,
          caseId: event.caseId,
          state: "running",
          roster: {},
          graphRevision: 0,
          tasks: {},
          artifacts: {},
          artifactRefs: [],
          startedAt: event.at,
        };
        break;
      }

      case "agent/rostered": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.roster[event.payload.agentId] !== undefined) throw new Error(`agent already rostered: ${event.payload.agentId}`);
        team.roster[event.payload.agentId] = {
          agentId: event.payload.agentId,
          role: copyRole(event.payload.role),
          state: "idle",
        };
        break;
      }

      case "team/completed":
      case "team/failed":
      case "team/cancelled": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        team.state = event.type === "team/completed"
          ? "completed"
          : event.type === "team/failed"
            ? "failed"
            : "cancelled";
        team.terminalAt = event.at;
        if ("reason" in event.payload) team.terminalReason = event.payload.reason;
        break;
      }

      case "task/added": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.graphRevision !== event.payload.expectedGraphRevision) {
          throw new Error(`stale graph revision: expected ${event.payload.expectedGraphRevision}, current ${team.graphRevision}`);
        }
        if (event.payload.graphRevision !== team.graphRevision + 1) throw new Error(`invalid graph revision: ${event.payload.graphRevision}`);
        const task = event.payload.task;
        if (team.tasks[task.id] !== undefined) throw new Error(`task already exists: ${task.id}`);
        if (team.roster[task.ownerAgentId] === undefined) throw new Error(`unknown owner: ${task.ownerAgentId}`);
        for (const dependency of task.dependsOn) {
          if (team.tasks[dependency] === undefined) throw new Error(`unknown dependency: ${dependency}`);
        }
        team.tasks[task.id] = {
          ...task,
          dependsOn: [...task.dependsOn],
          acceptance: { ...task.acceptance },
          revision: 1,
          state: dependenciesComplete(team, task.dependsOn) ? "ready" : "pending",
        };
        assertAcyclic(team.tasks);
        team.graphRevision = event.payload.graphRevision;
        break;
      }

      case "task/updated": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const task = requireTask(team, event.payload.taskId, event.type);
        requireRevision(task, event.payload.expectedRevision, event.payload.revision);
        if (isTerminalTask(task.state)) throw new Error(`task already terminal: ${task.id}`);
        if (event.payload.patch.dependsOn !== undefined) {
          for (const dependency of event.payload.patch.dependsOn) {
            if (team.tasks[dependency] === undefined) throw new Error(`unknown dependency: ${dependency}`);
          }
          task.dependsOn = [...event.payload.patch.dependsOn];
          assertAcyclic(team.tasks);
          team.graphRevision += 1;
          if (task.state === "pending" || task.state === "ready") {
            task.state = dependenciesComplete(team, task.dependsOn) ? "ready" : "pending";
          }
        }
        if (event.payload.patch.state !== undefined) task.state = event.payload.patch.state;
        task.revision = event.payload.revision;
        if (task.state === "completed") refreshReadyTasks(team);
        break;
      }

      case "task/leased": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const task = requireTask(team, event.payload.taskId, event.type);
        requireRevision(task, event.payload.expectedRevision, event.payload.revision);
        if (task.state !== "ready") throw new Error(`task ${task.id} is not ready`);
        if (task.ownerAgentId !== event.payload.lease.ownerAgentId) throw new Error(`ownership conflict for task ${task.id}`);
        if (Date.parse(event.payload.lease.expiresAt) <= Date.parse(event.at)) {
          throw new Error(`lease already expired: ${event.payload.lease.leaseId}`);
        }
        task.state = "leased";
        task.lease = { ...event.payload.lease };
        task.revision = event.payload.revision;
        break;
      }

      case "task/lease-expired": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const task = requireTask(team, event.payload.taskId, event.type);
        requireRevision(task, event.payload.expectedRevision, event.payload.revision);
        if (task.state !== "leased" || task.lease?.leaseId !== event.payload.leaseId) {
          throw new Error(`lease mismatch for task ${task.id}`);
        }
        if (Date.parse(event.at) < Date.parse(task.lease.expiresAt)) throw new Error(`lease is not expired: ${event.payload.leaseId}`);
        task.state = dependenciesComplete(team, task.dependsOn) ? "ready" : "pending";
        delete task.lease;
        task.revision = event.payload.revision;
        break;
      }

      case "artifact/published": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        requireTask(team, event.payload.taskId, event.type);
        const existing = team.artifacts[event.payload.ref];
        if (existing !== undefined && existing.hash !== event.payload.hash) {
          throw new Error(`immutable artifact hash conflict: ${event.payload.ref}`);
        }
        if (existing === undefined) {
          team.artifacts[event.payload.ref] = {
            taskId: event.payload.taskId,
            ref: event.payload.ref,
            hash: event.payload.hash,
            publishedAt: event.at,
          };
          team.artifactRefs.push(event.payload.ref);
        }
        break;
      }
    }

    state.eventIds.push(event.eventId);
  }
  return state;
}

const isTerminalTask = (state: TaskState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled";

function requireRunningTeam(
  state: TeamState,
  teamRunId: string,
  caseId: string,
  eventType: string,
): TeamRunProjection {
  const team = state.teams[teamRunId];
  if (team === undefined) throw new Error(`${eventType} for unknown team: ${teamRunId}`);
  if (team.caseId !== caseId) throw new Error(`team ${teamRunId} belongs to case ${team.caseId}, not ${caseId}`);
  if (team.state !== "running") throw new Error(`team already terminal: ${teamRunId}`);
  return team;
}

function requireTask(team: TeamRunProjection, taskId: string, eventType: string): TaskProjection {
  const task = team.tasks[taskId];
  if (task === undefined) throw new Error(`${eventType} for unknown task: ${taskId}`);
  return task;
}

function requireRevision(task: TaskProjection, expected: number, next: number): void {
  if (task.revision !== expected) throw new Error(`stale task revision: expected ${expected}, current ${task.revision}`);
  if (next !== expected + 1) throw new Error(`invalid task revision: ${next}`);
}

function dependenciesComplete(team: TeamRunProjection, dependencies: readonly string[]): boolean {
  return dependencies.every((id) => team.tasks[id]?.state === "completed");
}

function refreshReadyTasks(team: TeamRunProjection): void {
  for (const task of Object.values(team.tasks)) {
    if (task.state === "pending" && dependenciesComplete(team, task.dependsOn)) task.state = "ready";
  }
}

function assertAcyclic(tasks: Record<string, TaskProjection>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`task dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks[id]?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(tasks)) visit(id);
}
