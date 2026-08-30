/** Immutable, event-backed artifact publication and dependency handoff. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ArtifactProjection, TeamRunProjection } from "./reducer.js";
import type { TeamStore } from "./store.js";

export interface ArtifactInput {
  taskId: string;
  ref: string;
  hash: string;
  content: string | Uint8Array;
}

export interface ArtifactRegistryOptions {
  now?: () => string;
  eventId?: () => string;
  sync?: (fd: number) => void;
}

export class ArtifactRegistry {
  readonly #store: TeamStore;
  readonly #teamRunId: string;
  readonly #now: () => string;
  readonly #eventId: () => string;
  readonly #sync: (fd: number) => void;

  constructor(store: TeamStore, teamRunId: string, options: ArtifactRegistryOptions = {}) {
    this.#store = store;
    this.#teamRunId = teamRunId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventId ?? (() => `artifact-${randomUUID()}`);
    this.#sync = options.sync ?? fsyncSync;
    this.#team();
  }

  publish(input: ArtifactInput): ArtifactProjection {
    const team = this.#team();
    if (team.tasks[input.taskId] === undefined) throw new Error(`unknown task: ${input.taskId}`);
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content);
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualHash !== input.hash) {
      throw new Error(`artifact content hash mismatch: declared ${input.hash}, actual ${actualHash}`);
    }
    const existing = team.artifacts[input.ref];
    if (existing !== undefined) {
      if (existing.hash !== input.hash || existing.taskId !== input.taskId) {
        throw new Error(`immutable artifact conflict: ${input.ref}`);
      }
      this.#verifyStored(existing.hash);
      return existing;
    }
    this.#persist(input.hash, content);
    this.#store.append({
      version: 1,
      eventId: this.#eventId(),
      at: this.#now(),
      caseId: team.caseId,
      teamRunId: team.teamRunId,
      type: "artifact/published",
      payload: { taskId: input.taskId, ref: input.ref, hash: input.hash },
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

  read(ref: string): Buffer {
    const artifact = this.#team().artifacts[ref];
    if (artifact === undefined) throw new Error(`unknown artifact: ${ref}`);
    return this.#verifyStored(artifact.hash);
  }

  #path(hash: string): string {
    return join(this.#store.artifactRoot, hash.slice("sha256:".length));
  }

  #verifyStored(hash: string): Buffer {
    const content = readFileSync(this.#path(hash));
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualHash !== hash) {
      throw new Error(`artifact content hash mismatch: declared ${hash}, actual ${actualHash}`);
    }
    return content;
  }

  #persist(hash: string, content: Buffer): void {
    const destination = this.#path(hash);
    if (existsSync(destination)) {
      this.#verifyStored(hash);
      return;
    }
    const temporary = join(
      this.#store.artifactRoot,
      `.${hash.slice("sha256:".length)}.${randomUUID()}.tmp`,
    );
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      this.#sync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, destination);
      const dirFd = openSync(this.#store.artifactRoot, "r");
      try {
        this.#sync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.#verifyStored(hash);
    } finally {
      unlinkSync(temporary);
    }
  }

  #team(): TeamRunProjection {
    const team = this.#store.load().teams[this.#teamRunId];
    if (team === undefined) throw new Error(`unknown team: ${this.#teamRunId}`);
    return team;
  }
}
