/**
 * HeliumRuntime — the pure, dsh-free orchestrator (spec: poll -> trigger ->
 * triage -> senior -> delivery -> heartbeat). It assembles Phase 2's already
 *-tested building blocks (StateChangePoller, CalendarWindowWatcher,
 * CronTrigger, Dispatcher) into one startable harness instead of
 * reimplementing their poll/dedup/budget/escalate logic — `index.ts`'s
 * `apply()` used to do this wiring inline against a live cordis `Context`;
 * this module is the same wiring, extracted so it can run and be tested
 * without one.
 *
 * Task 2.2 carry-in: the previous wiring gave every state-change trigger its
 * own `scheduleLoop`, and each of those loops ticked ALL of the job's
 * calendar watchers — a job with two state-change triggers ticked its
 * shared watchers twice per cycle. `startJob()` below gives each job exactly
 * ONE scheduling loop covering all of its state-change triggers and
 * calendar watchers together, so a watcher is ticked once per job-cycle
 * regardless of how many state-change triggers the job declares.
 * @module dsh-plugin-helium/runtime
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  JsonlWriter,
  RunLedger,
  StateStore,
  ThesisStore,
  loadJobs,
  type JobSpec,
  type RunOutcome,
  type TriggerCalendarWindow,
  type TriggerStateChange,
} from "@helium/core";
import { CalendarWindowWatcher, loadCalendar } from "./calendar.js";
import type { Config } from "./config.js";
import { CronTrigger } from "./cron.js";
import {
  Dispatcher,
  type BudgetCheck,
  type DispatchResult,
  type SeniorLane,
  type TriageLane,
} from "./dispatch.js";
import { runScriptProcess } from "./script.js";
import {
  StateChangePoller,
  scheduleLoop,
  type TriggerEvent,
} from "./sensor.js";

export type { Config as RuntimeConfig } from "./config.js";

/** The dsh-aware triage/senior lanes, supplied by `index.ts`'s `apply()`. */
export interface EnginePorts {
  triage: TriageLane;
  senior: SeniorLane;
}

/** Notification/audit sink, supplied by `index.ts`'s `apply()`. */
export interface DeliveryPorts {
  deliver(
    job: JobSpec,
    ev: TriggerEvent,
    result: DispatchResult,
  ): void | Promise<void>;
  budgetExhausted(
    job: JobSpec,
    ev: TriggerEvent,
    info: BudgetCheck & { tier: string },
  ): void | Promise<void>;
  /** Appended every sensor cycle, including no-ops (spec §8). */
  heartbeat(row: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  config: Config;
  engines: EnginePorts;
  delivery: DeliveryPorts;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** Fallback cadence for a job whose only triggers are calendar windows. */
const DEFAULT_WATCH_ONLY_INTERVAL_MS = 60_000;

/**
 * Read and consume every `*.json` drop under `dir`, in file-name order.
 * Missing directory yields `[]`; a drop that fails to parse is left in
 * place for inspection instead of being deleted.
 */
export function drainInbox(dir: string): Record<string, unknown>[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: Record<string, unknown>[] = [];
  for (const name of entries.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue; // malformed drop left in place for inspection
    }
    out.push(parsed);
    rmSync(path);
  }
  return out;
}

/**
 * Out-of-process notices (the canary drill, Task 3.6) fold into the next
 * cron synthesis: a cron event's payload picks up whatever `drainInbox()`
 * finds under `<stateRoot>/inbox`. Any other trigger kind passes through
 * unchanged.
 */
export function augmentCronPayload(
  ev: TriggerEvent,
  stateRoot: string,
): TriggerEvent {
  if (ev.kind !== "cron") return ev;
  const inbox = drainInbox(join(stateRoot, "inbox"));
  return { ...ev, payload: { ...ev.payload, inbox } };
}

export class HeliumRuntime {
  private readonly jobs: JobSpec[];
  private readonly writer: JsonlWriter;
  private readonly ledger: RunLedger;
  private readonly store: StateStore;
  private readonly theses: ThesisStore;
  private readonly dispatcher: Dispatcher;
  private readonly disposers: (() => void)[] = [];
  /** Task 3.6: job names with a script action currently running — a second trigger while one is in flight is skipped, not queued (the next poll cycle picks up any real state change again). */
  private readonly scriptInFlight = new Set<string>();

  constructor(private readonly deps: RuntimeDeps) {
    const c = deps.config;
    this.writer = new JsonlWriter(join(c.stateRoot, "jsonl"));
    this.ledger = new RunLedger(this.writer);
    this.store = new StateStore(c.stateRoot);
    this.theses = new ThesisStore(c.stateRoot);
    this.jobs = loadJobs(c.jobsDir).filter((j) => j.enabled);

    const contextText = readFileSync(c.contextFile, "utf8");
    this.dispatcher = new Dispatcher({
      store: this.store,
      ledger: this.ledger,
      contextText,
      triage: deps.engines.triage,
      senior: deps.engines.senior,
      thesis: this.theses,
      now: deps.now,
      onResult: (job, ev, result) => deps.delivery.deliver(job, ev, result),
      onSuppressed: (job, ev, info) =>
        deps.delivery.budgetExhausted(job, ev, info),
    });
  }

  /** Names of the enabled jobs this runtime loaded, in file-name order. */
  get jobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }

