import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("atomically transfers liveness ownership to the spawned writer", () => {
    const d = dir();
    const acquired = acquireComponentLock(d, receipt());
    if (!acquired.ok) throw new Error("expected lock acquisition");
    acquired.handle.adopt(process.pid + 1);
    expect(acquired.handle.receipt.pid).toBe(process.pid + 1);
    expect(readLockHolder(d, "runtime")?.pid).toBe(process.pid + 1);
    acquired.handle.release();
    expect(readLockHolder(d, "runtime")).toBeUndefined();
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

  it("does not let a delayed stale reclaimer delete a replacement live lock", async () => {
    const module = fileURLToPath(
      new URL("../lib/operations/component-lock.js", import.meta.url),
    );
    if (!existsSync(module)) {
      throw new Error(
        `built lock module missing at ${module}; run pnpm build before this suite`,
      );
    }

    const d = dir();
    const stalePid = 9_999_999;
    expect(acquireComponentLock(d, receipt({ pid: stalePid })).ok).toBe(true);
    const waitFor = async (path: string, timeoutMs = 5_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const child = (label: "a" | "b") => {
      const ready = join(d, `ready-${label}`);
      const proceed = join(d, `proceed-${label}`);
      const started = join(d, `started-${label}`);
      const result = join(d, `result-${label}.json`);
      const release = join(d, `release-${label}`);
      const script = `
        import { existsSync, writeFileSync } from "node:fs";
        import { acquireComponentLock, reclaimComponentLock } from ${JSON.stringify(module)};
        const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        writeFileSync(${JSON.stringify(started)}, "");
        const reclaimed = reclaimComponentLock(${JSON.stringify(d)}, "runtime", {
          bootId: "boot-1",
          isAlive(pid) {
            if (pid !== ${stalePid}) {
              try { process.kill(pid, 0); return true; }
              catch (error) { return error?.code === "EPERM"; }
            }
            writeFileSync(${JSON.stringify(ready)}, "");
            while (!existsSync(${JSON.stringify(proceed)})) sleep();
            return false;
          },
        });
        const acquired = acquireComponentLock(${JSON.stringify(d)}, {
          componentId: "runtime", bootId: "boot-1", pid: process.pid,
          leaseId: ${JSON.stringify(`lease-${label}`)}, sopDigest: ${JSON.stringify(digest)},
          acquiredAt: "2026-08-25T04:00:00.000Z", expiresAt: "2026-08-25T04:10:00.000Z",
        });
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({ reclaimed, acquired: acquired.ok }));
        if (acquired.ok) while (!existsSync(${JSON.stringify(release)})) sleep();
      `;
      const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const done = new Promise<void>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", (code) => {
          code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${stderr}`));
        });
      });
      return { ready, proceed, started, result, release, done };
    };

    const a = child("a");
    await waitFor(a.ready);
    const b = child("b");
    await waitFor(b.started);
    // Give B time to reach the same stale-holder probe. A safe coordinator
    // keeps it outside; the old read-then-unlink implementation lets it in.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const bReadTheStaleReceipt = existsSync(b.ready);
    writeFileSync(a.proceed, "");
    if (bReadTheStaleReceipt) {
      // Reproduce the dangerous ordering exactly: A replaces the stale lock,
      // then the already-delayed B resumes its deletion.
      await waitFor(a.result);
      writeFileSync(b.proceed, "");
    }
    await Promise.all([waitFor(a.result), waitFor(b.result)]);
    const results = [a, b].map(({ result }) =>
      JSON.parse(readFileSync(result, "utf8")) as { acquired: boolean });
    expect(results.filter(({ acquired }) => acquired)).toHaveLength(1);
    expect(readLockHolder(d, "runtime")).toBeDefined();
    writeFileSync(a.release, "");
    writeFileSync(b.release, "");
    await Promise.all([a.done, b.done]);
  }, 30_000);

  it("ignores a coordination ticket left by a process killed in its critical section", async () => {
    const module = fileURLToPath(
      new URL("../lib/operations/component-lock.js", import.meta.url),
    );
    if (!existsSync(module)) {
      throw new Error(
        `built lock module missing at ${module}; run pnpm build before this suite`,
      );
    }

    const d = dir();
    const stalePid = 9_999_998;
    expect(acquireComponentLock(d, receipt({ pid: stalePid })).ok).toBe(true);
    const ready = join(d, "crash-ready");
    const script = `
      import { writeFileSync } from "node:fs";
      import { reclaimComponentLock } from ${JSON.stringify(module)};
      reclaimComponentLock(${JSON.stringify(d)}, "runtime", {
        bootId: "boot-1",
        isAlive(pid) {
          if (pid !== ${stalePid}) return true;
          writeFileSync(${JSON.stringify(ready)}, "");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return false;
        },
      });
    `;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("child never entered coordination");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    proc.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", () => resolve());
    });

    expect(reclaimComponentLock(d, "runtime", {
      bootId: "boot-1",
      isAlive: () => false,
    })).toEqual({ reclaimed: true, reason: "dead-process" });
    expect(acquireComponentLock(d, receipt({ leaseId: "after-crash" })).ok).toBe(true);
  }, 30_000);
});
