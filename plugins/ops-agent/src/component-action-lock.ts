/** Production bridge from OpsController to the OS-atomic core component lock. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  acquireComponentLock,
  reclaimComponentLock,
  type LockHandle,
  type LockReceipt,
} from "@helium/core";

export interface ComponentActionLockInput {
  componentId: string;
  leaseId: string;
  sopDigest: string;
  acquiredAt: string;
  expiresAt: string;
}

export type ComponentActionLockAcquisition =
  | { ok: true; handle: ComponentActionLockHandle }
  | { ok: false; reason: "component-lock-held" };

export interface ComponentActionLockHandle extends LockHandle {
  /**
   * Release only when the detached writer process group is completely gone.
   * A killed wrapper can leave its mutating descendant alive after Node has
   * already received a child `close` event.
   */
  releaseIfProcessGroupDead(): "released" | "holder-alive";
}

export interface ComponentActionLockPort {
  acquire(input: ComponentActionLockInput): ComponentActionLockAcquisition;
  reconcile(componentId: string): "clear" | "holder-alive";
}

export class FileComponentActionLocks implements ComponentActionLockPort {
  constructor(
    private readonly options: {
      dir: string;
      bootId: string;
      pid?: number;
      isAlive?: (pid: number) => boolean;
    },
  ) {}

  reconcile(componentId: string): "clear" | "holder-alive" {
    const result = reclaimComponentLock(this.options.dir, componentId, {
      bootId: this.options.bootId,
      isAlive: this.options.isAlive ?? processIsAlive,
    });
    if (!result.reclaimed && result.reason === "holder-alive") {
      return "holder-alive";
    }
    return "clear";
  }

  acquire(input: ComponentActionLockInput): ComponentActionLockAcquisition {
    const acquired = acquireComponentLock(this.options.dir, {
      componentId: input.componentId,
      bootId: this.options.bootId,
      pid: this.options.pid ?? process.pid,
      leaseId: input.leaseId,
      sopDigest: input.sopDigest,
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
    });
    if (!acquired.ok) return { ok: false, reason: "component-lock-held" };
    const handle = acquired.handle;
    let adoptedPid: number | undefined;
    const isAlive = this.options.isAlive ?? processIsAlive;
    return {
      ok: true,
      handle: {
        get receipt(): LockReceipt { return handle.receipt; },
        adopt(pid: number): void {
          handle.adopt(pid);
          adoptedPid = pid;
        },
        release(): void {
          handle.release();
        },
        releaseIfProcessGroupDead(): "released" | "holder-alive" {
          if (adoptedPid !== undefined && isAlive(adoptedPid)) return "holder-alive";
          handle.release();
          return "released";
        },
      },
    };
  }
}

export function hostBootId(): string {
  let identity: string;
  if (process.platform === "darwin") {
    identity = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
  } else if (process.platform === "linux") {
    identity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } else {
    throw new Error(`cannot determine boot identity on ${process.platform}`);
  }
  if (identity === "") throw new Error("host boot identity is empty");
  return `boot-${createHash("sha256").update(identity).digest("hex")}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
  }
  // ScriptExecutor starts each mutation as a detached process-group leader.
  // The adopted leader can be killed while one of its writer/watchdog
  // descendants is still alive.  In that state the positive PID is gone but
  // the process group still exists; treating the lock as dead would admit a
  // second writer.  A negative pid probes that complete group on POSIX.
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
