import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  acquireComponentLock,
  reclaimComponentLock,
} from "@helium/core";

export type AppendCoordinationResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "lock-held" };

export interface AppendCoordination {
  run<T>(operation: () => T): AppendCoordinationResult<T>;
}

export interface FileAppendCoordinationOptions {
  directory: string;
  bootId: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

const COMPONENT_ID = "shepherd-event-store";
const COORDINATION_DIGEST = `sha256:${"a".repeat(64)}`;

export class FileAppendCoordination implements AppendCoordination {
  readonly #options: Required<Omit<FileAppendCoordinationOptions, "pid" | "isAlive" | "now">>
    & Pick<Required<FileAppendCoordinationOptions>, "pid" | "isAlive" | "now">;

  constructor(options: FileAppendCoordinationOptions) {
    this.#options = {
      ...options,
      pid: options.pid ?? process.pid,
      isAlive: options.isAlive ?? nativeProcessIsAlive,
      now: options.now ?? (() => new Date()),
    };
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  }

  run<T>(operation: () => T): AppendCoordinationResult<T> {
    reclaimComponentLock(this.#options.directory, COMPONENT_ID, {
      bootId: this.#options.bootId,
      isAlive: this.#options.isAlive,
    });
    const acquiredAt = this.#options.now();
    const acquisition = acquireComponentLock(this.#options.directory, {
      componentId: COMPONENT_ID,
      bootId: this.#options.bootId,
      pid: this.#options.pid,
      leaseId: randomUUID(),
      sopDigest: COORDINATION_DIGEST,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + 60_000).toISOString(),
    });
    if (!acquisition.ok) return { acquired: false, reason: "lock-held" };
    try {
      return { acquired: true, value: operation() };
    } finally {
      acquisition.handle.release();
    }
  }
}

function nativeProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
