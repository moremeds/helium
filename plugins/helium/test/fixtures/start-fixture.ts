/**
 * Spawns `scripts/fixtures/argon-fixture.mjs` against a fresh state file and
 * resolves once it prints its bound port. Used by the local E2E harness
 * (Task 3.1) — the same mechanism Task 3.7's AC#3 mini drill reuses.
 * @module dsh-plugin-helium/test/fixtures/start-fixture
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/fixtures/argon-fixture.mjs", import.meta.url),
);

export interface ArgonFixture {
  /** The fixture server's base URL, e.g. `http://127.0.0.1:54321`. */
  base: string;
  /** Replace the fixture's current JSON state. */
  set(body: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function startFixture(
  root: string,
  initial: unknown,
): Promise<ArgonFixture> {
  const statePath = join(root, "fixture-state.json");
  writeFileSync(statePath, JSON.stringify(initial), "utf8");

  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, FIXTURE_STATE: statePath, FIXTURE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      child.stdout.off("data", onData);
      try {
        resolve((JSON.parse(buf.slice(0, nl)) as { port: number }).port);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async set(body: unknown): Promise<void> {
      const res = await fetch(`${base}/__set`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`argon fixture /__set failed: HTTP ${res.status}`);
      }
    },
    async close(): Promise<void> {
      child.kill("SIGTERM");
    },
  };
}
