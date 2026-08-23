import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployHeliumProfile, dshBin, makeDshHome } from "../src/dsh.js";

/** Resolve once `predicate()` holds, or reject after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("contract: ctx.effect interval timers run inside a booted profile", () => {
  let dshHome: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    deployHeliumProfile(dshHome);
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("fires the plugin timer and stops cleanly on SIGTERM", async () => {
    const tickFile = join(dshHome, "ticks.log");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const child = spawn(dshBin, ["--profile", "helium"], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        HELIUM_CONTRACT_TICK_FILE: tickFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    try {
      await waitFor(
        () =>
          existsSync(tickFile) &&
          readFileSync(tickFile, "utf8").trim().split("\n").length >= 2,
        60_000,
        `two ticks in ${tickFile}; stderr was:\n${stderr.join("")}`,
      );
    } finally {
      child.kill("SIGTERM");
    }

    expect(stdout.join("")).toContain("helium plugin mounted");
    expect(await exited).toBe(0);
  });
});
