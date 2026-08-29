/** Production bridge from OpsController to the OS-atomic core component lock. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  acquireComponentLock,
  reclaimComponentLock,
  type LockHandle,
} from "@helium/core";

export interface ComponentActionLockInput {
  componentId: string;
  leaseId: string;
  sopDigest: string;
  acquiredAt: string;
  expiresAt: string;
}

export type ComponentActionLockAcquisition =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "component-lock-held" };

export interface ComponentActionLockPort {
  acquire(input: ComponentActionLockInput): ComponentActionLockAcquisition;
  reconcile(componentId: string): void;
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

  reconcile(componentId: string): void {
    const result = reclaimComponentLock(this.options.dir, componentId, {
      bootId: this.options.bootId,
      isAlive: this.options.isAlive ?? processIsAlive,
    });
    if (!result.reclaimed && result.reason === "holder-alive") {
      throw new Error(`component lock is held by a live process: ${componentId}`);
    }
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
    return acquired.ok
      ? acquired
      : { ok: false, reason: "component-lock-held" };
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