  start(): void {
    const interrupted = this.ledger.reconcileStartup();
    this.log("startup reconciled", {
      interrupted,
      jobs: this.jobNames,
    });
    this.writer.append("runs", {
      phase: "harness_started",
      interrupted,
      jobs: this.jobs.length,
    });
    for (const job of this.jobs) this.startJob(job);
  }

  stop(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private log(message: string, extra?: Record<string, unknown>): void {
    (
      this.deps.log ??
      ((m: string, e?: Record<string, unknown>) =>
        console.log(`[helium] ${m}`, e ?? ""))
    )(message, extra);
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /**
   * Task 3.6: run a job's `script` action instead of a dsh agent turn. Same
   * ledger/delivery shape as the triage/senior lanes (`DispatchResult`,
   * tier `"triage"`) so downstream consumers (JSONL, email, tests) need no
   * special case for a script-backed job.
   */
  private async runScript(job: JobSpec, ev: TriggerEvent): Promise<void> {
    if (this.scriptInFlight.has(job.name)) {
      this.log("script already in flight, skipping trigger", {
        job: job.name,
      });
      return;
    }
    this.scriptInFlight.add(job.name);
    const runId = this.ledger.start(job.name, "triage");
    const started = this.nowMs();
    try {
      const result = await runScriptProcess(job.script!, {
        cwd: this.deps.config.jobsDir,
        env: {
          ...process.env,
          HELIUM_STATE_ROOT: this.deps.config.stateRoot,
          HELIUM_TRIGGER: JSON.stringify(ev),
        },
      });
      const outcome: RunOutcome = result.timedOut
        ? "timed_out"
        : result.ok
          ? "run_completed"
          : "run_failed";
      this.ledger.finish(runId, job.name, "triage", outcome, {
        code: result.code,
        ms: this.nowMs() - started,
      });
      await this.deps.delivery.deliver(job, ev, {
        runId,
        tier: "triage",
        outcome,
        analysis: result.analysis,
        error: result.error,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.finish(runId, job.name, "triage", "run_failed", {
        error: message,
      });
      await this.deps.delivery.deliver(job, ev, {
        runId,
        tier: "triage",
        outcome: "run_failed",
        error: message,
      });
    } finally {
      this.scriptInFlight.delete(job.name);
    }
  }

  private startJob(job: JobSpec): void {
    const onTrigger = (ev: TriggerEvent): void => {
      const augmented = augmentCronPayload(ev, this.deps.config.stateRoot);
      if (job.script) {
        void this.runScript(job, augmented);
        return;
      }
      this.dispatcher.enqueue(job, augmented);
    };

    const calendarTriggers = job.triggers.filter(
      (t): t is TriggerCalendarWindow => t.kind === "calendar-window",
    );
    const watchers = calendarTriggers.map((trigger) => ({
      trigger,
      watcher: new CalendarWindowWatcher({
        job: job.name,
        trigger,
        events: loadCalendar(this.deps.config.calendarsDir, trigger.calendar),
        store: this.store,
        onTrigger,
        now: this.deps.now,
      }),
    }));

    /** Tightest interval among the calendar windows currently open, else `base`. */
    const resolveInterval = (base: number): number => {
      let interval = base;
      for (const { trigger, watcher } of watchers) {
        if (watcher.currentWindow() !== null) {
          interval = Math.min(interval, trigger.intervalDuringMs);
        }
      }
      return interval;
    };

    const stateChangeTriggers = job.triggers.filter(
      (t): t is TriggerStateChange => t.kind === "state-change",
    );
    const pollers = stateChangeTriggers.map(
      (trigger) =>
        new StateChangePoller({
          job: job.name,
          trigger,
          store: this.store,
          onTrigger,
          fetchImpl: this.deps.fetchImpl,
          now: this.deps.now,
        }),
    );

    // Task 2.2 carry-in: ONE scheduling loop per job covers every
    // state-change trigger and every calendar watcher the job declares, so
    // a shared watcher is ticked exactly once per cycle no matter how many
    // state-change triggers this job has (see module doc comment).
    if (pollers.length > 0 || watchers.length > 0) {
      const baseIntervalMs =
        stateChangeTriggers.length > 0
          ? Math.min(...stateChangeTriggers.map((t) => t.intervalMs))
          : DEFAULT_WATCH_ONLY_INTERVAL_MS;
      this.disposers.push(
        scheduleLoop(
          () => resolveInterval(baseIntervalMs),
          async () => {
            for (const { watcher } of watchers) await watcher.tick();
            for (const poller of pollers) {
              const status = await poller.tick();
              // Spec §8: heartbeat is written every sensor cycle, including no-ops.
              this.deps.delivery.heartbeat({
                trigger: "state-change",
                ...status,
              });
            }
            if (pollers.length === 0 && watchers.length > 0) {
              this.deps.delivery.heartbeat({
                job: job.name,
                trigger: "calendar-window",
                state: "watch-only",
              });
            }
          },
        ),
      );
    }

    for (const trigger of job.triggers) {
      if (trigger.kind !== "cron") continue;
      const cron = new CronTrigger({ job: job.name, trigger, onTrigger });
      cron.start();
      this.disposers.push(() => {
        cron.stop();
      });
    }
  }
}
