import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireComponentLock } from "@helium/core";
import { FileAppendCoordination } from "./append-coordination.js";

const root = () => mkdtempSync(join(tmpdir(), "helium-shepherd-append-"));

describe("FileAppendCoordination", () => {
  it("refuses a concurrent live holder and releases after the callback", () => {
    const directory = root();
    const first = new FileAppendCoordination({ directory, bootId: "boot-test" });
    const second = new FileAppendCoordination({ directory, bootId: "boot-test" });
    const outer = first.run(() => second.run(() => "wrong"));
    expect(outer).toEqual({ acquired: true, value: { acquired: false, reason: "lock-held" } });
    expect(second.run(() => "after")).toEqual({ acquired: true, value: "after" });
  });

  it("reclaims a same-boot lock only when its holder is dead", () => {
    const directory = root();
    expect(acquireComponentLock(directory, {
      componentId: "shepherd-event-store",
      bootId: "boot-test",
      pid: 9_999_999,
      leaseId: "stale-lease",
      sopDigest: `sha256:${"a".repeat(64)}`,
      acquiredAt: "2026-08-31T01:00:00.000Z",
      expiresAt: "2026-08-31T01:00:01.000Z",
    }).ok).toBe(true);
    const coordination = new FileAppendCoordination({
      directory,
      bootId: "boot-test",
      isAlive: () => false,
    });
    expect(coordination.run(() => "recovered")).toEqual({ acquired: true, value: "recovered" });
  });

  it("lets exactly one of two real processes enter the append section", async () => {
    const module = fileURLToPath(new URL("../lib/append-coordination.js", import.meta.url));
    if (!existsSync(module)) throw new Error(`built coordination module missing: ${module}`);
    const race = (directory: string): Promise<string> => new Promise((resolve, reject) => {
      const script = `
        import { FileAppendCoordination } from ${JSON.stringify(module)};
        const result = new FileAppendCoordination({ directory: ${JSON.stringify(directory)}, bootId: "boot-race" }).run(() => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
          return "WON";
        });
        process.stdout.write(result.acquired ? result.value : "LOST");
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });

    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.all([race(root()), race(root())]);
      // Each pair above deliberately has independent roots; prove the helper is runnable.
      expect(results).toEqual(["WON", "WON"]);
    }

    for (let round = 0; round < 3; round += 1) {
      const directory = root();
      const results = await Promise.all([race(directory), race(directory)]);
      expect(results.filter((result) => result === "WON"), `round ${round}`).toHaveLength(1);
      expect(results.filter((result) => result === "LOST"), `round ${round}`).toHaveLength(1);
    }
  }, 30_000);

  it("reclaims a lock left by a SIGKILLed holder", async () => {
    const module = fileURLToPath(new URL("../lib/append-coordination.js", import.meta.url));
    const directory = root();
    const script = `
      import { FileAppendCoordination } from ${JSON.stringify(module)};
      new FileAppendCoordination({ directory: ${JSON.stringify(directory)}, bootId: "boot-sigkill" }).run(() => {
        process.stdout.write("READY\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const recovered = new FileAppendCoordination({ directory, bootId: "boot-sigkill" });
    expect(recovered.run(() => "recovered")).toEqual({ acquired: true, value: "recovered" });
  }, 10_000);
});
