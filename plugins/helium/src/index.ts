/**
 * helium — umbrella cordis plugin. Wires each enabled job's state-change,
 * calendar-window and cron triggers onto their own `ctx.effect` lifecycle,
 * and routes every fired trigger through the {@link Dispatcher}.
 * @module dsh-plugin-helium
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Cron } from "croner";
import {
  buildTools,
  JsonlWriter,
  RunLedger,
  StateStore,
  ThesisStore,
  loadJobs,
  type TriggerCalendarWindow,
} from "@helium/core";
import { CalendarWindowWatcher, loadCalendar } from "./calendar.js";
import { buildChildEnv, runClaude } from "./claude.js";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { CronTrigger } from "./cron.js";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { Dispatcher, TriageRunner, type SeniorLane } from "./dispatch.js";
import { readEnvFile } from "./envfile.js";
import {
  scheduleLoop,
  StateChangePoller,
  type TriggerEvent,
} from "./sensor.js";
import { registerEcosystemTools } from "./toolkit.js";

export const name = "helium";
export const inject = ["agentDefaultModel", "agents", "sessions", "tools"];
export { type Config } from "./config.js";

/**
 * Runs a synchronous step and swallows (logs) any throw instead of letting it
 * escape. Used to guard cron callbacks: croner@10.0.1 has no `catch` option
 * for a sync `Cron(...)` callback, so an unguarded throw (e.g. a transient FS
 * failure from `jsonl.prune()`) becomes an unhandled rejection that kills the
 * whole daemon.
 */
export function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e: unknown) {
    console.error(`${label}:`, e);
  }
}

/** Fallback base cadence (spec has no bare interval when only calendar windows are armed). */
const DEFAULT_WATCH_ONLY_INTERVAL_MS = 60_000;

/**
 * Senior lane: spawns the host `claude -p` binary and translates its result
 * into the `SeniorLane` outcome shape the {@link Dispatcher} expects.
 */
function buildSeniorLane(cfg: Config): SeniorLane {
  // Carry-in decision (Task 2.7, correcting Task 2.5's flagged colocated-
  // with-cfg.mcpBin guess): task-3.1-brief.md Step 10 is the authoritative
  // source for this path — the mini's `cfg.mcpBin` points inside a versioned,
  // symlink-swapped release tree
  // (`.../helium-releases/current/node_modules/.bin/helium-mcp`, per
  // task-3.3-brief.md), so writing a generated config file next to it would
  // land inside a pnpm-managed node_modules/.bin — HELIUM_STATE_ROOT is the
  // stable, writable directory that survives a release swap, and is where
  // Task 3.1 actually writes mcp.json once at startup. Task 2.7 (this task)
  // does not write that file's content — only Task 3.1 does — this line only
  // makes the path this process passes to `claude -p --mcp-config` agree
  // with where Task 3.1 will put it.
  const mcpConfigPath = join(cfg.stateRoot, "mcp.json");
  return {
    async dispatch(job, _ev, prompt) {
      const env = buildChildEnv(cfg, { PATH: process.env.PATH ?? "" });
      const result = await runClaude({
        prompt,
        cwd: process.cwd(),
        maxTurns: job.maxTurns.senior,
        timeoutMs: job.timeoutMs,
        allowedTools: job.tools.map((t) => `mcp__helium__${t}`),
        mcpConfigPath,
        env,
      });
      if (result.ok) return { outcome: "run_completed", analysis: result.text };
      if (result.classification === "timeout") {
        return {
          outcome: "timed_out",
          error: "senior lane exceeded its wall clock",
        };
      }
      return {
        outcome: "run_failed",
        error: `${result.classification ?? "error"}${result.text ? `: ${result.text}` : ""}`,
      };
    },
  };
}

