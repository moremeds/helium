import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apexBarSource,
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

describe("the apex query", () => {
  // The mode is the whole test. Verified against the live apex 2026-09-06:
  // `price_mode=adjusted` truncated SPY's daily series at 2026-08-28 while
  // `raw` reached 2026-09-04, and 1m adjusted is refused outright — a settler
  // on `adjusted` reports `pending` forever on exactly the sessions it exists
  // to settle.
  it("asks apex for raw prices, in both timeframes", async () => {
    const seen: string[] = [];
    const fake: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ bars: [] }), { status: 200 });
    };
    const source = apexBarSource("http://apex.invalid", fake);
    await source.bars1m("SPY", "2026-09-02", "2026-09-03");
    await source.bars1d("SPY", "2026-09-02", "2026-09-03");
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url).toContain("price_mode=raw");
      expect(url).not.toContain("adjusted");
    }
    expect(seen[0]).toContain("timeframe=1m");
    expect(seen[1]).toContain("timeframe=1d");
  });

  it("keys a daily bar by its own UTC date, never by the ET session", async () => {
    // apex serves a daily bar as UTC midnight of the trade date: the real
    // 2026-09-03 row came back as `2026-09-03T00:00:00+00:00` with close
    // 773.17, the same close the lake holds under `trade_date` 2026-09-03.
    // Through an ET session that instant is 20:00 on 09-02, which would move
    // every daily bar back a day and settle every horizon one session early.
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          bars: [
            {
              time: "2026-09-03T00:00:00+00:00",
              open: 767.9,
              high: 774.03,
              low: 767.45,
              close: 773.17,
              volume: 43531581,
            },
          ],
        }),
        { status: 200 },
      );
    const daily = await apexBarSource("http://apex.invalid", fake).bars1d(
      "SPY",
      "2026-09-03",
      "2026-09-03",
    );
    expect(daily.map((bar) => bar.time)).toEqual(["2026-09-03"]);
    expect(daily[0]!.close).toBe(773.17);
  });

  it("names the status when apex refuses", async () => {
    const fake: typeof fetch = async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" });
    await expect(
      apexBarSource("http://apex.invalid", fake).bars1d("SPY", "2026-09-02", "2026-09-03"),
    ).rejects.toThrow("500");
  });
});
