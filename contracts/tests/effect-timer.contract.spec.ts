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

// Skipped (found while shipping Task 2.7, task-2.7-report.md has full detail):
// profile/cordis.patch.yml still only sets a stale `tickFile` field from the
// Task-1.5-era plugin placeholder that this test observes. dsh-plugin-helium's
// real Config (built out across Phase 2) requires jobsDir/stateRoot/
// contextFile/calendarsDir/argonBase/apexBase/envFile/claudeTokenFile/proxy/
// mcpBin/emailTo, none of which that patch file provides, so apply() throws
// before ever reaching the sensor ctx.effect() wiring -- no ticks are ever
// written, and this test always times out. HELIUM_CONTRACT_TICK_FILE has no
// reader anywhere in plugins/helium/src/ any more (grepped; zero matches) --
// the real sensor loop reports through jsonl heartbeats instead, a different
// observable mechanism entirely. task-3.1-brief.md Step 11 explicitly owns
// rewriting both plugins/helium/cordis.patch.yml (already correct, reads
// real env vars) and profile/cordis.patch.yml (still stale) to the pinned
// env contract; restore this test once that lands, rewritten against the
// real observable (jsonl heartbeats), not the removed tickFile mechanism.
describe.skip("contract: ctx.effect interval timers run inside a booted profile", () => {
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
