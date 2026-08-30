/** Immutable, event-backed artifact publication and dependency handoff. */
import { randomUUID } from "node:crypto";
import type { ArtifactProjection, TeamRunProjection } from "./reducer.js";
import type { TeamStore } from "./store.js";

export interface ArtifactInput {
  taskId: string;
  ref: string;
  hash: string;
}

export interface ArtifactRegistryOptions {
  now?: () => string;
  eventId?: () => string;
}

export class ArtifactRegistry {
  readonly #store: TeamStore;
  readonly #teamRunId: string;
  readonly #now: () => string;
  readonly #eventId: () => string;

  constructor(store: TeamStore, teamRunId: string, options: ArtifactRegistryOptions = {}) {
    this.#store = store;
    this.#teamRunId = teamRunId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventId ?? (() => `artifact-${randomUUID()}`);
    this.#team();
  }

  publish(input: ArtifactInput): ArtifactProjection {
    const team = this.#team();
    if (team.tasks[input.taskId] === undefined) throw new Error(`unknown task: ${input.taskId}`);
    const existing = team.artifacts[input.ref];
    if (existing !== undefined) {
      if (existing.hash !== input.hash || existing.taskId !== input.taskId) {
        throw new Error(`immutable artifact conflict: ${input.ref}`);
      }
      return existing;
    }
    this.#store.append({
      version: 1,
      eventId: this.#eventId(),
      at: this.#now(),
      caseId: team.caseId,
      teamRunId: team.teamRunId,
      type: "artifact/published",
      payload: input,
    });
    return this.#team().artifacts[input.ref];
  }

  inputsFor(taskId: string): string[] {
    const team = this.#team();
    const task = team.tasks[taskId];
    if (task === undefined) throw new Error(`unknown task: ${taskId}`);
    const reachable = new Set<string>();
    const visit = (dependencyId: string): void => {
      if (reachable.has(dependencyId)) return;
      reachable.add(dependencyId);
      const dependency = team.tasks[dependencyId];
      if (dependency === undefined) throw new Error(`unknown dependency: ${dependencyId}`);
      for (const ancestor of dependency.dependsOn) visit(ancestor);
    };
    for (const dependency of task.dependsOn) visit(dependency);
    return team.artifactRefs.filter((ref) => reachable.has(team.artifacts[ref].taskId));
  }

  #team(): TeamRunProjection {
    const team = this.#store.load().teams[this.#teamRunId];
    if (team === undefined) throw new Error(`unknown team: ${this.#teamRunId}`);
    return team;
  }
}

