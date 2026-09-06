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
import { coverageRows } from "../quality/channels.js";
import { basketExcess, rotationTable, themeRow } from "../quality/themes.js";

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

describe("rotationTable", () => {
  /**
   * Real daily closes recorded live from apex on 2026-09-06
   * (`rotation-closes-2026-08-28.json`). XLE's series really does stop at
   * 2026-07-13 in that lake — that gap is the `untested` case, and it is
   * observed rather than constructed.
   */
  const rotation = (
    JSON.parse(
      readFileSync(join(FIX, "rotation-closes-2026-08-28.json"), "utf8"),
    ) as { closes: Record<string, Record<string, number>> }
  ).closes;

  const barMap = (): Map<string, Bar[]> => {
    const map = new Map<string, Bar[]>();
    for (const [symbol, series] of Object.entries(rotation))
      map.set(
        symbol,
        Object.entries(series)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([time, close]) => ({
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: 0,
          })),
      );
    return map;
  };

  const SECTORS = [
    "XLB",
    "XLC",
    "XLE",
    "XLF",
    "XLI",
    "XLK",
    "XLP",
    "XLRE",
    "XLU",
    "XLV",
    "XLY",
  ];
  const AG: ThemeSpec = {
    id: "el-nino-ag-2026",
    thesis: "ag inputs",
    horizon: "6m",
    entered: "2026-05-01",
    instruments: ["DBA", "MOS", "NTR", "DE"],
    evidence: [{ text: "ONI" }],
    kill: "underperforms SPY by 10% over 60 sessions",
  };
  const DAY = "2026-08-28";
  /** Weekday walk. The table's own calendar is injected, never derived here. */
  const openDaysBack = (from: string, n: number): string => {
    const cursor = new Date(`${from}T00:00:00Z`);
    let left = n;
    while (left > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) left -= 1;
    }
    return cursor.toISOString().slice(0, 10);
  };

  const table = () =>
    rotationTable({
      sectorEtfs: SECTORS,
      themes: [AG],
      benchmark: "SPY",
      lookbacks: { w1: 5, w4: 20, w12: 60 },
      bars: barMap(),
      day: DAY,
      openDaysBack,
    });

  it("prints one row per sector and one per theme, never fewer", () => {
    const out = table();
    expect(out.rows.length).toBe(SECTORS.length + 1);
    expect(out.rows.map((row) => row.symbol).sort()).toEqual(
      [...SECTORS, "theme:el-nino-ag-2026"].sort(),
    );
    expect(out.asOf).toBe(DAY);
    expect(out.benchmark).toBe("SPY");
  });

  it("keeps a symbol whose series stopped, as untested with the reason", () => {
    const out = table();
    const xle = out.rows.find((row) => row.symbol === "XLE");
    expect(xle).toBeDefined();
    expect(xle?.untested).toContain("2026-07-13");
    expect(xle?.excess1w).toBeNull();
    expect(out.notes.join(" ")).toContain("XLE");
  });

  it("ranks by the one-week excess, nulls last, ties by symbol", () => {
    const rows = table().rows;
    const scored = rows.filter((row) => row.excess1w !== null);
    for (let i = 1; i < scored.length; i += 1)
      expect(scored[i - 1]!.excess1w!).toBeGreaterThanOrEqual(
        scored[i]!.excess1w!,
      );
    expect(rows.at(-1)?.excess1w).toBeNull();
  });

  it("returns the benchmark's own moves on the result, not as a row", () => {
    const out = table();
    expect(out.rows.some((row) => row.symbol === "SPY")).toBe(false);
    expect(out.benchmarkReturns.w1).not.toBeNull();
    // Every excess is the row's own return minus the benchmark's. Compared at
    // 3 decimals, not 4: the excess is rounded from the UNROUNDED difference,
    // so subtracting the two rounded columns can differ in the last digit.
    const xlk = out.rows.find((row) => row.symbol === "XLK")!;
    expect(xlk.excess1w).toBeCloseTo(xlk.w1! - out.benchmarkReturns.w1!, 3);
  });
});

