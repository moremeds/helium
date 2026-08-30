/** Restart reconciliation, quota-capacity transitions, cancellation, and delivery recovery. */
import { randomUUID } from "node:crypto";
import type { AgentResult } from "../work.js";
import type {
  ExecutionAttemptInput as EventExecutionAttemptInput,
  ExecutionAttemptSeed,
  TeamEvent,
} from "./events.js";
import type {
  CapacityWaitProjection,
  DeliveryProjection,
  ExecutionAttemptProjection,
  TaskProjection,
  TeamRunProjection,
} from "./reducer.js";
import type { TeamStore } from "./store.js";

export type ExecutionAttemptInput = EventExecutionAttemptInput;

export interface CapacitySelection {
  attemptId: string;
  targetId: string;
  catalogSnapshotId: string;
}

export interface TeamRecoveryOptions {
  now?: () => string;
  eventId?: () => string;
}

export interface CancellationHooks {
  interruptAgent(agentId: string): Promise<void>;
  drain(): Promise<void>;
}

export class TeamRecoveryCoordinator {
  readonly #store: TeamStore;
  readonly #teamRunId: string;
  readonly #now: () => string;
  readonly #eventId: () => string;

  constructor(store: TeamStore, teamRunId: string, options: TeamRecoveryOptions = {}) {
    this.#store = store;
    this.#teamRunId = teamRunId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventId ?? (() => `recovery-${randomUUID()}`);
    this.#team();
  }

  recordExecutionIntent(input: ExecutionAttemptInput): ExecutionAttemptProjection {
    const team = this.#team();
    this.#store.append({
      ...this.#base(team),
      type: "task/execution-intent",
      payload: input,
    });
    return this.attempt(input.attemptId);
  }

  recordExecutionResult(attemptId: string, result: AgentResult): ExecutionAttemptProjection {
    const team = this.#team();
    this.#store.append({
      ...this.#base(team),
      type: "task/execution-result",
      payload: { attemptId, result },
    });
    return this.attempt(attemptId);
  }

  routeQuota(
    attemptId: string,
    selection?: CapacitySelection,
  ): ExecutionAttemptProjection | undefined {
    const team = this.#team();
    const attempt = this.#attempt(team, attemptId);
    if (attempt.state !== "quota-exhausted") {
      throw new Error(`attempt is not quota-exhausted: ${attemptId}`);
    }
    if (attempt.successorAttemptId !== undefined) return this.#attempt(team, attempt.successorAttemptId);
    const existingWaitId = team.waitingByTask[attempt.taskId];
    if (existingWaitId !== undefined) return undefined;

    if (attempt.exactTarget || selection === undefined) {
      this.#store.append({
        ...this.#base(team),
        type: "team/waiting-for-capacity",
        payload: {
          waitId: `capacity-${attempt.attemptId}`,
          taskId: attempt.taskId,
          exhaustedAttemptId: attempt.attemptId,
        },
      });
      return undefined;
    }

    const seed = nextSeed(attempt, selection);
    this.#store.append({
      ...this.#base(team),
      type: "task/fallback-created",
      payload: { priorAttemptId: attempt.attemptId, attempt: seed },
    });
    return this.attempt(seed.attemptId);
  }

  resumeCapacity(
    taskId: string,
    availabilityEventId: string,
    selection: CapacitySelection,
  ): ExecutionAttemptProjection {
    const team = this.#team();
    const wait = currentOrLastWait(team, taskId);
    if (wait === undefined) throw new Error(`task is not waiting for capacity: ${taskId}`);
    if (wait.resumedAttemptId !== undefined) return this.#attempt(team, wait.resumedAttemptId);
    const prior = this.#attempt(team, wait.exhaustedAttemptId);
    if (prior.exactTarget && selection.targetId !== prior.targetId) {
      throw new Error(`exact-target resume must keep target ${prior.targetId}`);
    }
    const seed = nextSeed(prior, selection);
    this.#store.append({
      ...this.#base(team),
      type: "team/capacity-resumed",
      payload: {
        waitId: wait.waitId,
        availabilityEventId,
        attempt: seed,
      },
    });
    return this.attempt(seed.attemptId);
  }

  reconcile(now: Date): TeamEvent[] {
    const appended: TeamEvent[] = [];
    let team = this.#team();
    for (const attempt of Object.values(team.attempts)) {
      if (attempt.state !== "running") continue;
      const event: TeamEvent = {
        ...this.#base(team, now.toISOString()),
        type: "task/interrupted",
        payload: {
          attemptId: attempt.attemptId,
          taskId: attempt.taskId,
          reason: "startup-recovery",
          outcome: "uncertain",
        },
      };
      this.#store.append(event);
      appended.push(event);
      team = this.#team();
    }

    for (const task of Object.values(team.tasks)) {
      if (task.state !== "leased" || task.lease === undefined) continue;
      if (Date.parse(task.lease.expiresAt) > now.getTime()) continue;
      const event: TeamEvent = {
        ...this.#base(team, now.toISOString()),
        type: "task/lease-expired",
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          revision: task.revision + 1,
          leaseId: task.lease.leaseId,
        },
      };
      this.#store.append(event);
      appended.push(event);
      team = this.#team();
    }

    for (const delivery of Object.values(team.deliveries)) {
      if (delivery.state !== "intent-recorded") continue;
      const event: TeamEvent = {
        ...this.#base(team, now.toISOString()),
        type: "delivery/outcome-recorded",
        payload: { deliveryId: delivery.deliveryId, outcome: "uncertain" },
      };
      this.#store.append(event);
      appended.push(event);
      team = this.#team();
    }
    return appended;
  }

  async cancel(reason: string, hooks: CancellationHooks): Promise<void> {
    let team = this.#team();
    if (team.state !== "running") return;
    if (team.cancellationRequestedAt === undefined) {
      this.#store.append({
        ...this.#base(team),
        type: "team/cancellation-requested",
        payload: { reason },
      });
    }

    team = this.#team();
    for (const taskId of cancellationTaskOrder(team)) {
      team = this.#team();
      const task = team.tasks[taskId];
      if (task === undefined || terminalTask(task)) continue;
      this.#store.append({
        ...this.#base(team),
        type: "task/cancelled",
        payload: {
          taskId,
          expectedRevision: task.revision,
          revision: task.revision + 1,
          reason,
        },
      });
    }

    for (const agentId of cancellationAgentOrder(this.#team())) {
      team = this.#team();
      if (team.roster[agentId]?.state === "cancelled") continue;
      await hooks.interruptAgent(agentId);
      this.#store.append({
        ...this.#base(team),
        type: "agent/cancelled",
        payload: { agentId, reason },
      });
    }
    await hooks.drain();
    team = this.#team();
    this.#store.append({
      ...this.#base(team),
      type: "team/cancelled",
      payload: { reason },
    });
  }

  recordDeliveryIntent(deliveryId: string, artifactRefs: string[]): DeliveryProjection {
    const team = this.#team();
    this.#store.append({
      ...this.#base(team),
      type: "delivery/intent-recorded",
      payload: { deliveryId, artifactRefs },
    });
    return this.delivery(deliveryId);
  }

  recordDeliveryOutcome(
    deliveryId: string,
    outcome: "delivered" | "failed" | "uncertain",
  ): DeliveryProjection {
    const team = this.#team();
    this.#store.append({
      ...this.#base(team),
      type: "delivery/outcome-recorded",
      payload: { deliveryId, outcome },
    });
    return this.delivery(deliveryId);
  }

  attempt(attemptId: string): ExecutionAttemptProjection {
    return this.#attempt(this.#team(), attemptId);
  }

  waiting(taskId: string): CapacityWaitProjection | undefined {
    return currentOrLastWait(this.#team(), taskId);
  }

  delivery(deliveryId: string): DeliveryProjection {
    const delivery = this.#team().deliveries[deliveryId];
    if (delivery === undefined) throw new Error(`unknown delivery: ${deliveryId}`);
    return delivery;
  }

  #team(): TeamRunProjection {
    const team = this.#store.load().teams[this.#teamRunId];
    if (team === undefined) throw new Error(`unknown team: ${this.#teamRunId}`);
    return team;
  }

  #attempt(team: TeamRunProjection, attemptId: string): ExecutionAttemptProjection {
    const attempt = team.attempts[attemptId];
    if (attempt === undefined) throw new Error(`unknown attempt: ${attemptId}`);
    return attempt;
  }

  #base(team: TeamRunProjection, at = this.#now()): {
    version: 1;
    eventId: string;
    at: string;
    caseId: string;
    teamRunId: string;
  } {
    return {
      version: 1,
      eventId: this.#eventId(),
      at,
      caseId: team.caseId,
      teamRunId: team.teamRunId,
    };
  }
}

