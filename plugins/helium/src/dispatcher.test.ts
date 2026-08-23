import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlWriter, RunLedger, StateStore, type JobSpec } from "@helium/core";
import { Dispatcher, budgetCheck, pruneFires, Semaphore } from "./dispatch.js";
import { ev, job } from "./testing/fixtures.js";

function rig(
  overrides: Partial<{ triageSeverity: string; seniorDelayMs: number }> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "helium-disp-"));
  const store = new StateStore(root);
  const ledger = new RunLedger(new JsonlWriter(join(root, "jsonl")));
  const results: { tier: string; outcome: string }[] = [];
  const suppressed: string[] = [];
  const seniorPrompts: string[] = [];
  let clock = Date.parse("2026-08-23T12:00:00.000Z");
  const dispatcher = new Dispatcher({
    store,
    ledger,
    contextText: "CTX",
    triage: {
      dispatch: async () => ({
        outcome: "run_completed" as const,
        verdict: {
          escalate: true,
          severity: (overrides.triageSeverity ?? "material") as never,
          reason: "r",
        },
        text: "ok",
      }),
    },
    senior: {
      dispatch: async (_j, _e, prompt) => {
        seniorPrompts.push(prompt);
        if (overrides.seniorDelayMs)
          await new Promise((r) => setTimeout(r, overrides.seniorDelayMs));
        return { outcome: "run_completed" as const, analysis: "ANALYSIS" };
      },
    },
    thesis: { read: () => "STANDING THESIS" },
    onResult: (_j, _e, r) => {
      results.push({ tier: r.tier, outcome: r.outcome });
    },
    onSuppressed: (_j, _e, i) => {
      suppressed.push(i.tier);
    },
    now: () => new Date(clock),
  });
  return {
    dispatcher,
    store,
    root,
    results,
    suppressed,
    seniorPrompts,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("pruneFires", () => {
  it("keeps only stamps inside the rolling window", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const stamps = ["2026-08-23T10:00:00.000Z", "2026-08-23T11:30:00.000Z"];
    expect(pruneFires(stamps, 3_600_000, now)).toEqual([
      "2026-08-23T11:30:00.000Z",
    ]);
  });
});

describe("budgetCheck", () => {
  it("blocks triage at the hourly cap and senior at the daily cap", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const fires = (n: number) =>
      Array.from({ length: n }, () => "2026-08-23T11:59:00.000Z");
    const state = { dedup: {}, triageFires: fires(30), seniorFires: fires(12) };
    expect(budgetCheck(state as never, job, "triage", now)).toMatchObject({
      allowed: false,
      cap: 30,
    });
    expect(budgetCheck(state as never, job, "senior", now)).toMatchObject({
      allowed: false,
      cap: 12,
    });
    expect(
      budgetCheck(
        { dedup: {}, triageFires: [], seniorFires: [] } as never,
        job,
        "triage",
        now,
      ).allowed,
    ).toBe(true);
  });
});