export function apply(ctx: Context, raw: Config): void {
  const cfg = ConfigSchema.parse(raw);
  const paths = statePaths(cfg);
  const store = new StateStore(paths.state);
  const jsonl = new JsonlWriter(paths.jsonl);
  const ledger = new RunLedger(jsonl);
  ledger.reconcileStartup();

  const contextText = readFileSync(cfg.contextFile, "utf8");
  const delivery = new Delivery({
    jsonl,
    jsonlDir: paths.jsonl,
    reportsDir: paths.reports,
    emailTo: cfg.emailTo,
    smtp: smtpFromEnv(readEnvFile(cfg.envFile)),
  });
  const dispatcher = new Dispatcher({
    store,
    ledger,
    contextText,
    triage: new TriageRunner(ctx),
    senior: buildSeniorLane(cfg),
    thesis: new ThesisStore(cfg.stateRoot),
    onResult: (job, ev, result) => delivery.deliver(job, ev, result),
    onSuppressed: (job, ev, info) => delivery.budgetExhausted(job, ev, info),
  });

  // Global in-process registration for dsh agents / the interactive Web UI:
  // read-only by design (spec §6), regardless of any job's allowMutations. A
  // job that enables mutations gets those tools only through the senior
  // lane's MCP server (HELIUM_ALLOW_MUTATIONS=1), keeping the audit boundary
  // on the child process instead of on every interactive session.
  const tools = buildTools({
    argonBase: cfg.argonBase,
    apexBase: cfg.apexBase,
    livewireDb: cfg.livewireDb,
    stateRoot: cfg.stateRoot,
  });
  registerEcosystemTools(
    ctx,
    tools.filter((t) => !t.mutating),
  );

  for (const job of loadJobs(cfg.jobsDir).filter((j) => j.enabled)) {
    const onTrigger = (ev: TriggerEvent): void => {
      dispatcher.enqueue(job, ev);
    };

    const watchers = job.triggers
      .filter((t): t is TriggerCalendarWindow => t.kind === "calendar-window")
      .map((t) => ({
        trigger: t,
        watcher: new CalendarWindowWatcher({
          job: job.name,
          trigger: t,
          events: loadCalendar(cfg.calendarsDir, t.calendar),
          store,
          onTrigger,
        }),
      }));

    /** Tightest interval among the calendar windows currently open, else the base. */
    const resolveInterval = (base: number): number => {
      let interval = base;
      for (const { trigger: t, watcher } of watchers) {
        if (watcher.currentWindow() !== null)
          interval = Math.min(interval, t.intervalDuringMs);
      }
      return interval;
    };

    const stateChangeTriggers = job.triggers.filter(
      (t) => t.kind === "state-change",
    );

    for (const trigger of stateChangeTriggers) {
      const poller = new StateChangePoller({
        job: job.name,
        trigger,
        store,
        onTrigger,
      });
      ctx.effect(
        () =>
          scheduleLoop(
            () => resolveInterval(trigger.intervalMs),
            async () => {
              for (const { watcher } of watchers) await watcher.tick();
              const status = await poller.tick();
              // Spec §8: heartbeat is written every sensor cycle, including
              // no-ops. `status` already carries `job` (the poller's job name).
              delivery.heartbeat({ trigger: "state-change", ...status });
            },
          ),
        `helium.sensor.poll(${job.name})`,
      );
    }

    // A job with calendar windows but no state-change trigger still needs a loop to tick them.
    if (stateChangeTriggers.length === 0 && watchers.length > 0) {
      ctx.effect(
        () =>
          scheduleLoop(
            () => resolveInterval(DEFAULT_WATCH_ONLY_INTERVAL_MS),
            async () => {
              for (const { watcher } of watchers) await watcher.tick();
              // Spec §8: heartbeat is written every sensor cycle, including no-ops.
              delivery.heartbeat({
                job: job.name,
                trigger: "calendar-window",
                state: "watch-only",
              });
            },
          ),
        `helium.sensor.poll(${job.name})`,
      );
    }

    for (const trigger of job.triggers) {
      if (trigger.kind !== "cron") continue;
      const cron = new CronTrigger({ job: job.name, trigger, onTrigger });
      ctx.effect(() => {
        cron.start();
        return () => {
          cron.stop();
        };
      }, `helium.sensor.cron(${job.name})`);
    }
  }

  // Daily synthesis (spec §8/§11): the floor, not the product. Also prunes
  // the JSONL trail to the 90-day retention window (controller-pinned
  // addition — kept alongside the synthesis send itself, not a separate cron).
  const synthesis = new Cron(
    "5 17 * * *",
    { timezone: "America/New_York", protect: true },
    () => {
      // Guarded independently of the dailySynthesis catch below (see
      // runGuarded's doc comment for why this needs its own guard).
      runGuarded("helium.prune", () => {
        jsonl.prune(90);
      });
      void delivery.dailySynthesis().catch((e: unknown) => {
        console.error("helium.synthesis:", e);
      });
    },
  );
  ctx.effect(
    () => () => {
      synthesis.stop();
    },
    "helium.delivery.synthesis()",
  );
}