function nextSeed(
  prior: ExecutionAttemptProjection,
  selection: CapacitySelection,
): ExecutionAttemptSeed {
  return {
    attemptId: selection.attemptId,
    taskId: prior.taskId,
    targetId: selection.targetId,
    catalogSnapshotId: selection.catalogSnapshotId,
    workOrder: prior.workOrder,
    artifactRefs: prior.artifactRefs,
    remainingBudget: prior.remainingBudget,
    exactTarget: prior.exactTarget,
  };
}

function currentOrLastWait(
  team: TeamRunProjection,
  taskId: string,
): CapacityWaitProjection | undefined {
  const current = team.waitingByTask[taskId];
  if (current !== undefined) return team.capacityWaits[current];
  return Object.values(team.capacityWaits).filter((wait) => wait.taskId === taskId).at(-1);
}

function terminalTask(task: TaskProjection): boolean {
  return task.state === "completed" || task.state === "failed" || task.state === "cancelled";
}

function cancellationTaskOrder(team: TeamRunProjection): string[] {
  const depth = (taskId: string, seen = new Set<string>()): number => {
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const dependents = Object.values(team.tasks).filter((task) => task.dependsOn.includes(taskId));
    if (dependents.length === 0) return 0;
    return 1 + Math.max(...dependents.map((task) => depth(task.id, new Set(seen))));
  };
  return Object.keys(team.tasks).sort((left, right) => depth(left) - depth(right));
}

function cancellationAgentOrder(team: TeamRunProjection): string[] {
  const depth = (agentId: string): number => {
    let current = team.roster[agentId];
    let value = 0;
    const seen = new Set<string>();
    while (current?.parentAgentId !== undefined) {
      if (seen.has(current.agentId)) throw new Error(`agent parent cycle: ${current.agentId}`);
      seen.add(current.agentId);
      value += 1;
      current = team.roster[current.parentAgentId];
    }
    return value;
  };
  return Object.keys(team.roster).sort((left, right) => depth(right) - depth(left));
}
