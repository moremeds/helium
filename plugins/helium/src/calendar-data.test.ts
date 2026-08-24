import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCalendar } from "./calendar.js";

/**
 * Guard against a stale calendar shipping silently (Task 3.2). The shipped
 * `calendars/us-macro.yaml` must parse under the real `CalendarSchema`
 * (`parseCalendar`'s `EventSchema`), contain none of the brief's `1970-`
 * format-illustration rows, and have at least one event still in the future.
 */
const CALENDAR_FILE = fileURLToPath(
  new URL("../../../calendars/us-macro.yaml", import.meta.url),
);

describe("calendars/us-macro.yaml", () => {
  const text = readFileSync(CALENDAR_FILE, "utf8");

  it("contains no 1970- illustration timestamp", () => {
    expect(text).not.toMatch(/1970-/);
  });

  it("parses under the real CalendarSchema", () => {
    const events = parseCalendar(text, CALENDAR_FILE);
    expect(events.length).toBeGreaterThanOrEqual(6);
    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
      expect(["FOMC", "CPI", "NFP"]).toContain(event.kind);
    }
  });

  it("has at least one event in the future", () => {
    const events = parseCalendar(text, CALENDAR_FILE);
    const now = Date.now();
    expect(events.some((event) => Date.parse(event.at) > now)).toBe(true);
  });
});
