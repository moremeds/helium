/**
 * `ow_stock_week` — the per-symbol week table (#107 item 1).
 *
 * The closes below are REAL adjusted closes read from apex on the mini on
 * 2026-09-08 (`GET /v1/equity/{sym}/bars?timeframe=1d&price_mode=adjusted`,
 * adjustment_revision 40). apex's own published check values for
 * 2026-08-31..2026-09-04 are SOXX +0.0221, SPY +0.0011, QQQ +0.0035,
 * MU +0.0898, SNDK +0.1717, and this suite is what proves the fallback
 * arithmetic reproduces them from those closes.
 *
 * Nothing here reaches the network: `ow_apex_bars` is answered from the frozen
 * closes through the tool's own `fetchImpl` seam.
 */
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

/** date -> close, verbatim from the bars response. */
const CLOSES: Record<string, Record<string, number>> = {
  SPY: {
    "2026-08-27": 771.1,
    "2026-08-28": 769.35,
    "2026-08-31": 767.05,
    "2026-09-01": 761.78,
    "2026-09-02": 765.16,
    "2026-09-03": 773.17,
    "2026-09-04": 770.19,
  },
  QQQ: {
    "2026-08-27": 721.11,
    "2026-08-28": 716.43,
    "2026-08-31": 716.76,
    "2026-09-01": 707.64,
    "2026-09-02": 709.24,
    "2026-09-03": 717.67,
    "2026-09-04": 718.96,
  },
  SOXX: {
    "2026-08-27": 525.43,
    "2026-08-28": 508.62,
    "2026-08-31": 511.04,
    "2026-09-01": 500.31,
    "2026-09-02": 501.44,
    "2026-09-03": 502.2,
    "2026-09-04": 519.86,
  },
  MU: {
    "2026-08-27": 935.39,
    "2026-08-28": 932.86,
    "2026-08-31": 958.73,
    "2026-09-01": 933.44,
    "2026-09-02": 956.08,
    "2026-09-03": 958.16,
    "2026-09-04": 1016.59,
  },
  SNDK: {
    "2026-08-27": 1484.95,
    "2026-08-28": 1484.98,
    "2026-08-31": 1566.7,
    "2026-09-01": 1536.87,
    "2026-09-02": 1553.4,
    "2026-09-03": 1554.99,
    "2026-09-04": 1740.0,
  },
  /** A symbol whose lake series stops before the window — the shape the SMH
   *  Silver gap had on 2026-09-08, before revision 40 rebuilt it. */
  GAPPY: { "2026-08-27": 553.11, "2026-08-28": 553.11 },
};

const fetchImpl = (refuse: ReadonlySet<string> = new Set()): typeof fetch =>
  (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const symbol = url.pathname.split("/")[3] ?? "";
    if (refuse.has(symbol))
      return new Response("nope", { status: 500, statusText: "Server Error" });
    const bars = Object.entries(CLOSES[symbol] ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, close]) => ({
        time: `${time}T00:00:00+00:00`,
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
      }));
    if (bars.length === 0)
      return new Response("[]", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify({ symbol, bars }), { status: 200 });
  }) as unknown as typeof fetch;

type Table = {
  start: string;
  end: string;
  source: string;
  benchmarks: Record<string, { window_return: number | null }>;
  results: Array<{
    symbol: string;
    window_return: number | null;
    excess_vs_spy: number | null;
    excess_vs_qqq: number | null;
    ytd_return: number | null;
    pct_from_52w_high: number | null;
    daily: Array<{ date: string; close: number | null; return: number | null }>;
  }>;
  missing: Array<{ symbol: string; reason: string }>;
};

const week = async (
  symbols: string[],
  refuse: ReadonlySet<string> = new Set(),
): Promise<Table> => {
  const tool = buildTools({
    stateRoot: "/tmp/ow-stock-week",
    env: { OW_APEX_API_BASE: "http://apex.invalid:8322" },
    // The clock is pinned so the lookback is measured from the same instant
    // every run: the Friday of the week under test, 20:15 ET.
    asOf: new Date("2026-09-05T00:15:00.000Z"),
  }).find((entry) => entry.name === "ow_stock_week");
  if (tool === undefined) throw new Error("ow_stock_week is not built");
  return JSON.parse(
    await tool.run(
      { symbols, start: "2026-08-31", end: "2026-09-04" },
      { fetchImpl: fetchImpl(refuse) },
    ),
  ) as Table;
};

/** apex publishes four decimals; the fallback publishes the full quotient. */
const four = (value: number | null): number | null =>
  value === null ? null : Number(value.toFixed(4));

