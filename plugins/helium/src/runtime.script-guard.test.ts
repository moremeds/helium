/**
 * Deterministic coverage for HeliumRuntime's per-job script-overlap guard
 * (Task 3.6). runtime.test.ts's original version of this test drove the
 * overlap with real wall-clock timing (a sleeping fake shell script racing
 * a real HTTP fixture's poll interval) and was controller-characterized at
 * ~1 failure in 4 runs (fix round 1). This version controls every source
 * of nondeterminism instead:
 *  - `./script.js` is mocked, so no real process ever spawns — the test
 *    itself decides exactly when the "in flight" run resolves, via a
 *    promise it holds open and releases on command.
 *  - Fake timers replace scheduleLoop's real setTimeout, so every poll
 *    cycle happens on `vi.advanceTimersByTimeAsync()`, not a wall clock.
 *  - A synchronous-resolving `fetchImpl` (returning an incrementing body
 *    each call, so the state-change sensor sees "changed" every cycle)
 *    replaces the real HTTP fixture.
 * With all three controlled, the assertion that the guard skips a trigger
 * while a run is in flight has zero dependence on real elapsed time.
 * @module dsh-plugin-helium/runtime.script-guard.test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult } from "./dispatch.js";
import { HeliumRuntime, type RuntimeDeps } from "./runtime.js";
import type { ScriptResult } from "./script.js";

vi.mock("./script.js", () => ({ runScriptProcess: vi.fn() }));
// Imported AFTER vi.mock so it resolves to the mocked export (vi.mock calls
// are hoisted above imports by vitest's transform either way, but importing
// here keeps the intent readable).
const { runScriptProcess } = await import("./script.js");
const mockedRunScriptProcess = vi.mocked(runScriptProcess);

const JOB_YAML = `
name: dsh-canary
enabled: true
triggers:
  - kind: state-change
    url: http://mock.invalid/registry
    fields: [versions]
    interval: 1000ms
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: none
tools: []
max_turns: { triage: 1, senior: 1 }
timeout: 60s
budget: { max_triage_per_hour: 60, max_senior_per_day: 60 }
script:
  command: /bin/true
  args: []
  timeout: 60s
delivery:
  jsonl: true
prompt: unit fixture job
`;

function rig() {
  const root = mkdtempSync(join(tmpdir(), "helium-script-guard-"));
  const jobsDir = join(root, "jobs");
  const calendarsDir = join(root, "calendars");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(calendarsDir, { recursive: true });
  writeFileSync(join(jobsDir, "job.yaml"), JOB_YAML, "utf8");
  writeFileSync(join(root, "ecosystem.md"), "# ctx\n", "utf8");

  // Every call returns a different body, so the state-change sensor sees
  // "changed" on every poll after the first (baseline) one — deterministic,
  // no real network involved.
  let n = 0;
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ versions: { v: (n += 1) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const delivered: DispatchResult[] = [];
  const deps: RuntimeDeps = {
    config: {
      jobsDir,
      stateRoot: join(root, "state"),
      contextFile: join(root, "ecosystem.md"),
      calendarsDir,
      argonBase: "http://127.0.0.1:1",
      apexBase: "http://127.0.0.1:1",
      envFile: join(root, "helium.env"),
      claudeTokenFile: join(root, "token.env"),
      proxy: "",
      mcpBin: "",
      emailTo: "unit@example.invalid",
    },
    engines: {
      triage: {
        dispatch: async () => ({ outcome: "run_completed" as const }),
      },
      senior: {
        dispatch: async () => ({ outcome: "run_completed" as const }),
      },
    },
    delivery: {
      deliver: (_job, _ev, result) => {
        delivered.push(result);
      },
      budgetExhausted: () => {},
      heartbeat: () => {},
    },
    fetchImpl,
  };
  return { deps, delivered };
}

describe("HeliumRuntime script overlap guard (deterministic)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRunScriptProcess.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run overlapping script instances for the same job — a trigger while one is in flight is skipped", async () => {
    let releaseFirst!: (result: ScriptResult) => void;
    const firstRunGate = new Promise<ScriptResult>((resolve) => {
      releaseFirst = resolve;
    });
    mockedRunScriptProcess.mockImplementationOnce(() => firstRunGate);

    const { deps, delivered } = rig();
    const rt = new HeliumRuntime(deps);
    rt.start();

    // scheduleLoop's cycle() fires its first run() synchronously on
    // start() — flush that microtask chain before advancing real time.
    // Tick 1 is the sensor's baseline: no onTrigger, no script call.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedRunScriptProcess).not.toHaveBeenCalled();

    // Tick 2: the fixture body changed -> onTrigger fires -> runScript
    // starts, calling the mocked runScriptProcess exactly once. It hangs
    // on firstRunGate — deterministically "in flight" until this test
    // resolves it below.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedRunScriptProcess).toHaveBeenCalledTimes(1);
    expect(delivered.length).toBe(0);

    // Ticks 3-7: the body keeps changing every cycle, so onTrigger fires
    // again and again while the first run is still held open. None of
    // these may start a second instance — this is the actual guard
    // assertion, and every one of these advances is deterministic (no
    // real setTimeout, no real process, no real HTTP round trip).
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(mockedRunScriptProcess).toHaveBeenCalledTimes(1);
    expect(delivered.length).toBe(0);

    // Release the (only) in-flight run and let it deliver.
    releaseFirst({ ok: true, timedOut: false, code: 0, analysis: "done" });
    await vi.waitFor(() => {
      expect(delivered.length).toBe(1);
    });

    rt.stop();

    // The guard released after the first run finished — one more advance
    // would legitimately start a second, separate (not overlapping) run;
    // asserting on the state exactly as it stood the instant the first run
    // delivered is the actual claim under test.
    expect(mockedRunScriptProcess).toHaveBeenCalledTimes(1);
    expect(delivered.length).toBe(1);
    expect(delivered[0].tier).toBe("triage");
    expect(delivered[0].outcome).toBe("run_completed");
    expect(delivered[0].analysis).toBe("done");
  });
});
