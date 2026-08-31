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
import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  readonly receipt: LockReceipt;
  /** Atomically transfer liveness ownership to the spawned mutation process. */
  adopt(pid: number): void;
  release(): void;
}

export type LockAcquisition =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "lock-held"; holder?: LockReceipt };

const lockPathFor = (dir: string, componentId: string): string =>
  join(dir, `${componentId}.lock.json`);

const CoordinationReceiptSchema = z.strictObject({
  v: z.literal(1),
  componentId: OpsIdSchema,
  bootId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  requestId: z.string().uuid(),
  ticket: z.number().int().positive().optional(),
});
type CoordinationReceipt = z.infer<typeof CoordinationReceiptSchema>;

const coordinationDirFor = (dir: string, componentId: string): string =>
  join(dir, ".component-lock-coordination", componentId);

const coordinationSleep = new Int32Array(new SharedArrayBuffer(4));

function nativeProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function publishCoordinationReceipt(path: string, receipt: CoordinationReceipt): void {
  const staging = `${path}.${receipt.requestId}.tmp`;
  writeFileSync(staging, JSON.stringify(receipt), { mode: 0o600 });
  try {
    linkSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

function readCoordinationReceipt(path: string): CoordinationReceipt | undefined {
  try {
    return CoordinationReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`invalid component-lock coordination receipt: ${path}`, {
      cause: error,
    });
  }
}

function activeCoordinator(receipt: CoordinationReceipt, bootId: string): boolean {
  return receipt.bootId === bootId && nativeProcessIsAlive(receipt.pid);
}

/**
 * Serialize every mutation of one component-lock pathname across processes.
 *
 * This is Lamport's bakery protocol expressed with atomically published files:
 * a process first publishes that it is choosing, then publishes a monotonically
 * ordered ticket, then waits for every live earlier ticket. A process arriving
 * after another has entered can never choose an earlier ticket; a process that
 * was already choosing is visible before the entrant decides it is first.
 * Crashed participants are ignored by boot identity plus PID liveness, and no
 * participant ever removes another participant's receipt.
 *
 * The coordination layer is necessary even though acquisition itself uses an
 * atomic hard link. POSIX has no "unlink this pathname only if it still names
 * the inode I read" operation: without serialization, a delayed stale-lock
 * reclaimer can unlink a replacement live lock.
 */
function withComponentLockCoordination<T>(
  dir: string,
  componentIdInput: string,
  bootId: string,
  pid: number,
  operation: () => T,
): T {
  const componentId = OpsIdSchema.parse(componentIdInput);
  const coordinationDir = coordinationDirFor(dir, componentId);
  mkdirSync(coordinationDir, { recursive: true, mode: 0o700 });
  const requestId = randomUUID();
  const base = { v: 1 as const, componentId, bootId, pid, requestId };
  const choosingPath = join(coordinationDir, `${requestId}.choosing.json`);
  publishCoordinationReceipt(choosingPath, base);

  let ticketPath: string | undefined;
  try {
    let maximum = 0;
    for (const name of readdirSync(coordinationDir)) {
      if (!name.endsWith(".ticket.json")) continue;
      const receipt = readCoordinationReceipt(join(coordinationDir, name));
      if (receipt?.ticket !== undefined) maximum = Math.max(maximum, receipt.ticket);
    }
    if (maximum >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`component-lock coordination ticket space exhausted: ${componentId}`);
    }
    const ticket = maximum + 1;
    ticketPath = join(coordinationDir, `${requestId}.ticket.json`);
    publishCoordinationReceipt(ticketPath, { ...base, ticket });
    rmSync(choosingPath, { force: true });

    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    for (;;) {
      let blocked = false;
      for (const name of readdirSync(coordinationDir)) {
        if (!name.endsWith(".choosing.json")) continue;
        const other = readCoordinationReceipt(join(coordinationDir, name));
        if (other !== undefined && other.requestId !== requestId &&
            activeCoordinator(other, bootId)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        for (const name of readdirSync(coordinationDir)) {
          if (!name.endsWith(".ticket.json")) continue;
          const other = readCoordinationReceipt(join(coordinationDir, name));
          if (other === undefined || other.requestId === requestId ||
              other.ticket === undefined || !activeCoordinator(other, bootId)) {
            continue;
          }
          if (other.ticket < ticket ||
              (other.ticket === ticket && other.requestId < requestId)) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) return operation();
      if (process.hrtime.bigint() >= deadline) {
        throw new Error(`timed out coordinating component lock: ${componentId}`);
      }
      Atomics.wait(coordinationSleep, 0, 0, 10);
    }
  } finally {
    rmSync(choosingPath, { force: true });
    if (ticketPath !== undefined) rmSync(ticketPath, { force: true });
  }
}

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
  return withComponentLockCoordination(
    dir,
    receipt.componentId,
    receipt.bootId,
    receipt.pid,
    () => {
      const target = lockPathFor(dir, receipt.componentId);
      const staging = join(dir, `.${receipt.componentId}.${receipt.leaseId}.tmp`);

      writeFileSync(staging, JSON.stringify(receipt), { mode: 0o600 });
      try {
        // Atomic publish. Fails with EEXIST if another holder got here first.
        linkSync(staging, target);
      } catch {
        rmSync(staging, { force: true });
        const holder = readLockHolder(dir, receipt.componentId);
        return {
          ok: false as const,
          reason: "lock-held" as const,
          ...(holder === undefined ? {} : { holder }),
        };
      }
      rmSync(staging, { force: true });

      let currentReceipt = receipt;
      return {
        ok: true as const,
        handle: {
          get receipt(): LockReceipt {
            return currentReceipt;
          },
          adopt(pid: number): void {
            const next = LockReceiptSchema.parse({ ...currentReceipt, pid });
            withComponentLockCoordination(
              dir,
              currentReceipt.componentId,
              currentReceipt.bootId,
              process.pid,
              () => {
                const holder = readLockHolder(dir, currentReceipt.componentId);
                if (holder?.leaseId !== currentReceipt.leaseId) {
                  throw new Error(`component lock changed before child adoption: ${currentReceipt.componentId}`);
                }
                const staging = join(
                  dir,
                  `.${currentReceipt.componentId}.${currentReceipt.leaseId}.${randomUUID()}.adopt.tmp`,
                );
                writeFileSync(staging, JSON.stringify(next), { mode: 0o600 });
                try {
                  renameSync(staging, target);
                  currentReceipt = next;
                } finally {
                  rmSync(staging, { force: true });
                }
              },
            );
          },
          release(): void {
            withComponentLockCoordination(
              dir,
              currentReceipt.componentId,
              currentReceipt.bootId,
              process.pid,
              () => {
                const holder = readLockHolder(dir, currentReceipt.componentId);
                // Release only our own lock. Releasing someone else's is how a slow
                // controller unlocks a component another one is actively mutating.
                if (holder?.leaseId !== currentReceipt.leaseId) return;
                rmSync(target, { force: true });
              },
            );
          },
        },
      };
    },
  );
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
  return withComponentLockCoordination(
    dir,
    componentId,
    probe.bootId,
    process.pid,
    () => {
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
    },
  );
}
