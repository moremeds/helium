/**
 * helium — umbrella cordis plugin. Wires each enabled job's state-change,
 * calendar-window and cron triggers onto their own `ctx.effect` lifecycle.
 * @module dsh-plugin-helium
 */
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
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { CronTrigger } from "./cron.js";
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

export function apply(ctx: Context, raw: Config): void {
  const cfg = ConfigSchema.parse(raw);
  const paths = statePaths(cfg);
  const store = new StateStore(paths.state);
  const jsonl = new JsonlWriter(paths.jsonl);
  const ledger = new RunLedger(jsonl);
  ledger.reconcileStartup();

  for (const job of loadJobs(cfg.jobsDir).filter((j) => j.enabled)) {
    const onTrigger = (ev: TriggerEvent): void => {
      jsonl.append("triggers", { ...ev });
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
