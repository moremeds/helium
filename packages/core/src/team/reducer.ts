/** Pure, deterministic projection of the durable team event stream. */
import type {
  BudgetAmount,
  ExecutionAttemptSeed,
  RoleContract,
  TaskDefinition,
  TaskLease,
  TaskState,
  TeamEvent,
} from "./events.js";
import type { AgentResult, WorkOrder } from "../work.js";
import { canonicalJson } from "../jsonl.js";

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
  parentAgentId?: string;
  role: RoleContract;
  state: "idle" | "cancelled";
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

export interface BudgetReservationProjection {
  operationId: string;
  agentId: string;
  amount: BudgetAmount;
  reservedAt: string;
}

export interface ExecutionAttemptProjection extends ExecutionAttemptSeed {
  state: "created" | "running" | "completed" | "failed" | "quota-exhausted" | "interrupted";
  leaseId?: string;
  result?: AgentResult;
  predecessorAttemptId?: string;
  successorAttemptId?: string;
  interruptedOutcome?: "uncertain";
}

export interface CapacityWaitProjection {
  waitId: string;
  taskId: string;
  exhaustedAttemptId: string;
  waitingSince: string;
  availabilityEventId?: string;
  resumedAttemptId?: string;
}

export interface DeliveryProjection {
  deliveryId: string;
  artifactRefs: string[];
  state: "intent-recorded" | "delivered" | "failed" | "uncertain";
  intentAt: string;
  outcomeAt?: string;
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
  budgetReservations: Record<string, BudgetReservationProjection>;
  attempts: Record<string, ExecutionAttemptProjection>;
  capacityWaits: Record<string, CapacityWaitProjection>;
  waitingByTask: Record<string, string>;
  deliveries: Record<string, DeliveryProjection>;
  cancellationRequestedAt?: string;
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

const copyWorkOrder = (workOrder: WorkOrder): WorkOrder => ({
  ...workOrder,
  requires: [...workOrder.requires],
  constraints: { ...workOrder.constraints, tools: [...workOrder.constraints.tools] },
  inputs: { ...workOrder.inputs, artifacts: [...workOrder.inputs.artifacts] },
  acceptance: { ...workOrder.acceptance },
});

const copyAttempt = (attempt: ExecutionAttemptProjection): ExecutionAttemptProjection => ({
  ...attempt,
  workOrder: copyWorkOrder(attempt.workOrder),
  artifactRefs: [...attempt.artifactRefs],
  remainingBudget: { ...attempt.remainingBudget },
  ...(attempt.result === undefined ? {} : {
    result: {
      ...attempt.result,
      ...(attempt.result.failure === undefined ? {} : { failure: { ...attempt.result.failure } }),
      artifacts: [...attempt.result.artifacts],
      usage: { ...attempt.result.usage },
      executionSnapshot: { ...attempt.result.executionSnapshot },
      runtimeMetadata: { ...attempt.result.runtimeMetadata },
    },
  }),
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
  budgetReservations: Object.fromEntries(
    Object.entries(value.budgetReservations).map(([operationId, reservation]) => [
      operationId,
      { ...reservation, amount: { ...reservation.amount } },
    ]),
  ),
  attempts: Object.fromEntries(Object.entries(value.attempts).map(([attemptId, attempt]) => [
    attemptId,
    copyAttempt(attempt),
  ])),
  capacityWaits: Object.fromEntries(Object.entries(value.capacityWaits).map(([waitId, wait]) => [
    waitId,
    { ...wait },
  ])),
  waitingByTask: { ...value.waitingByTask },
  deliveries: Object.fromEntries(Object.entries(value.deliveries).map(([deliveryId, delivery]) => [
    deliveryId,
    { ...delivery, artifactRefs: [...delivery.artifactRefs] },
  ])),
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
      case "team/admission-refused":
        // Audit-only case event. It deliberately does not create a team run:
        // admission was refused before optional work could start.
        break;

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
          budgetReservations: {},
          attempts: {},
          capacityWaits: {},
          waitingByTask: {},
          deliveries: {},
          startedAt: event.at,
        };
        break;
      }

