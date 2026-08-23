import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Re-enabled per task-3.1-brief.md Step 11 (carried in from task-2.7-report.md):
 * `profile/cordis.patch.yml` now carries the same pinned env contract as
 * `plugins/helium/cordis.patch.yml` instead of the stale Task-1.5-era
 * `tickFile` field, so `apply()` receives a real `Config` and the runtime's
 * per-job sensor loop actually starts. `HELIUM_CONTRACT_TICK_FILE` was
 * dropped along with that placeholder mechanism (no reader anywhere in
 * plugins/helium/src/ — grepped, zero matches); this contract now observes
 * the real mechanism instead, the `heartbeat` JSONL stream `HeliumRuntime`
 * appends to every sensor cycle (spec §8).
 */
describe("contract: ctx.effect interval timers run inside a booted profile", () => {
  let dshHome: string;
  let stateRoot: string;
  let jobsDir: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    deployHeliumProfile(dshHome);

    stateRoot = join(dshHome, "helium-state");
    jobsDir = join(dshHome, "helium-jobs");
    mkdirSync(jobsDir, { recursive: true });
    mkdirSync(join(dshHome, "helium-calendars"), { recursive: true });
    writeFileSync(
      join(dshHome, "ecosystem.md"),
      "# ecosystem\ncontract fixture\n",
      "utf8",
    );
    // A single fast state-change trigger against an address nothing listens
    // on: StateChangePoller reports "unknown" and the runtime still writes a
    // heartbeat row every cycle regardless of poll outcome (spec §8) — no
    // live network dependency, no live LLM call.
    writeFileSync(
      join(jobsDir, "contract.yaml"),
      [
        "name: contract-watch",
        "enabled: true",
        "triggers:",
        "  - kind: state-change",
        "    url: http://127.0.0.1:1/api/snapshot",
        "    fields: [state]",
        "    interval: 500ms",
        "engine:",
        "  triage: { engine: deepseek, model: deepseek-v4-flash }",
        "  senior: { engine: claude-max }",
        "escalate_when: severity >= material",
        "session: fresh",
        "memory: none",
        "tools: []",
        "max_turns: { triage: 2, senior: 2 }",
        "timeout: 60s",
        "budget: { max_triage_per_hour: 60, max_senior_per_day: 60 }",
        "delivery:",
        "  jsonl: true",
        "prompt: contract fixture job",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("starts the per-job sensor loop and stops cleanly on SIGTERM", async () => {
    const heartbeatFile = (): string =>
      join(
        stateRoot,
        "jsonl",
        `heartbeat-${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
    const rowCount = (): number => {
      if (!existsSync(heartbeatFile())) return 0;
      return readFileSync(heartbeatFile(), "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "").length;
    };

    const stderr: string[] = [];
    const stdout: string[] = [];
    const child = spawn(dshBin, ["--profile", "helium"], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        HELIUM_JOBS_DIR: jobsDir,
        HELIUM_STATE_ROOT: stateRoot,
        HELIUM_CONTEXT_FILE: join(dshHome, "ecosystem.md"),
        HELIUM_CALENDARS_DIR: join(dshHome, "helium-calendars"),
        HELIUM_ARGON_BASE: "http://127.0.0.1:1",
        HELIUM_APEX_BASE: "http://127.0.0.1:1",
        HELIUM_ENV_FILE: join(dshHome, "helium.env"),
        HELIUM_CLAUDE_TOKEN_FILE: join(dshHome, "claude-token.env"),
        HELIUM_PROXY: "",
        HELIUM_MCP_BIN: "true",
        HELIUM_EMAIL_TO: "contract@example.invalid",
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
        () => rowCount() >= 2,
        60_000,
        `two heartbeat rows in ${heartbeatFile()}; stdout was:\n${stdout.join("")}\nstderr was:\n${stderr.join("")}`,
      );
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
  });
});