describe("Semaphore", () => {
  it("admits `limit` holders and queues the rest", async () => {
    const s = new Semaphore(2);
    const a = await s.acquire();
    await s.acquire();
    let third = false;
    const pending = s.acquire().then(() => {
      third = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    a();
    await pending;
    expect(third).toBe(true);
  });
});

describe("Dispatcher", () => {
  it("runs triage then senior, records both results, and injects the thesis", async () => {
    const r = rig();
    r.dispatcher.enqueue(job, ev);
    await r.dispatcher.drain();
    expect(r.results).toEqual([
      { tier: "triage", outcome: "run_completed" },
      { tier: "senior", outcome: "run_completed" },
    ]);
    expect(r.seniorPrompts[0]).toContain("STANDING THESIS");
    expect(r.seniorPrompts[0]).toContain("CTX");
    expect(r.seniorPrompts[0]).toContain('"severity": "material"');
  });

  it("stops at triage when the verdict is below the job threshold", async () => {
    const r = rig({ triageSeverity: "minor" });
    r.dispatcher.enqueue(job, ev);
    await r.dispatcher.drain();
    expect(r.results.map((x) => x.tier)).toEqual(["triage"]);
    expect(r.seniorPrompts).toHaveLength(0);
  });

  it("coalesces concurrent events for one job to a single queued follow-up", async () => {
    const r = rig({ seniorDelayMs: 30 });
    r.dispatcher.enqueue(job, ev);
    r.dispatcher.enqueue(job, { ...ev, dedupKey: "b" });
    r.dispatcher.enqueue(job, { ...ev, dedupKey: "c" });
    await r.dispatcher.drain();
    expect(r.results.filter((x) => x.tier === "triage")).toHaveLength(2); // first + latest, not three
  });

  it("replaces a queued second trigger with a third rather than running both (latest wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-disp-"));
    const store = new StateStore(root);
    const ledger = new RunLedger(new JsonlWriter(join(root, "jsonl")));
    const seenTriageKeys: string[] = [];
    const dispatcher = new Dispatcher({
      store,
      ledger,
      contextText: "CTX",
      triage: {
        dispatch: async (_j, e) => {
          seenTriageKeys.push(e.dedupKey);
          if (seenTriageKeys.length === 1)
            await new Promise((res) => setTimeout(res, 30));
          return {
            outcome: "run_completed" as const,
            verdict: {
              escalate: false,
              severity: "noise" as never,
              reason: "r",
            },
          };
        },
      },
      senior: { dispatch: async () => ({ outcome: "run_completed" as const }) },
      onResult: () => {},
      onSuppressed: () => {},
    });
    dispatcher.enqueue(job, { ...ev, dedupKey: "a" });
    dispatcher.enqueue(job, { ...ev, dedupKey: "b" });
    dispatcher.enqueue(job, { ...ev, dedupKey: "c" });
    await dispatcher.drain();
    expect(seenTriageKeys).toEqual(["a", "c"]); // "b" was replaced by "c" while "a" was in flight
  });

  it("suppresses and reports the dispatch when the triage budget is exhausted", async () => {
    const r = rig();
    const state = r.store.loadSensor(job.name);
    state.triageFires = Array.from(
      { length: 30 },
      () => "2026-08-23T11:59:00.000Z",
    );
    r.store.saveSensor(job.name, state);
    r.dispatcher.enqueue(job, ev);
    await r.dispatcher.drain();
    expect(r.suppressed).toEqual(["triage"]);
    expect(r.results).toHaveLength(0);
  });

  it("records timed_out when a lane outlives the job timeout", async () => {
    const r = rig({ seniorDelayMs: 200 });
    r.dispatcher.enqueue({ ...job, timeoutMs: 50 }, ev);
    await r.dispatcher.drain();
    expect(r.results.find((x) => x.tier === "senior")?.outcome).toBe(
      "timed_out",
    );
  });

  it("persists pruned, incremented budget stamps that survive a restart", async () => {
    const r = rig();
    const seeded = r.store.loadSensor(job.name);
    // One stale stamp outside the 1h triage window and one inside it.
    seeded.triageFires = [
      "2026-08-23T09:00:00.000Z",
      "2026-08-23T11:45:00.000Z",
    ];
    r.store.saveSensor(job.name, seeded);

    r.dispatcher.enqueue(job, ev);
    await r.dispatcher.drain();

    // Simulate a restart: a brand new StateStore reading the same root.
    const reopened = new StateStore(r.root).loadSensor(job.name);
    expect(reopened.triageFires).toEqual([
      "2026-08-23T11:45:00.000Z",
      "2026-08-23T12:00:00.000Z",
    ]);
    expect(reopened.seniorFires).toEqual(["2026-08-23T12:00:00.000Z"]);
  });

  it("caps concurrent senior dispatches at the configured limit across different jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-disp-"));
    const store = new StateStore(root);
    const ledger = new RunLedger(new JsonlWriter(join(root, "jsonl")));
    let active = 0;
    let maxActive = 0;
    const dispatcher = new Dispatcher({
      store,
      ledger,
      contextText: "CTX",
      triage: {
        dispatch: async () => ({
          outcome: "run_completed" as const,
          verdict: {
            escalate: true,
            severity: "material" as never,
            reason: "r",
          },
        }),
      },
      senior: {
        dispatch: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((res) => setTimeout(res, 30));
          active -= 1;
          return { outcome: "run_completed" as const };
        },
      },
      onResult: () => {},
      onSuppressed: () => {},
      maxConcurrentSenior: 2,
    });
    const jobs: JobSpec[] = [1, 2, 3].map(
      (n) => ({ ...job, name: `${job.name}-${n}` }) as JobSpec,
    );
    for (const j of jobs) dispatcher.enqueue(j, { ...ev, job: j.name });
    await dispatcher.drain();
    expect(maxActive).toBe(2);
  });

  it("fails the triage dispatch when the job's triage engine is not deepseek", async () => {
    const r = rig();
    const badJob = {
      ...job,
      engine: {
        ...job.engine,
        triage: { ...job.engine.triage, engine: "gpt5" },
      },
    } as unknown as JobSpec;
    let triageCalled = false;
    const dispatcher = new Dispatcher({
      store: r.store,
      ledger: new RunLedger(new JsonlWriter(join(r.root, "jsonl-2"))),
      contextText: "CTX",
      triage: {
        dispatch: async () => {
          triageCalled = true;
          return { outcome: "run_completed" as const };
        },
      },
      senior: { dispatch: async () => ({ outcome: "run_completed" as const }) },
      onResult: (_j, _e, result) => {
        r.results.push({ tier: result.tier, outcome: result.outcome });
      },
      onSuppressed: () => {},
    });
    dispatcher.enqueue(badJob, ev);
    await dispatcher.drain();
    expect(triageCalled).toBe(false);
    expect(r.results).toEqual([{ tier: "triage", outcome: "run_failed" }]);
  });
});
