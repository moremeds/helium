/** Event-backed compare-and-swap task DAG. */
import { randomUUID } from "node:crypto";
import type {
  TaskDefinition,
  TaskLease,
  TaskPatch,
  TeamEvent,
} from "./events.js";
import type { TaskProjection, TeamRunProjection } from "./reducer.js";
import type { TeamStore } from "./store.js";

export interface TaskGraphOptions {
  now?: () => string;
  eventId?: () => string;
}

export class TaskGraph {
  readonly #store: TeamStore;
  readonly #teamRunId: string;
  readonly #now: () => string;
  readonly #eventId: () => string;

  constructor(store: TeamStore, teamRunId: string, options: TaskGraphOptions = {}) {
    this.#store = store;
    this.#teamRunId = teamRunId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventId ?? (() => `task-${randomUUID()}`);
    this.#team();
  }

  revision(): number {
    return this.#team().graphRevision;
  }

  get(taskId: string): TaskProjection {
    const task = this.#team().tasks[taskId];
    if (task === undefined) throw new Error(`unknown task: ${taskId}`);
    return task;
  }

  add(task: TaskDefinition, expectedGraphRevision: number): TaskProjection {
    const team = this.#team();
    const event: TeamEvent = {
      ...this.#base(team, "task/added"),
      type: "task/added",
      payload: {
        expectedGraphRevision,
        graphRevision: expectedGraphRevision + 1,
        task,
      },
    };
    this.#store.append(event);
    return this.get(task.id);
  }

  update(taskId: string, expectedRevision: number, patch: TaskPatch): TaskProjection {
    if ("state" in (patch as object)) {
      throw new Error("task state transitions require lease or execution events");
    }
    if (patch.dependsOn === undefined) {
      throw new Error("task update patch is empty");
    }
    const team = this.#team();
    const event: TeamEvent = {
      ...this.#base(team, "task/updated"),
      type: "task/updated",
      payload: {
        taskId,
        expectedRevision,
        revision: expectedRevision + 1,
        patch,
      },
    };
    this.#store.append(event);
    return this.get(taskId);
  }

  lease(taskId: string, expectedRevision: number, lease: TaskLease): TaskProjection {
    const team = this.#team();
    const event: TeamEvent = {
      ...this.#base(team, "task/leased"),
      type: "task/leased",
      payload: {
        taskId,
        expectedRevision,
        revision: expectedRevision + 1,
        lease,
      },
    };
    this.#store.append(event);
    return this.get(taskId);
  }

  expireLeases(now: Date): string[] {
    const expired: string[] = [];
    for (const task of Object.values(this.#team().tasks)) {
      if (task.state !== "leased" || task.lease === undefined) continue;
      if (Date.parse(task.lease.expiresAt) > now.getTime()) continue;
      const team = this.#team();
      this.#store.append({
        version: 1,
        eventId: this.#eventId(),
        at: now.toISOString(),
        caseId: team.caseId,
        teamRunId: team.teamRunId,
        type: "task/lease-expired",
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          revision: task.revision + 1,
          leaseId: task.lease.leaseId,
        },
      });
      expired.push(task.id);
    }
    return expired;
  }

  #team(): TeamRunProjection {
    const team = this.#store.load().teams[this.#teamRunId];
    if (team === undefined) throw new Error(`unknown team: ${this.#teamRunId}`);
    return team;
  }

  #base(team: TeamRunProjection, _type: string): {
    version: 1;
    eventId: string;
    at: string;
    caseId: string;
    teamRunId: string;
  } {
    return {
      version: 1,
      eventId: this.#eventId(),
      at: this.#now(),
      caseId: team.caseId,
      teamRunId: team.teamRunId,
    };
  }
}
