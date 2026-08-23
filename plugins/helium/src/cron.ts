import { Cron } from "croner";
import { nowIso, type TriggerCron } from "@helium/core";
import type { TriggerEvent } from "./sensor.js";

/** Pure next-run resolution; the tz is an IANA name, the result is a UTC instant. */
export function nextCronRun(
  schedule: string,
  tz: string,
  from: Date,
): Date | null {
  const cron = new Cron(schedule, { timezone: tz, paused: true });
  try {
    return cron.nextRun(from);
  } finally {
    cron.stop();
  }
}

export function buildCronEvent(job: string, firedAt: Date): TriggerEvent {
  const minute = firedAt.toISOString().slice(0, 16);
  return {
    job,
    kind: "cron",
    firedAt: nowIso(),
    dedupKey: `${job}:cron:${minute}Z`,
    payload: { scheduledFor: firedAt.toISOString() },
  };
}

export class CronTrigger {
  readonly #job: string;
  readonly #trigger: TriggerCron;
  readonly #onTrigger: (ev: TriggerEvent) => void | Promise<void>;
  #cron: Cron | undefined;

  constructor(opts: {
    job: string;
    trigger: TriggerCron;
    onTrigger: (ev: TriggerEvent) => void | Promise<void>;
  }) {
    this.#job = opts.job;
    this.#trigger = opts.trigger;
    this.#onTrigger = opts.onTrigger;
  }

  start(): void {
    if (this.#cron) return;
    this.#cron = new Cron(
      this.#trigger.schedule,
      { timezone: this.#trigger.tz, protect: true },
      () => {
        void Promise.resolve(
          this.#onTrigger(buildCronEvent(this.#job, new Date())),
        ).catch((error: unknown) => {
          console.error(`helium.cron(${this.#job}):`, error);
        });
      },
    );
  }

  stop(): void {
    this.#cron?.stop();
    this.#cron = undefined;
  }
}