      case "agent/rostered": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.roster[event.payload.agentId] !== undefined) throw new Error(`agent already rostered: ${event.payload.agentId}`);
        if (event.payload.parentAgentId === event.payload.agentId) throw new Error("agent cannot parent itself");
        if (
          event.payload.parentAgentId !== undefined
          && team.roster[event.payload.parentAgentId] === undefined
        ) {
          throw new Error(`unknown parent agent: ${event.payload.parentAgentId}`);
        }
        team.roster[event.payload.agentId] = {
          agentId: event.payload.agentId,
          ...(event.payload.parentAgentId === undefined
            ? {}
            : { parentAgentId: event.payload.parentAgentId }),
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
        task.revision = event.payload.revision;
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

      case "budget/reserved": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.roster[event.payload.agentId] === undefined) {
          throw new Error(`budget/reserved for unknown agent: ${event.payload.agentId}`);
        }
        const existing = team.budgetReservations[event.payload.operationId];
        if (existing !== undefined) {
          if (
            existing.agentId !== event.payload.agentId
            || existing.amount.tokens !== event.payload.amount.tokens
            || existing.amount.cost !== event.payload.amount.cost
            || existing.amount.ms !== event.payload.amount.ms
          ) {
            throw new Error(`budget operation id conflict: ${event.payload.operationId}`);
          }
          break;
        }
        team.budgetReservations[event.payload.operationId] = {
          operationId: event.payload.operationId,
          agentId: event.payload.agentId,
          amount: { ...event.payload.amount },
          reservedAt: event.at,
        };
        break;
      }

      case "task/execution-intent": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const task = requireTask(team, event.payload.taskId, event.type);
        if (task.state !== "leased" || task.lease?.leaseId !== event.payload.leaseId) {
          throw new Error(`execution intent has no matching active lease: ${event.payload.attemptId}`);
        }
        const existing = team.attempts[event.payload.attemptId];
        if (existing !== undefined) {
          if (existing.state !== "created") throw new Error(`attempt already started: ${event.payload.attemptId}`);
          assertSameAttemptSeed(existing, event.payload);
          existing.state = "running";
          existing.leaseId = event.payload.leaseId;
        } else {
          team.attempts[event.payload.attemptId] = {
            ...copyAttemptSeed(event.payload),
            leaseId: event.payload.leaseId,
            state: "running",
          };
        }
        task.state = "running";
        task.revision += 1;
        break;
      }

      case "task/execution-result": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const attempt = requireAttempt(team, event.payload.attemptId, event.type);
        if (attempt.state !== "running") throw new Error(`attempt is not running: ${attempt.attemptId}`);
        if (event.payload.result.workId !== attempt.workOrder.id) throw new Error(`result work id mismatch: ${attempt.attemptId}`);
        if (event.payload.result.executionSnapshot.targetId !== attempt.targetId) {
          throw new Error(`result target mismatch: ${attempt.attemptId}`);
        }
        attempt.result = copyAgentResult(event.payload.result);
        attempt.state = event.payload.result.outcome === "completed"
          ? "completed"
          : event.payload.result.failure?.class === "quota-exhausted"
            ? "quota-exhausted"
            : "failed";
        const task = requireTask(team, attempt.taskId, event.type);
        task.state = attempt.state === "completed" ? "completed" : "needs-input";
        delete task.lease;
        task.revision += 1;
        if (task.state === "completed") refreshReadyTasks(team);
        break;
      }

      case "task/interrupted": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const attempt = requireAttempt(team, event.payload.attemptId, event.type);
        if (attempt.taskId !== event.payload.taskId) throw new Error(`interrupted task mismatch: ${attempt.attemptId}`);
        if (attempt.state !== "running") throw new Error(`attempt is not running: ${attempt.attemptId}`);
        attempt.state = "interrupted";
        attempt.interruptedOutcome = event.payload.outcome;
        const task = requireTask(team, attempt.taskId, event.type);
        task.state = "needs-input";
        delete task.lease;
        task.revision += 1;
        break;
      }

      case "task/fallback-created": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const prior = requireAttempt(team, event.payload.priorAttemptId, event.type);
        if (prior.state !== "quota-exhausted") throw new Error(`fallback prior attempt is not quota-exhausted: ${prior.attemptId}`);
        if (prior.exactTarget) throw new Error(`exact-target attempt cannot fall back: ${prior.attemptId}`);
        if (prior.successorAttemptId !== undefined) throw new Error(`attempt already has fallback: ${prior.attemptId}`);
        assertSameAttemptInputs(prior, event.payload.attempt);
        if (event.payload.attempt.targetId === prior.targetId) throw new Error("fallback must select a different target");
        if (team.attempts[event.payload.attempt.attemptId] !== undefined) throw new Error(`attempt already exists: ${event.payload.attempt.attemptId}`);
        team.attempts[event.payload.attempt.attemptId] = {
          ...copyAttemptSeed(event.payload.attempt),
          state: "created",
          predecessorAttemptId: prior.attemptId,
        };
        prior.successorAttemptId = event.payload.attempt.attemptId;
        const task = requireTask(team, prior.taskId, event.type);
        task.state = "ready";
        task.revision += 1;
        break;
      }

      case "team/waiting-for-capacity": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const attempt = requireAttempt(team, event.payload.exhaustedAttemptId, event.type);
        if (attempt.state !== "quota-exhausted" || attempt.taskId !== event.payload.taskId) {
          throw new Error(`invalid capacity wait source: ${event.payload.exhaustedAttemptId}`);
        }
        if (team.waitingByTask[event.payload.taskId] !== undefined) {
          throw new Error(`task already waiting for capacity: ${event.payload.taskId}`);
        }
        team.capacityWaits[event.payload.waitId] = {
          ...event.payload,
          waitingSince: event.at,
        };
        team.waitingByTask[event.payload.taskId] = event.payload.waitId;
        break;
      }

      case "team/capacity-resumed": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const wait = team.capacityWaits[event.payload.waitId];
        if (wait === undefined) throw new Error(`unknown capacity wait: ${event.payload.waitId}`);
        if (wait.resumedAttemptId !== undefined) throw new Error(`capacity wait already resumed: ${wait.waitId}`);
        const prior = requireAttempt(team, wait.exhaustedAttemptId, event.type);
        assertSameAttemptInputs(prior, event.payload.attempt);
        if (team.attempts[event.payload.attempt.attemptId] !== undefined) throw new Error(`attempt already exists: ${event.payload.attempt.attemptId}`);
        team.attempts[event.payload.attempt.attemptId] = {
          ...copyAttemptSeed(event.payload.attempt),
          state: "created",
          predecessorAttemptId: prior.attemptId,
        };
        prior.successorAttemptId = event.payload.attempt.attemptId;
        wait.availabilityEventId = event.payload.availabilityEventId;
        wait.resumedAttemptId = event.payload.attempt.attemptId;
        delete team.waitingByTask[wait.taskId];
        const task = requireTask(team, wait.taskId, event.type);
        task.state = "ready";
        task.revision += 1;
        break;
      }

      case "team/cancellation-requested": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.cancellationRequestedAt !== undefined) throw new Error(`team cancellation already requested: ${team.teamRunId}`);
        team.cancellationRequestedAt = event.at;
        break;
      }

      case "task/cancelled": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const task = requireTask(team, event.payload.taskId, event.type);
        requireRevision(task, event.payload.expectedRevision, event.payload.revision);
        if (isTerminalTask(task.state)) throw new Error(`task already terminal: ${task.id}`);
        task.state = "cancelled";
        delete task.lease;
        task.revision = event.payload.revision;
        for (const attempt of Object.values(team.attempts)) {
          if (attempt.taskId !== task.id || attempt.state !== "running") continue;
          attempt.state = "interrupted";
          attempt.interruptedOutcome = "uncertain";
        }
        break;
      }

      case "agent/cancelled": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const agent = team.roster[event.payload.agentId];
        if (agent === undefined) throw new Error(`unknown agent: ${event.payload.agentId}`);
        if (agent.state === "cancelled") throw new Error(`agent already cancelled: ${event.payload.agentId}`);
        agent.state = "cancelled";
        break;
      }

      case "delivery/intent-recorded": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        if (team.deliveries[event.payload.deliveryId] !== undefined) throw new Error(`delivery already exists: ${event.payload.deliveryId}`);
        team.deliveries[event.payload.deliveryId] = {
          deliveryId: event.payload.deliveryId,
          artifactRefs: [...event.payload.artifactRefs],
          state: "intent-recorded",
          intentAt: event.at,
        };
        break;
      }

      case "delivery/outcome-recorded": {
        const team = requireRunningTeam(state, event.teamRunId, event.caseId, event.type);
        const delivery = team.deliveries[event.payload.deliveryId];
        if (delivery === undefined) throw new Error(`unknown delivery: ${event.payload.deliveryId}`);
        if (delivery.state !== "intent-recorded") throw new Error(`delivery already terminal: ${event.payload.deliveryId}`);
        delivery.state = event.payload.outcome;
        delivery.outcomeAt = event.at;
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

function requireAttempt(
  team: TeamRunProjection,
  attemptId: string,
  eventType: string,
): ExecutionAttemptProjection {
  const attempt = team.attempts[attemptId];
  if (attempt === undefined) throw new Error(`${eventType} for unknown attempt: ${attemptId}`);
  return attempt;
}

function copyAttemptSeed(seed: ExecutionAttemptSeed): ExecutionAttemptSeed {
  return {
    ...seed,
    workOrder: copyWorkOrder(seed.workOrder),
    artifactRefs: [...seed.artifactRefs],
    remainingBudget: { ...seed.remainingBudget },
  };
}

function copyAgentResult(result: AgentResult): AgentResult {
  return {
    ...result,
    ...(result.failure === undefined ? {} : { failure: { ...result.failure } }),
    artifacts: [...result.artifacts],
    usage: { ...result.usage },
    executionSnapshot: { ...result.executionSnapshot },
    runtimeMetadata: { ...result.runtimeMetadata },
  };
}

function assertSameAttemptSeed(
  existing: ExecutionAttemptProjection,
  candidate: ExecutionAttemptSeed,
): void {
  if (
    existing.taskId !== candidate.taskId
    || existing.targetId !== candidate.targetId
    || existing.catalogSnapshotId !== candidate.catalogSnapshotId
    || existing.exactTarget !== candidate.exactTarget
  ) {
    throw new Error(`attempt input mismatch: ${existing.attemptId}`);
  }
  assertSameAttemptInputs(existing, candidate);
}

function assertSameAttemptInputs(
  prior: ExecutionAttemptProjection,
  candidate: ExecutionAttemptSeed,
): void {
  if (
    prior.taskId !== candidate.taskId
    || canonicalJson(prior.workOrder) !== canonicalJson(candidate.workOrder)
    || canonicalJson(prior.artifactRefs) !== canonicalJson(candidate.artifactRefs)
    || canonicalJson(prior.remainingBudget) !== canonicalJson(candidate.remainingBudget)
    || prior.exactTarget !== candidate.exactTarget
  ) {
    throw new Error(`fallback changed immutable attempt inputs: ${prior.attemptId}`);
  }
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
