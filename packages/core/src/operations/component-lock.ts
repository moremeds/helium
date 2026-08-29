/**
 * The OS-atomic component mutation lock.
 *
 * Before any mutation the daemon takes a filesystem lock scoped to one
 * component. Atomicity comes from `link(2)`: the receipt is written to a
 * temporary file FIRST and then linked into place, and `link` fails with
 * `EEXIST` if the target exists. Creating the lock and publishing its complete
 * contents are therefore one observable step -- a crash can leave a stray
 * temporary file, never a lock whose holder is unreadable.
 *
 * `mkdir` would also be atomic, but it publishes an EMPTY directory and the
 * receipt lands afterwards. A reader arriving in between sees a held lock with
 * no owner, which is exactly the state that tempts a caller into "it's been
 * there a while, just delete it".
 *
 * RECLAMATION IS NEVER BY ELAPSED TIME ALONE. A lock is reclaimable only when
 * its holder is provably gone: a different boot, or a dead PID on this boot.
 * A long-running repair that outlives its own TTL is still running, and
 * deleting its lock is how two mutations end up on one component.
 * @module @helium/core/operations/component-lock
 */
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OpsIdSchema } from "./component.js";
import { IsoTimestampSchema } from "./observation.js";

export const LockReceiptSchema = z.strictObject({
  v: z.literal(1),
  componentId: OpsIdSchema,
  /** Identity of the running kernel. A reboot invalidates every PID below. */
  bootId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  leaseId: OpsIdSchema,
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  acquiredAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
});
export type LockReceipt = z.infer<typeof LockReceiptSchema>;

export interface LockHandle {
  receipt: LockReceipt;
  release(): void;
}

export type LockAcquisition =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "lock-held"; holder?: LockReceipt };

const lockPathFor = (dir: string, componentId: string): string =>
  join(dir, `${componentId}.lock.json`);

/** Read the current holder, or undefined when the lock is free or unreadable. */
export function readLockHolder(
  dir: string,
  componentId: string,
): LockReceipt | undefined {
  try {
    return LockReceiptSchema.parse(
      JSON.parse(readFileSync(lockPathFor(dir, componentId), "utf8")),
    );
  } catch {
    return undefined;
  }
}

export function acquireComponentLock(
  dir: string,
  input: Omit<LockReceipt, "v">,
): LockAcquisition {
  mkdirSync(dir, { recursive: true });
  const receipt = LockReceiptSchema.parse({ v: 1, ...input });
  const target = lockPathFor(dir, receipt.componentId);
  const staging = join(dir, `.${receipt.componentId}.${receipt.leaseId}.tmp`);

  writeFileSync(staging, JSON.stringify(receipt), { mode: 0o600 });
  try {
    // Atomic publish. Fails with EEXIST if another holder got here first.
    linkSync(staging, target);
  } catch {
    rmSync(staging, { force: true });
    return {
      ok: false,
      reason: "lock-held",
      ...(readLockHolder(dir, receipt.componentId) === undefined
        ? {}
        : { holder: readLockHolder(dir, receipt.componentId) }),
    };
  }
  rmSync(staging, { force: true });

  return {
    ok: true,
    handle: {
      receipt,
      release(): void {
        const holder = readLockHolder(dir, receipt.componentId);
        // Release only our own lock. Releasing someone else's is how a slow
        // controller unlocks a component another one is actively mutating.
        if (holder?.leaseId !== receipt.leaseId) return;
        rmSync(target, { force: true });
      },
    },
  };
}

export interface HolderProbe {
  /** Identity of the CURRENT boot. */
  bootId: string;
  /** Whether a pid is alive on this boot. */
  isAlive: (pid: number) => boolean;
}

export type Reclamation =
  | { reclaimed: true; reason: "stale-boot" | "dead-process" | "no-holder" }
  | { reclaimed: false; reason: "holder-alive" | "lock-free" };

/**
 * Reclaim a lock whose holder is provably gone.
 *
 * Elapsed time is deliberately NOT a reason. An expired lock whose owner is
 * still running is still a lock: the repair is slow, not absent, and taking
 * the lock from it puts two mutations on one component.
 */
export function reclaimComponentLock(
  dir: string,
  componentId: string,
  probe: HolderProbe,
): Reclamation {
  const target = lockPathFor(dir, componentId);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return { reclaimed: false, reason: "lock-free" };
  }

  let holder: LockReceipt;
  try {
    holder = LockReceiptSchema.parse(JSON.parse(raw));
  } catch {
    // A lock file that is not a readable receipt names no owner to reconcile
    // against, so it cannot be shown alive.
    rmSync(target, { force: true });
    return { reclaimed: true, reason: "no-holder" };
  }

  if (holder.bootId !== probe.bootId) {
    rmSync(target, { force: true });
    return { reclaimed: true, reason: "stale-boot" };
  }
  if (!probe.isAlive(holder.pid)) {
    rmSync(target, { force: true });
    return { reclaimed: true, reason: "dead-process" };
  }
  return { reclaimed: false, reason: "holder-alive" };
}
