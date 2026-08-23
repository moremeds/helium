/**
 * helium — umbrella cordis plugin. Wires each enabled job's state-change,
 * calendar-window and cron triggers onto their own `ctx.effect` lifecycle,
 * and routes every fired trigger through the {@link Dispatcher}.
 * @module dsh-plugin-helium
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  JsonlWriter,
  RunLedger,
  StateStore,
  loadJobs,
  type TriggerCalendarWindow,
} from "@helium/core";
import { CalendarWindowWatcher, loadCalendar } from "./calendar.js";
import { buildChildEnv, runClaude } from "./claude.js";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { CronTrigger } from "./cron.js";
import { Dispatcher, TriageRunner, type SeniorLane } from "./dispatch.js";
import {
  scheduleLoop,
  StateChangePoller,
  type TriggerEvent,
} from "./sensor.js";

export const name = "helium";
export const inject = ["agentDefaultModel", "agents", "sessions", "tools"];
export { type Config } from "./config.js";

/** Fallback base cadence (spec has no bare interval when only calendar windows are armed). */
const DEFAULT_WATCH_ONLY_INTERVAL_MS = 60_000;

/**
 * Senior lane: spawns the host `claude -p` binary and translates its result
 * into the `SeniorLane` outcome shape the {@link Dispatcher} expects.
 */
function buildSeniorLane(cfg: Config): SeniorLane {
  // Task 2.7 writes the MCP config JSON itself; this only derives the path
  // it will land at, colocated with the server binary (the same layout
  // `contracts/fixtures/mcp-ping/{server.mjs,mcp-config.json}` verified live
  // in Task 1.7).
  const mcpConfigPath = join(dirname(cfg.mcpBin), "mcp-config.json");
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
  const dispatcher = new Dispatcher({
    store,
    ledger,
    contextText,
    triage: new TriageRunner(ctx),
    senior: buildSeniorLane(cfg),
    // ThesisReader wiring lands in Task 2.7 (ThesisStore); thesis-file jobs
    // dispatch without injected thesis content until then.
    onResult: (job, ev, result) => {
      jsonl.append("results", { job: job.name, ev, result });
    },
    onSuppressed: (job, ev, info) => {
      jsonl.append("suppressed", { job: job.name, ev, ...info });
    },
  });

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
              await poller.tick();
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
}
