import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { nowIso, type StateStore } from "@helium/core";
import { type TriggerCalendarWindow } from "@helium/v1-compat";
import type { TriggerEvent } from "./sensor.js";

export interface CalendarEvent {
  name: string;
  kind: "FOMC" | "CPI" | "NFP";
  at: string;
}

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

const EventSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["FOMC", "CPI", "NFP"]),
  at: z.string().refine((s) => OFFSET.test(s) && !Number.isNaN(Date.parse(s)), {
    message: "at must be an ISO-8601 stamp with an explicit UTC offset",
  }),
});

export function parseCalendar(text: string, source: string): CalendarEvent[] {
  const parsed = z.array(EventSchema).safeParse(parseYaml(text));
  if (!parsed.success) {
    throw new Error(
      `${source}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export function loadCalendar(
  calendarsDir: string,
  calendar: string,
): CalendarEvent[] {
  const file = join(calendarsDir, `${calendar}.yaml`);
  return parseCalendar(readFileSync(file, "utf8"), file);
}

export function activeWindow(
  events: CalendarEvent[],
  trigger: TriggerCalendarWindow,
  now: Date,
): CalendarEvent | null {
  const t = now.getTime();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (t >= at - trigger.beforeMs && t <= at + trigger.afterMs) return event;
  }
  return null;
}

export class CalendarWindowWatcher {
  readonly #job: string;
  readonly #trigger: TriggerCalendarWindow;
  readonly #events: CalendarEvent[];
  readonly #store: StateStore;
  readonly #onTrigger: (ev: TriggerEvent) => void | Promise<void>;
  readonly #now: () => Date;

  constructor(opts: {
    job: string;
    trigger: TriggerCalendarWindow;
    events: CalendarEvent[];
    store: StateStore;
    onTrigger: (ev: TriggerEvent) => void | Promise<void>;
    now?: () => Date;
  }) {
    this.#job = opts.job;
    this.#trigger = opts.trigger;
    this.#events = opts.events;
    this.#store = opts.store;
    this.#onTrigger = opts.onTrigger;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Pure lookup of the currently-open window, without dedup or dispatch side effects. */
  currentWindow(): CalendarEvent | null {
    return activeWindow(this.#events, this.#trigger, this.#now());
  }

  async tick(): Promise<CalendarEvent | null> {
    const now = this.#now();
    const event = activeWindow(this.#events, this.#trigger, now);
    if (!event) return null;

    const dedupKey = `${this.#job}:calendar-window:${event.name}`;
    const state = this.#store.loadSensor(this.#job);
    if (state.dedup[dedupKey] !== undefined) return event;

    // The dedup entry outlives the window so one window fires exactly once.
    state.dedup[dedupKey] = new Date(
      Date.parse(event.at) + this.#trigger.afterMs,
    ).toISOString();
    this.#store.saveSensor(this.#job, state);
    await this.#onTrigger({
      job: this.#job,
      kind: "calendar-window",
      firedAt: nowIso(),
      dedupKey,
      payload: { calendarEvent: event },
    });
    return event;
  }
}
