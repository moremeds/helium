import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore, type TriggerCalendarWindow } from "@helium/core";
import {
  CalendarWindowWatcher,
  activeWindow,
  parseCalendar,
} from "./calendar.js";
import type { TriggerEvent } from "./sensor.js";

const YAML = [
  "- name: FOMC-2026-09",
  "  kind: FOMC",
  "  at: 2026-09-16T14:00:00-04:00",
  "- name: CPI-2026-09",
  "  kind: CPI",
  "  at: 2026-09-11T08:30:00-04:00",
  "",
].join("\n");

const trigger: TriggerCalendarWindow = {
  kind: "calendar-window",
  calendar: "us-macro",
  beforeMs: 30 * 60_000,
  afterMs: 2 * 3_600_000,
  intervalDuringMs: 10_000,
};

describe("parseCalendar", () => {
  it("parses a list of named, kinded, offset-stamped events", () => {
    const events = parseCalendar(YAML, "us-macro.yaml");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      name: "FOMC-2026-09",
      kind: "FOMC",
      at: "2026-09-16T14:00:00-04:00",
    });
  });

  it("rejects an unknown kind and names the source", () => {
    expect(() =>
      parseCalendar(
        "- name: X\n  kind: GDP\n  at: 2026-09-16T14:00:00-04:00\n",
        "us-macro.yaml",
      ),
    ).toThrow(/us-macro\.yaml/);
  });

  it("rejects an `at` without an explicit offset", () => {
    expect(() =>
      parseCalendar(
        "- name: X\n  kind: CPI\n  at: 2026-09-16T14:00:00\n",
        "us-macro.yaml",
      ),
    ).toThrow(/offset/i);
  });
});

describe("activeWindow", () => {
  const events = parseCalendar(YAML, "us-macro.yaml");
  const at = (iso: string) => activeWindow(events, trigger, new Date(iso));

  it("is null well before the window", () => {
    expect(at("2026-09-16T17:00:00Z")).toBeNull(); // 13:00 ET, 60m early
  });
  it("opens exactly beforeMs ahead", () => {
    expect(at("2026-09-16T17:30:00Z")?.name).toBe("FOMC-2026-09");
  });
  it("is still open at the end of afterMs", () => {
    expect(at("2026-09-16T20:00:00Z")?.name).toBe("FOMC-2026-09");
  });
  it("is closed one millisecond past afterMs", () => {
    expect(at("2026-09-16T20:00:00.001Z")).toBeNull();
  });
});

describe("CalendarWindowWatcher", () => {
  it("fires once per event window and stays quiet on later ticks", async () => {
    const fired: TriggerEvent[] = [];
    let clock = Date.parse("2026-09-16T17:30:00Z");
    const watcher = new CalendarWindowWatcher({
      job: "macro-watch",
      trigger,
      events: parseCalendar(YAML, "us-macro.yaml"),
      store: new StateStore(mkdtempSync(join(tmpdir(), "helium-cal-"))),
      onTrigger: (ev) => {
        fired.push(ev);
      },
      now: () => new Date(clock),
    });

    expect((await watcher.tick())?.name).toBe("FOMC-2026-09");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.kind).toBe("calendar-window");
    expect(fired[0]?.dedupKey).toBe("macro-watch:calendar-window:FOMC-2026-09");
    expect(fired[0]?.payload.calendarEvent).toMatchObject({ kind: "FOMC" });

    clock += 600_000;
    expect((await watcher.tick())?.name).toBe("FOMC-2026-09");
    expect(fired).toHaveLength(1);

    clock = Date.parse("2026-09-17T00:00:00Z");
    expect(await watcher.tick()).toBeNull();
    expect(fired).toHaveLength(1);
  });

  it("currentWindow reports the open window without dedup or dispatch side effects", () => {
    let clock = Date.parse("2026-09-16T17:00:00Z"); // 60m early, outside the window
    const fired: TriggerEvent[] = [];
    const watcher = new CalendarWindowWatcher({
      job: "macro-watch",
      trigger,
      events: parseCalendar(YAML, "us-macro.yaml"),
      store: new StateStore(mkdtempSync(join(tmpdir(), "helium-cal-"))),
      onTrigger: (ev) => {
        fired.push(ev);
      },
      now: () => new Date(clock),
    });

    expect(watcher.currentWindow()).toBeNull();

    clock = Date.parse("2026-09-16T17:30:00Z"); // window opens
    expect(watcher.currentWindow()?.name).toBe("FOMC-2026-09");
    expect(fired).toHaveLength(0);

    clock = Date.parse("2026-09-17T00:00:00Z"); // well past the window
    expect(watcher.currentWindow()).toBeNull();
  });
});
