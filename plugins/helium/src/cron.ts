import { Cron } from "croner";
import { nowIso } from "@helium/core";
import type {
  TenantTrigger,
  TenantTriggerEvent,
} from "./tenant-runtime.js";

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

export function buildCronEvent(
  tenant: string,
  firedAt: Date,
): TenantTriggerEvent {
  const minute = firedAt.toISOString().slice(0, 16);
  return {
    tenant,
    kind: "cron",
    firedAt: nowIso(),
    dedupKey: `${tenant}:cron:${minute}Z`,
    payload: { scheduledFor: firedAt.toISOString() },
  };
}

export class CronTrigger {
  readonly #tenant: string;
  readonly #trigger: TenantTrigger;
  readonly #onTrigger: (ev: TenantTriggerEvent) => void | Promise<void>;
  #cron: Cron | undefined;

  constructor(opts: {
    tenant: string;
    trigger: TenantTrigger;
    onTrigger: (ev: TenantTriggerEvent) => void | Promise<void>;
  }) {
    this.#tenant = opts.tenant;
    this.#trigger = opts.trigger;
    this.#onTrigger = opts.onTrigger;
  }

  start(): void {
    if (this.#cron) return;
    this.#cron = new Cron(
      this.#trigger.schedule,
      { timezone: this.#trigger.timezone, protect: true },
      () => {
        void Promise.resolve(
          this.#onTrigger(buildCronEvent(this.#tenant, new Date())),
        ).catch((error: unknown) => {
          console.error(`helium.cron(${this.#tenant}):`, error);
        });
      },
    );
  }

  stop(): void {
    this.#cron?.stop();
    this.#cron = undefined;
  }
}
