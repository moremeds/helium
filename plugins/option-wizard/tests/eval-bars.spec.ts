import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  etSession,
  fixtureBarSource,
  MIN_RTH_BARS,
  missingWeekdays,
  rthSessions,
  RTH_CLOSE,
  RTH_OPEN,
} from "../eval/bars.js";

const doc = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/spy-bars-2026-09-02_03.json"),
    "utf8",
  ),
) as {
  bars1m: Array<{ time: string }>;
  bars1d: Array<{ time: string; close: number }>;
};

describe("ET sessions", () => {
  it("the fixture is real, frozen, and covers two full ET sessions", () => {
    const sessions = rthSessions(doc.bars1m as never);
    expect([...sessions.keys()]).toEqual(["2026-09-02", "2026-09-03"]);
    expect(sessions.get("2026-09-02")!.length).toBe(390);
    expect(sessions.get("2026-09-03")!.length).toBe(390);
    expect(MIN_RTH_BARS).toBe(380);
  });

  it("an ET session split across two HKT dates is ONE session", () => {
    // 2026-09-02 13:30Z is 09:30 ET, which is 2026-09-02 21:30 in Hong Kong;
    // 2026-09-02 19:59Z is 15:59 ET, which is 2026-09-03 03:59 in Hong Kong.
    expect(etSession("2026-09-02T13:30:00Z").date).toBe("2026-09-02");
    expect(etSession("2026-09-02T19:59:00Z").date).toBe("2026-09-02");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(
        new Date("2026-09-02T19:59:00Z"),
      ),
    ).toBe("2026-09-03");
  });

  it("marks the RTH window by minutes from ET midnight", () => {
    expect(RTH_OPEN).toBe(9 * 60 + 30);
    expect(RTH_CLOSE).toBe(16 * 60);
    expect(etSession("2026-09-02T13:30:00Z").minute).toBe(RTH_OPEN);
  });

  it("drops a pre-market print: 08:00 ET is outside the window", () => {
    const premarket = {
      time: "2026-09-02T12:00:00Z",
      open: 1,
      high: 999,
      low: 1,
      close: 1,
      volume: 1,
    };
    const sessions = rthSessions([premarket, ...(doc.bars1m as never[])] as never);
    expect(sessions.get("2026-09-02")!.length).toBe(390);
    expect(sessions.get("2026-09-02")!.some((bar) => bar.high === 999)).toBe(
      false,
    );
  });

  it("names an open weekday the lake has no daily bar for", () => {
    const have = ["2026-09-02"];
    expect(
      missingWeekdays(have, "2026-09-01", "2026-09-03", {
        weekdaysOnly: true,
        closed: [],
      }),
    ).toEqual(["2026-09-03"]);
  });

  it("says nothing about a day the tenant declared closed, or a weekend", () => {
    expect(
      missingWeekdays(["2026-09-02"], "2026-09-01", "2026-09-06", {
        weekdaysOnly: true,
        closed: ["2026-09-03", "2026-09-04"],
      }),
    ).toEqual([]);
  });

  it("no calendar means no cross-check: the bar count is the only guard", () => {
    expect(missingWeekdays([], "2026-09-01", "2026-09-03")).toEqual([]);
  });

  it("the fixture source serves 1m by ET session and 1d by date", async () => {
    const source = fixtureBarSource(doc as never);
    expect((await source.bars1m("SPY", "2026-09-03", "2026-09-03")).length).toBe(
      390,
    );
    const daily = await source.bars1d("SPY", "2026-08-26", "2026-09-03");
    expect(daily.length).toBe(doc.bars1d.length);
    expect(daily.at(-1)!.time).toBe("2026-09-03");
  });
});