describe("ow_stock_week", () => {
  it("reproduces apex's own week returns from the same closes", async () => {
    const table = await week(["SOXX", "MU", "SNDK"]);
    const by = new Map(table.results.map((row) => [row.symbol, row]));
    expect(four(by.get("SOXX")!.window_return)).toBe(0.0221);
    expect(four(by.get("MU")!.window_return)).toBe(0.0898);
    expect(four(by.get("SNDK")!.window_return)).toBe(0.1717);
    expect(four(table.benchmarks.SPY!.window_return)).toBe(0.0011);
    expect(four(table.benchmarks.QQQ!.window_return)).toBe(0.0035);
    expect(table.source).toBe("apex-bars-fallback");
  });

  it("measures from the prior Friday's close, not from Monday's", async () => {
    const table = await week(["SOXX"]);
    const soxx = table.results[0]!;
    // 519.86 / 508.62 (2026-08-28) - 1, NOT 519.86 / 511.04 (+1.73%).
    expect(four(soxx.window_return)).toBe(0.0221);
    expect(soxx.daily.map((row) => row.date)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    // The first day's return is measured off the prior Friday too.
    expect(four(soxx.daily[0]!.return)).toBe(0.0048);
    expect(soxx.daily[4]!.close).toBe(519.86);
    // The daily returns compound back to the window return.
    const compounded = soxx.daily.reduce(
      (carry, row) => carry * (1 + (row.return ?? 0)),
      1,
    );
    expect(four(compounded - 1)).toBe(0.0221);
  });

  it("subtracts the benchmark rather than making the model do it", async () => {
    const table = await week(["SNDK"]);
    const sndk = table.results[0]!;
    expect(four(sndk.excess_vs_spy)).toBe(0.1706);
    expect(four(sndk.excess_vs_qqq)).toBe(0.1682);
  });

  it("leaves ytd_return and pct_from_52w_high null on the fallback", async () => {
    const table = await week(["MU"]);
    expect(table.results[0]!.ytd_return).toBeNull();
    expect(table.results[0]!.pct_from_52w_high).toBeNull();
  });

  it("reports a symbol apex cannot serve as missing, never as zero", async () => {
    const table = await week(["SOXX", "SNDK"], new Set(["SNDK"]));
    expect(table.results.map((row) => row.symbol)).toEqual(["SOXX"]);
    expect(table.missing).toHaveLength(1);
    expect(table.missing[0]!.symbol).toBe("SNDK");
    expect(table.missing[0]!.reason).toContain("500");
  });

  it("reports a series that stops before the window as missing", async () => {
    const table = await week(["SOXX", "GAPPY"]);
    expect(table.results.map((row) => row.symbol)).toEqual(["SOXX"]);
    expect(table.missing).toEqual([
      {
        symbol: "GAPPY",
        reason: "no closes between 2026-08-31 and 2026-09-04",
      },
    ]);
  });
});

/**
 * The PREFERRED path, live on the mini since apex 0.1.6 (switched 2026-09-09).
 *
 * The route computes every metric itself (`src/api/routes/returns.py:97-220`,
 * read 2026-09-09), so the tool's job here is to COPY. The exact live payload
 * text is not in this repo, so this fixture is built from the same frozen
 * adjusted closes above — real prices — and the assertions are pass-through:
 * each field comes out of the tool byte-identical to the field that went in,
 * including the nulls. apex's own published check values for this week are SPY
 * +0.0011 and SNDK +0.1717, and helium1 verified the live route for the same
 * window (SMH +2.51%, SPY +0.11%, `missing` empty).
 */
describe("ow_stock_week on apex /v1/equity/returns", () => {
  const dailyFor = (symbol: string) => {
    const dates = Object.keys(CLOSES[symbol] ?? {}).sort();
    const out: Array<{ date: string; close: number; return: number }> = [];
    for (let i = 1; i < dates.length; i += 1) {
      const date = dates[i]!;
      if (date < "2026-08-31" || date > "2026-09-04") continue;
      const close = CLOSES[symbol]![date]!;
      const prior = CLOSES[symbol]![dates[i - 1]!]!;
      out.push({ date, close, return: close / prior - 1 });
    }
    return out;
  };

  /** The whole payload the stub serves, so a test can assert against the very
   *  object the tool was handed. */
  const SERVED = (() => {
    const windowReturn = (symbol: string) => {
      const dates = Object.keys(CLOSES[symbol] ?? {}).sort();
      const inside = dates.filter((d) => d >= "2026-08-31" && d <= "2026-09-04");
      const base = dates.filter((d) => d < "2026-08-31").pop();
      if (base === undefined || inside.length === 0) return null;
      return (
        CLOSES[symbol]![inside[inside.length - 1]!]! / CLOSES[symbol]![base]! - 1
      );
    };
    const spy = windowReturn("SPY");
    const qqq = windowReturn("QQQ");
    const row = (symbol: string) => {
      const value = windowReturn(symbol);
      return {
        symbol,
        daily: dailyFor(symbol),
        window_return: value,
        // The route serves these two; the bars fallback cannot. A null here is
        // a real answer (`_pct` returns None on a missing base close), never a
        // zero.
        ytd_return: 0.4213,
        pct_from_52w_high: null,
        excess_vs_spy: value === null || spy === null ? null : value - spy,
        excess_vs_qqq: value === null || qqq === null ? null : value - qqq,
      };
    };
    return {
      start: "2026-08-31",
      end: "2026-09-04",
      price_mode: "adjusted",
      benchmarks: {
        SPY: { window_return: spy },
        QQQ: { window_return: qqq },
      },
      // The tool asks for the benchmarks as ordinary symbols too, and the
      // route answers a row for every symbol in `symbols=` — so the stub does.
      rows: {
        SPY: row("SPY"),
        QQQ: row("QQQ"),
        SNDK: row("SNDK"),
        MU: row("MU"),
      },
    };
  })();

  const returnsFetch: typeof fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/equity/returns")
      return new Response("nope", { status: 404, statusText: "Not Found" });
    // `symbols` is a comma list; a singular `symbol=` is a 400 on the live
    // endpoint, which is why the client never sends one.
    expect(url.searchParams.get("symbol")).toBeNull();
    const asked = (url.searchParams.get("symbols") ?? "").split(",");
    expect(url.searchParams.get("start")).toBe("2026-08-31");
    expect(url.searchParams.get("end")).toBe("2026-09-04");
    return new Response(
      JSON.stringify({
        start: SERVED.start,
        end: SERVED.end,
        price_mode: SERVED.price_mode,
        generated_at: "2026-09-09T00:00:00+00:00",
        benchmarks: SERVED.benchmarks,
        results: asked.flatMap((symbol) =>
          symbol in SERVED.rows
            ? [SERVED.rows[symbol as keyof typeof SERVED.rows]]
            : [],
        ),
        missing: [],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  it("prices from the endpoint and says so in `source`", async () => {
    const tool = buildTools({
      stateRoot: "/tmp/ow-stock-week",
      env: { OW_APEX_API_BASE: "http://apex.invalid:8322" },
      asOf: new Date("2026-09-05T00:15:00.000Z"),
    }).find((entry) => entry.name === "ow_stock_week");
    if (tool === undefined) throw new Error("ow_stock_week is not built");
    const table = JSON.parse(
      await tool.run(
        { symbols: ["SNDK", "MU"], start: "2026-08-31", end: "2026-09-04" },
        { fetchImpl: returnsFetch } as never,
      ),
    ) as Table;
    expect(table.source).toBe("apex-returns");
    // BENCHMARKS COME FROM THE PAYLOAD'S OWN BLOCK, not from a row the tool
    // re-derived. The value is the one the bars path produced on 2026-09-08 and
    // froze into docs/evidence/flash-samples/2026-09-06-weekly-v2, so the
    // switch is a source change and not a number change.
    expect(table.benchmarks.SPY?.window_return).toBe(
      SERVED.benchmarks.SPY.window_return,
    );
    expect(table.benchmarks.SPY?.window_return).toBe(0.0010918307662313165);
    const sndk = table.results.find((row) => row.symbol === "SNDK");
    const served = SERVED.rows.SNDK;
    // PASS-THROUGH, field for field, including the null. Nothing is rounded,
    // recomputed or filled in.
    expect(sndk?.window_return).toBe(served.window_return);
    expect(sndk?.excess_vs_spy).toBe(served.excess_vs_spy);
    expect(sndk?.excess_vs_qqq).toBe(served.excess_vs_qqq);
    expect(sndk?.ytd_return).toBe(0.4213);
    expect(sndk?.pct_from_52w_high).toBeNull();
    expect(table.missing).toEqual([]);
  });

  it("falls back to daily bars on a non-200, and marks the source", async () => {
    const table = await week(["SNDK"]);
    expect(table.source).toBe("apex-bars-fallback");
    const sndk = table.results.find((row) => row.symbol === "SNDK");
    expect(sndk?.window_return).toBeCloseTo(0.1717, 4);
    // The fallback computes no YTD and no 52-week high, and says so rather
    // than serving a zero.
    expect(sndk?.ytd_return).toBeNull();
    expect(sndk?.pct_from_52w_high).toBeNull();
  });
});