/**
 * The coverage rows and the rotation table price the same baskets, so they
 * must agree to the last digit — otherwise §3b/§3c and §3d of one document
 * disagree about one week.
 *
 * THE 2026-09-06 DEFECT. `ow_session_frame` never supplied `themeBars` or
 * `weekFrom`, so all ten sector rows read "no weekly bars for the chain
 * members" and the theme row "no bars for 4 of 4 instruments" — while
 * ow_rotation, in the same run, priced that theme at +3.4072 four-week excess
 * off bars it fetched itself.
 */
describe("coverage rows priced from the same bars as the rotation table", () => {
  const rotationCloses = (
    JSON.parse(
      readFileSync(join(FIX, "rotation-closes-2026-08-28.json"), "utf8"),
    ) as { closes: Record<string, Record<string, number>> }
  ).closes;
  const barsBySymbol = (): Map<string, Bar[]> => {
    const map = new Map<string, Bar[]>();
    for (const [symbol, series] of Object.entries(rotationCloses))
      map.set(
        symbol,
        Object.entries(series)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([time, close]) => ({
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: 0,
          })),
      );
    return map;
  };
  const back = (from: string, n: number): string => {
    const cursor = new Date(`${from}T00:00:00Z`);
    let left = n;
    while (left > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) left -= 1;
    }
    return cursor.toISOString().slice(0, 10);
  };
  const THEME: ThemeSpec = {
    id: "el-nino-ag-2026",
    thesis: "ag inputs",
    horizon: "6m",
    entered: "2026-05-01",
    instruments: ["DBA", "MOS", "NTR", "DE"],
    evidence: [{ text: "ONI" }],
    kill: "underperforms SPY by 10% over 60 sessions",
  };
  // The lake stops on 2026-08-28; the run is 2026-09-06. Measuring the week to
  // the RUN day would silently report a perfectly calm 0.00 %.
  const RUN_DAY = "2026-09-06";
  const BARS_AS_OF = "2026-08-28";
  const WEEK_FROM = back(BARS_AS_OF, 6);

  const rows = () =>
    coverageRows(
      {
        day: RUN_DAY,
        barsAsOf: BARS_AS_OF,
        weekFrom: WEEK_FROM,
        benchmark: "SPY",
        themeBars: barsBySymbol(),
        watchlist: {
          chains: [
            {
              chain: "Bench",
              members: ["XLK", "XLF"],
              asOf: "2026-09-05T03:10:57.319519+08:00",
            },
          ],
        },
      },
      { coverage: [], sectors: ["Bench"], themes: [THEME] },
    );

  it("gives a sector row a weekly percent, dated by the bars and not by the scan", () => {
    const row = rows().find((entry) => entry.id === "sector:Bench")!;
    expect(row.untested).toBeUndefined();
    expect(row.members).toEqual(["XLK", "XLF"]);
    expect(row.asOf).toBe(BARS_AS_OF);
    expect(row.move).toContain("% vs SPY (2 of 2)");
    const expected = basketExcess({
      members: ["XLK", "XLF"],
      benchmark: "SPY",
      bars: barsBySymbol(),
      fromDay: WEEK_FROM,
      toDay: BARS_AS_OF,
    })!;
    expect(row.delta).toBe(expected.excessPct);
    expect(row.level).toBe(String(expected.basketPct));
  });

  it("gives the theme row the same 1w excess the rotation table prints", () => {
    const row = rows().find((entry) => entry.id === `theme:${THEME.id}`)!;
    const table = rotationTable({
      sectorEtfs: [],
      themes: [THEME],
      benchmark: "SPY",
      lookbacks: { w1: 5, w4: 20, w12: 60 },
      bars: barsBySymbol(),
      day: RUN_DAY,
      openDaysBack: (from, n) => back(from, n + 1),
    });
    const rotationRow = table.rows.find(
      (entry) => entry.symbol === `theme:${THEME.id}`,
    )!;
    expect(table.asOf).toBe(BARS_AS_OF);
    expect(row.untested).toBeUndefined();
    expect(row.asOf).toBe(BARS_AS_OF);
    expect(row.theme?.week?.excessPct).toBe(rotationRow.excess1w);
    expect(row.delta).toBe(rotationRow.excess1w);
  });
});
