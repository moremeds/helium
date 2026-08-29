import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  acquireComponentLock,
  readLockHolder,
  reclaimComponentLock,
  type LockReceipt,
} from "../src/operations/component-lock.js";

const dir = () => mkdtempSync(join(tmpdir(), "helium-ops-lock-"));
const digest = `sha256:${"a".repeat(64)}`;

const receipt = (overrides: Partial<LockReceipt> = {}): Omit<LockReceipt, "v"> => ({
  componentId: "runtime",
  bootId: "boot-1",
  pid: process.pid,
  leaseId: "lease-1",
  sopDigest: digest,
  acquiredAt: "2026-08-25T04:00:00.000Z",
  expiresAt: "2026-08-25T04:10:00.000Z",
  ...overrides,
});

describe("component lock", () => {
  it("admits the first holder and refuses the second", () => {
    const d = dir();
    expect(acquireComponentLock(d, receipt()).ok).toBe(true);
    const second = acquireComponentLock(d, receipt({ leaseId: "lease-2" }));
    expect(second.ok).toBe(false);
    expect(second).toMatchObject({ reason: "lock-held" });
  });

  it("publishes a complete receipt, never an empty lock", () => {
    const d = dir();
    acquireComponentLock(d, receipt());
    expect(readLockHolder(d, "runtime")).toMatchObject({
      leaseId: "lease-1",
      pid: process.pid,
      bootId: "boot-1",
      sopDigest: digest,
    });
  });

  it("locks per component, not globally", () => {
    const d = dir();
    expect(acquireComponentLock(d, receipt()).ok).toBe(true);
    expect(
      acquireComponentLock(d, receipt({ componentId: "database", leaseId: "l2" })).ok,
    ).toBe(true);
  });

  it("releases only its own lock", () => {
    const d = dir();
    const first = acquireComponentLock(d, receipt());
    if (!first.ok) throw new Error("expected the first acquire to win");

    // A second controller's handle must not be able to unlock the first.
    const impostor = acquireComponentLock(d, receipt({ leaseId: "lease-2" }));
    expect(impostor.ok).toBe(false);

    first.handle.release();
    expect(readLockHolder(d, "runtime")).toBeUndefined();
    expect(acquireComponentLock(d, receipt({ leaseId: "lease-3" })).ok).toBe(true);
  });

  it("leaves no staging file behind, on either path", () => {
    const d = dir();
    acquireComponentLock(d, receipt());
    acquireComponentLock(d, receipt({ leaseId: "lease-2" }));
    const strays = execFileSync("ls", ["-a", d], { encoding: "utf8" })
      .split("\n")
      .filter((n) => n.endsWith(".tmp"));
    expect(strays).toEqual([]);
  });
});

describe("reclamation", () => {
  const alive = { bootId: "boot-1", isAlive: () => true };
  const dead = { bootId: "boot-1", isAlive: () => false };

  // The rule this whole module is shaped around.
  it("refuses to reclaim a live holder, however old the lock is", () => {
    const d = dir();
    acquireComponentLock(
      d,
      receipt({ expiresAt: "2026-08-25T04:00:01.000Z" }),
    );
    expect(reclaimComponentLock(d, "runtime", alive)).toEqual({
      reclaimed: false,
      reason: "holder-alive",
    });
    expect(readLockHolder(d, "runtime")).toBeDefined();
  });

  it("reclaims after a reboot", () => {
    const d = dir();
    acquireComponentLock(d, receipt());
    expect(reclaimComponentLock(d, "runtime", { ...alive, bootId: "boot-2" })).toEqual({
      reclaimed: true,
      reason: "stale-boot",
    });
    expect(readLockHolder(d, "runtime")).toBeUndefined();
  });

  it("reclaims a dead process on the same boot", () => {
    const d = dir();
    acquireComponentLock(d, receipt());
    expect(reclaimComponentLock(d, "runtime", dead)).toEqual({
      reclaimed: true,
      reason: "dead-process",
    });
  });

  it("reports a free lock as free rather than reclaimed", () => {
    expect(reclaimComponentLock(dir(), "runtime", alive)).toEqual({
      reclaimed: false,
      reason: "lock-free",
    });
  });

  it("reclaims a lock file that names no readable holder", () => {
    const d = dir();
    acquireComponentLock(d, receipt());
    writeFileSync(join(d, "runtime.lock.json"), "{not json");
    expect(reclaimComponentLock(d, "runtime", alive)).toEqual({
      reclaimed: true,
      reason: "no-holder",
    });
  });
});

describe("two real processes", () => {
  // The in-process tests above share one filesystem view and one event loop.
  // These children are independent OS processes started CONCURRENTLY and
  // racing for the same lock file, which is the only way to show the
  // atomicity belongs to the OS rather than to single-threaded JavaScript.
  // Run several rounds so a genuine collision is likely rather than hoped for.
  it("lets exactly one of two concurrent child processes take the lock", async () => {
    const module = fileURLToPath(
      new URL("../lib/operations/component-lock.js", import.meta.url),
    );
    if (!existsSync(module)) {
      throw new Error(
        `built lock module missing at ${module}; run pnpm build before this suite`,
      );
    }

    const race = (lockDir: string, leaseId: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const script =
          `import { acquireComponentLock } from ${JSON.stringify(module)};` +
          `const r = acquireComponentLock(${JSON.stringify(lockDir)}, {` +
          `componentId: "runtime", bootId: "boot-1", pid: process.pid,` +
          `leaseId: ${JSON.stringify(leaseId)}, sopDigest: ${JSON.stringify(digest)},` +
          `acquiredAt: "2026-08-25T04:00:00.000Z", expiresAt: "2026-08-25T04:10:00.000Z"});` +
          `process.stdout.write(r.ok ? "WON" : "LOST");`;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.on("error", reject);
        child.on("close", () => {
          resolve(out);
        });
      });

    for (let round = 0; round < 5; round += 1) {
      const d = dir();
      // Started together, not one after the other: a sequential pair proves
      // only that a second acquire fails, which the in-process test covers.
      const results = await Promise.all([race(d, "child-a"), race(d, "child-b")]);
      expect(results.filter((r) => r === "WON"), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => r === "LOST"), `round ${round}`).toHaveLength(1);
      expect(readLockHolder(d, "runtime")).toBeDefined();
    }
  }, 30_000);
});
