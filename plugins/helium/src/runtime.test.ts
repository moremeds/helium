/**
 * Unit coverage for the pure orchestrator: job filtering, startup
 * reconciliation, the Task 2.2 carry-in (one scheduling loop per job, not
 * per trigger — a job's shared calendar watcher must be ticked once per
 * cycle regardless of how many state-change triggers the job declares),
 * cron-payload inbox folding, stop() disposal, and (Task 3.6) routing a
 * `script`-carrying job to the script runner instead of the dispatcher.
 * `apply()`-level dsh wiring is covered by the contract suite / local E2E,
 * not here (mirrors index.test.ts's existing split).
 * @module dsh-plugin-helium/runtime.test
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonlFileName } from "@helium/core";
import { CalendarWindowWatcher } from "./calendar.js";
import type { Config } from "./config.js";
import type { DispatchResult } from "./dispatch.js";
import {
  augmentCronPayload,
  drainInbox,
  HeliumRuntime,
  type RuntimeDeps,
} from "./runtime.js";
import { StateChangePoller } from "./sensor.js";
import { startFixture, type Fixture } from "./testing/http-fixture.js";

const JOB_YAML = (name: string, triggersYaml: string) => `
name: ${name}
enabled: true
triggers:
${triggersYaml}
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: none
tools: []
max_turns: { triage: 2, senior: 2 }
timeout: 60s
budget: { max_triage_per_hour: 60, max_senior_per_day: 60 }
delivery:
  jsonl: true
prompt: unit fixture job
`;

const STATE_CHANGE = (
  url: string,
  fields: string,
  intervalMs: number,
) => `  - kind: state-change
    url: ${url}
    fields: [${fields}]
    interval: ${intervalMs}ms`;

const CALENDAR_WINDOW = (
  calendar: string,
  intervalMs: number,
) => `  - kind: calendar-window
    calendar: ${calendar}
    window: { before: 5m, after: 5m }
    interval_during: ${intervalMs}ms`;

function rig(
  jobYaml: string,
  calendarYaml?: string,
  runtimeMode: Config["runtimeMode"] = "legacy-direct",
) {
  const root = mkdtempSync(join(tmpdir(), "helium-runtime-"));
  const jobsDir = join(root, "jobs");
  const calendarsDir = join(root, "calendars");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(calendarsDir, { recursive: true });
  writeFileSync(join(jobsDir, "job.yaml"), jobYaml, "utf8");
  if (calendarYaml) {
    writeFileSync(join(calendarsDir, "test-cal.yaml"), calendarYaml, "utf8");
  }
  writeFileSync(join(root, "ecosystem.md"), "# ctx\n", "utf8");
  const deps: RuntimeDeps = {
    config: {
      runtimeMode,
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
      triage: { dispatch: async () => ({ outcome: "run_completed" as const }) },
      senior: { dispatch: async () => ({ outcome: "run_completed" as const }) },
    },
    delivery: {
      deliver: () => {},
      budgetExhausted: () => {},
      heartbeat: () => {},
      reconcileDeliveries: () => 0,
    },
  };
  return { root, jobsDir, deps };
}

describe("drainInbox", () => {
  it("returns [] when the inbox directory does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-inbox-"));
    expect(drainInbox(join(root, "inbox"))).toEqual([]);
  });

  it("reads and deletes .json drops in file-name order, skipping malformed ones", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-inbox-"));
    const dir = join(root, "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.json"), JSON.stringify({ n: 2 }), "utf8");
    writeFileSync(join(dir, "a.json"), JSON.stringify({ n: 1 }), "utf8");
    writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
    writeFileSync(join(dir, "ignore.txt"), "nope", "utf8");

    expect(drainInbox(dir)).toEqual([{ n: 1 }, { n: 2 }]);
    // Consumed drops are removed; a second drain is empty. The malformed and
    // non-.json files are left in place for inspection.
    expect(drainInbox(dir)).toEqual([]);
  });
});

describe("augmentCronPayload", () => {
  it("folds the drained inbox into a cron event's payload", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-inbox-"));
    const inboxDir = join(root, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, "note.json"),
      JSON.stringify({ kind: "canary" }),
      "utf8",
    );
    const ev = augmentCronPayload(
      {
        job: "cronjob",
        kind: "cron",
        firedAt: "2026-08-24T00:00:00.000Z",
        dedupKey: "cronjob:cron:x",
        payload: { scheduledFor: "2026-08-24T00:00:00.000Z" },
      },
      root,
    );
    expect(ev.payload).toEqual({
      scheduledFor: "2026-08-24T00:00:00.000Z",
      inbox: [{ kind: "canary" }],
    });
  });

  it("leaves a non-cron event's payload untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-inbox-"));
    const ev = augmentCronPayload(
      {
        job: "j",
        kind: "state-change",
        firedAt: "2026-08-24T00:00:00.000Z",
        dedupKey: "d",
        payload: { url: "u" },
      },
      root,
    );
    expect(ev.payload).toEqual({ url: "u" });
  });
});

describe("HeliumRuntime", () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    vi.restoreAllMocks();
  });

  it("loads and exposes only enabled jobs", () => {
    const { deps, jobsDir } = rig(
      JOB_YAML("a", STATE_CHANGE("http://127.0.0.1:1", "state", 1000)),
    );
    writeFileSync(
      join(jobsDir, "disabled.yaml"),
      JOB_YAML("b", STATE_CHANGE("http://127.0.0.1:1", "state", 1000)).replace(
        "enabled: true",
        "enabled: false",
      ),
      "utf8",
    );
    const rt = new HeliumRuntime(deps);
    expect(rt.jobNames).toEqual(["a"]);
  });

  it("reconciles startup and appends a harness_started row before any job starts", () => {
    const { deps } = rig(
      JOB_YAML("a", STATE_CHANGE("http://127.0.0.1:1", "state", 1000)),
    );
    const rt = new HeliumRuntime(deps);
    rt.start();
    rt.stop();
    const text = readFileSync(
      join(deps.config.stateRoot, "jsonl", jsonlFileName("runs", new Date())),
      "utf8",
    );
    expect(text).toContain('"phase":"harness_started"');
    expect(text).toContain('"jobs":1');
  });

  it("carry-in (Task 2.2): one scheduling loop per job ticks a shared calendar watcher once per cycle, not once per state-change trigger", async () => {
    const far = new Date(Date.now() + 3_600_000).toISOString();
    const { deps } = rig(
      JOB_YAML(
        "multi",
        [
          STATE_CHANGE("http://fixture.invalid/one", "state", 10_000),
          STATE_CHANGE("http://fixture.invalid/two", "state2", 10_000),
          CALENDAR_WINDOW("test-cal", 10_000),
        ].join("\n"),
      ),
      `- name: FOMC-test\n  kind: FOMC\n  at: ${far}\n`,
    );
    deps.fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ state: "x", state2: "y" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const pollerSpy = vi.spyOn(StateChangePoller.prototype, "tick");
    const watcherSpy = vi.spyOn(CalendarWindowWatcher.prototype, "tick");
    const rt = new HeliumRuntime(deps);
    rt.start();
    await vi.waitFor(() => {
      expect(pollerSpy).toHaveBeenCalledTimes(2);
      expect(watcherSpy).toHaveBeenCalledTimes(1);
    });
    rt.stop();

    const pollerCalls = pollerSpy.mock.calls.length; // 2 pollers ticked every cycle
    const watcherCalls = watcherSpy.mock.calls.length; // 1 watcher, shared by the job
    expect(pollerCalls).toBeGreaterThan(0);
    expect(pollerCalls % 2).toBe(0); // both state-change triggers tick together, in lockstep
    // The regression this guards: a per-trigger scheduleLoop would tick the
    // shared watcher once per trigger's own loop, i.e. `pollerCalls` times
    // instead of once per job-cycle (`pollerCalls / 2`).
    expect(watcherCalls).toBe(pollerCalls / 2);
  });

  it("stop() disposes the job loop so no further ticks occur", async () => {
    let hits = 0;
    fixture = await startFixture((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "x" }));
    });
    const { deps } = rig(
      JOB_YAML("stoppable", STATE_CHANGE(fixture.url, "state", 30)),
    );
    const rt = new HeliumRuntime(deps);
    rt.start();
    await new Promise((r) => setTimeout(r, 100));
    rt.stop();
    // stop() cancels the *next scheduled* tick only — a tick already
    // in-flight (mid-fetch) at the instant stop() was called is not
    // aborted, so a snapshot taken immediately after stop() can race that
    // still-completing fetch (flaky under load, characterized separately
    // from the fix-round-1 script-guard flake). Give it a moment to settle
    // before snapshotting; the real guarantee under test is "no *new*
    // ticks after stop()", which the second wait below still verifies.
    await new Promise((r) => setTimeout(r, 50));
    const settled = hits;
    expect(settled).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toBe(settled);
  });

  describe("script jobs (Task 3.6)", () => {
    function fakeScript(body: string): string {
      const dir = mkdtempSync(join(tmpdir(), "helium-runtime-script-bin-"));
      const bin = join(dir, "run.sh");
      writeFileSync(bin, `#!/bin/sh\n${body}\n`);
      chmodSync(bin, 0o755);
      return bin;
    }

    /** Fixture that returns a strictly-increasing body so `state-change` fires a "changed" event on the second poll, not just a baseline. */
    async function changingFixture(): Promise<Fixture> {
      let n = 0;
      return startFixture((_req, res) => {
        n += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: `v${n}` }));
      });
    }

    it("routes a job.script trigger through the script runner instead of the triage/senior engines, recording a ledger row and delivering a DispatchResult", async () => {
      fixture = await changingFixture();
      const script = fakeScript(`echo "trigger seen: $HELIUM_TRIGGER"; exit 0`);
      const jobYaml = `${JOB_YAML("dsh-canary", STATE_CHANGE(fixture.url, "state", 25))}\nscript:\n  command: ${script}\n  args: []\n  timeout: 5s\n`;
      const { deps } = rig(jobYaml);
      const triageSpy = vi.fn(async () => ({
        outcome: "run_completed" as const,
      }));
      deps.engines.triage = { dispatch: triageSpy };
      const delivered: DispatchResult[] = [];
      deps.delivery.deliver = (_job, _ev, result) => {
        delivered.push(result);
      };

      const rt = new HeliumRuntime(deps);
      rt.start();
      await vi.waitFor(
        () => {
          expect(delivered.length).toBeGreaterThan(0);
        },
        { timeout: 3_000, interval: 20 },
      );
      rt.stop();

      expect(triageSpy).not.toHaveBeenCalled();
      expect(delivered[0].tier).toBe("triage");
      expect(delivered[0].outcome).toBe("run_completed");
      expect(delivered[0].analysis).toContain("trigger seen:");
      expect(delivered[0].analysis).toContain('"kind":"state-change"');

      const runsText = readFileSync(
        join(deps.config.stateRoot, "jsonl", jsonlFileName("runs", new Date())),
        "utf8",
      );
      expect(runsText).toContain('"phase":"run_started"');
      expect(runsText).toContain('"phase":"run_completed"');
    });

    it("delivers run_failed with the stderr tail when the script exits non-zero", async () => {
      fixture = await changingFixture();
      const script = fakeScript(`echo "candidate install failed" 1>&2; exit 1`);
      const jobYaml = `${JOB_YAML("dsh-canary", STATE_CHANGE(fixture.url, "state", 25))}\nscript:\n  command: ${script}\n  args: []\n  timeout: 5s\n`;
      const { deps } = rig(jobYaml);
      const delivered: DispatchResult[] = [];
      deps.delivery.deliver = (_job, _ev, result) => {
        delivered.push(result);
      };

      const rt = new HeliumRuntime(deps);
      rt.start();
      await vi.waitFor(
        () => {
          expect(delivered.length).toBeGreaterThan(0);
        },
        { timeout: 3_000, interval: 20 },
      );
      rt.stop();

      expect(delivered[0].outcome).toBe("run_failed");
      expect(delivered[0].error).toContain("candidate install failed");
    });
  });
  // Task 5: per-tenant liveness. The global dead-man check is satisfied by ANY
  // tenant's heartbeat, so these rows are what make a single silent or
  // unparseable tenant visible at all.
  describe("expected-tenant inventory", () => {
    it("emits a tenant-health row per *.yaml at startup, keeping a malformed tenant as invalid", () => {
      const r = rig(
        JOB_YAML("test-job", STATE_CHANGE("http://127.0.0.1:1", "state", 1000)),
      );
      // A second tenant file that does not parse. loadJobs() skips it, so it is
      // absent from `jobNames` — but it must NOT be absent from the inventory,
      // or the fleet reads as fully healthy while this tenant is not running.
      writeFileSync(join(r.jobsDir, "b-broken.yaml"), "this: [is not a job", "utf8");

      const runtime = new HeliumRuntime(r.deps);
      runtime.start();
      runtime.stop();

      const dir = join(r.root, "state", "jsonl");
      const file = readdirSync(dir).find((f) => f.startsWith("tenant-health-"));
      expect(file, "no tenant-health stream was written").toBeDefined();
      const rows = readFileSync(join(dir, file!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { tenant: string; load: string });

      expect(rows.map((x) => [x.tenant, x.load])).toEqual([
        ["b-broken", "invalid"],
        ["test-job", "loaded"],
      ]);
      // The malformed tenant is skipped for execution but still inventoried.
      expect(runtime.jobNames).toEqual(["test-job"]);
    });

    it("closes crash-orphaned delivery intents at boot", () => {
      // The write-ahead intent row is only half the property: without this call
      // at startup, an intent orphaned by a crash stays `pending` forever and
      // the `uncertain` terminal row is never actually written in production.
      const r = rig(
        JOB_YAML("test-job", STATE_CHANGE("http://127.0.0.1:1", "state", 1000)),
      );
      let calls = 0;
      const runtime = new HeliumRuntime({
        ...r.deps,
        delivery: {
          ...r.deps.delivery,
          reconcileDeliveries: () => {
            calls += 1;
            return 2;
          },
        },
      });
      runtime.start();
      runtime.stop();
      expect(calls).toBe(1);

      const runs = readFileSync(
        join(
          r.root,
          "state",
          "jsonl",
          readdirSync(join(r.root, "state", "jsonl")).find((f) =>
            f.startsWith("runs-"),
          )!,
        ),
        "utf8",
      );
      expect(runs).toContain('"orphanedDeliveries":2');
    });
  });
});
