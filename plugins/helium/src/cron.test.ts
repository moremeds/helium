import { describe, expect, it } from "vitest";
import { buildCronEvent, nextCronRun } from "./cron.js";

describe("nextCronRun", () => {
  it("resolves 17:00 America/New_York to 21:00Z during EDT", () => {
    expect(
      nextCronRun(
        "0 17 * * 1-5",
        "America/New_York",
        new Date("2026-08-24T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-08-24T21:00:00.000Z");
  });
  it("resolves the same schedule to 22:00Z during EST", () => {
    expect(
      nextCronRun(
        "0 17 * * 1-5",
        "America/New_York",
        new Date("2026-12-01T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-12-01T22:00:00.000Z");
  });
  it("skips to the next weekday once the current run has passed", () => {
    expect(
      nextCronRun(
        "0 17 * * 1-5",
        "America/New_York",
        new Date("2026-08-24T21:30:00Z"),
      )?.toISOString(),
    ).toBe("2026-08-25T21:00:00.000Z");
  });
  it("throws on a junk schedule", () => {
    expect(() =>
      nextCronRun("not a cron", "America/New_York", new Date()),
    ).toThrow();
  });
});

describe("buildCronEvent", () => {
  it("stamps UTC and derives a per-minute dedup key", () => {
    const ev = buildCronEvent("alpha", new Date("2026-08-24T21:00:00.000Z"));
    expect(ev.kind).toBe("cron");
    expect(ev.tenant).toBe("alpha");
    expect(ev.dedupKey).toBe("alpha:cron:2026-08-24T21:00Z");
    expect(ev.payload).toEqual({ scheduledFor: "2026-08-24T21:00:00.000Z" });
  });
});
