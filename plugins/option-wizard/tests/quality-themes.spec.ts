/**
 * The theme basket is the §H.2 excess-move triple. Every price here is a real
 * close from `tests/fixtures/review/closes-2026-09-03-04.json`; the thresholds
 * are declared numbers, not market data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bar } from "../eval/bars.js";
import type { ThemeSpec } from "../quality/review-config.js";
import { basketExcess, themeRow } from "../quality/themes.js";

const FIX = join(__dirname, "fixtures", "review");
const closes = (
  JSON.parse(readFileSync(join(FIX, "closes-2026-09-03-04.json"), "utf8")) as {
    closes: Record<string, Record<string, number>>;
  }
).closes;

/**
 * Only `close` is real and only `close` is read — `basketExcess` touches no
 * other field. The rest of `Bar` is structurally required, is set to the close
 * (volume 0), and nothing asserts on it. Inventing an open, a high, a low or a
 * volume would be synthetic market data.
 */
function bars(symbol: string): Bar[] {
  return Object.entries(closes[symbol] ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, close]) => ({
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    }));
}

const BARS: ReadonlyMap<string, readonly Bar[]> = new Map([
  ["SPY", bars("SPY")],
  ["QQQ", bars("QQQ")],
  ["IWM", bars("IWM")],
]);

const FROM = "2026-09-03";
const TO = "2026-09-04";

describe("basketExcess", () => {
  it("averages RETURNS, not prices, and measures the excess over the benchmark", () => {
    const out = basketExcess({
      members: ["QQQ", "IWM"],
      benchmark: "SPY",
      bars: BARS,
      fromDay: FROM,
      toDay: TO,
    })!;
    // QQQ 717.67 -> 718.96 = +0.1797%; IWM 295.19 -> 296.01 = +0.2778%.
    expect(out.basketPct).toBeCloseTo(0.2288, 4);
    // SPY 773.17 -> 770.19 = -0.3854%.
    expect(out.benchPct).toBeCloseTo(-0.3854, 4);
    expect(out.excessPct).toBeCloseTo(out.basketPct - out.benchPct, 10);
    expect(out.used).toEqual(["QQQ", "IWM"]);
    expect(out.missing).toEqual([]);
  });

  it("names a member with no bars and does not let it move the mean", () => {
    const out = basketExcess({
      members: ["QQQ", "IWM", "MOS"],
      benchmark: "SPY",
      bars: BARS,
      fromDay: FROM,
      toDay: TO,
    })!;
    expect(out.missing).toEqual(["MOS"]);
    expect(out.used).toEqual(["QQQ", "IWM"]);
    expect(out.basketPct).toBeCloseTo(0.2288, 4);
  });

  it("returns null, never 0, when nothing is computable", () => {
    expect(
      basketExcess({
        members: ["MOS", "NTR"],
        benchmark: "SPY",
        bars: BARS,
        fromDay: FROM,
        toDay: TO,
      }),
    ).toBeNull();
    expect(
      basketExcess({
        members: [],
        benchmark: "SPY",
        bars: BARS,
        fromDay: FROM,
        toDay: TO,
      }),
    ).toBeNull();
  });
});

describe("themeRow", () => {
  /** Real instruments, real closes; only the kill threshold is declared. */
  function theme(killExcess?: { pct: number; sessions: number }): ThemeSpec {
    return {
      id: "t-lagging-basket",
      thesis: "a basket that is losing to its benchmark",
      horizon: "6m",
      entered: FROM,
      instruments: ["SPY"],
      evidence: [{ text: "excess move vs QQQ" }],
      kill: "the basket underperforms QQQ by 0.5% over 60 sessions",
      ...(killExcess === undefined ? {} : { killExcess }),
    };
  }

  it("arms the kill and reports CONDITION MET when the declared excess is breached", () => {
    // SPY -0.3854% against QQQ +0.1797% is an excess of -0.5652%.
    const row = themeRow(
      theme({ pct: -0.5, sessions: 60 }),
      new Map([
        ["SPY", BARS.get("SPY")!],
        ["QQQ", BARS.get("QQQ")!],
      ]),
      TO,
      FROM,
      "QQQ",
    );
    expect(row.rowId).toBe("theme:t-lagging-basket");
    expect(row.week?.excessPct).toBeCloseTo(-0.5652, 4);
    expect(row.kill.met).toBe(true);
    expect(row.kill.why).toContain("-0.5652");
    expect(row.kill.why).toContain("60");
  });

  it("prints only the armed text when no killExcess is declared", () => {
    const row = themeRow(
      theme(),
      new Map([
        ["SPY", BARS.get("SPY")!],
        ["QQQ", BARS.get("QQQ")!],
      ]),
      TO,
      FROM,
      "QQQ",
    );
    expect(row.kill.met).toBe(false);
    expect(row.kill.why).toBeUndefined();
    expect(row.kill.armed).toContain("underperforms QQQ");
  });

  it("returns null horizons rather than zero when there are no bars", () => {
    const row = themeRow(theme(), new Map(), TO, FROM, "QQQ");
    expect(row.week).toBeNull();
    expect(row.sinceEntered).toBeNull();
    expect(row.kill.met).toBe(false);
  });
});
