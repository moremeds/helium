/**
 * `ow_event_day` — the event day's member-level cross-section (#107 item 2).
 *
 * The closes are REAL adjusted closes recorded live from apex on the mini on
 * 2026-09-09 (`fixtures/review/event-day-closes-2026-09-04.json`, apex 0.1.5,
 * silver adjustment_revision 41). Nothing here reaches the network: apex and
 * argon are both answered through the tool's own `fetchImpl` seam.
 *
 * WHAT THIS SUITE IS FOR. On 2026-09-08 the premarket page said "hardware
 * rallies into the market" and named two semis, printing "NVDA +230.36
 * (+0.84%)" — a close rendered as a change. On that same day, inside its own
 * basket, NVDA's +0.84 % was SIXTH of seven. The tests below pin that: the
 * whole basket is priced, every member has a rank, and the two ends are a
 * summary of the table rather than the table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import { buildTools } from "../tools/index.js";

const FIX = join(__dirname, "fixtures", "review");
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const CLOSES = (
  read("event-day-closes-2026-09-04.json") as {
    closes: Record<string, Record<string, number>>;
  }
).closes;
const CHAINS = read("watchlist-chains.json");
const BY_CHAIN: Record<string, unknown> = {
  "Computer/GPU": read("watchlist-Computer-GPU.json"),
  Cybersecurity: read("watchlist-Cybersecurity.json"),
};

const TENANT = join(__dirname, "..", "tenant.yaml");
const extensions = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT)
  .extensions as Record<string, unknown>;

const APEX = "http://apex.test";
const ARGON = "http://argon.test";

/** apex 0.1.6's `/v1/equity/returns`, built from the SAME real closes — the
 *  contract in #107's comments, with no invented price in it. Only used by the
 *  one test that proves the preferred path is read verbatim. */
function returnsBody(symbols: string[], start: string, end: string): unknown {
  const dates = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
  const results = [];
  const missing = [];
  for (const symbol of symbols) {
    const closes = CLOSES[symbol];
    if (closes === undefined) {
      missing.push({ symbol, reason: "no adjusted series" });
      continue;
    }
    // The endpoint measures each day against the PREVIOUS close, so the walk
    // starts at the close before the window (2026-08-28, the prior Friday) and
    // only the days inside `[start, end]` are emitted.
    let prior = closes["2026-08-28"]!;
    const daily = [];
    for (const date of dates) {
      const close = closes[date]!;
      const ret = close / prior - 1;
      prior = close;
      if (date >= start && date <= end) daily.push({ date, close, return: ret });
    }
    results.push({ symbol, daily, window_return: null, ytd_return: null });
  }
  return { start, end, price_mode: "adjusted", results, missing };
}

/** apex and argon on one seam. `returns` switches the preferred path on; the
 *  default is the mini's own 2026-09-09 behaviour, a 404 on that route. */
function serve(
  options: { returns?: boolean; minuteBars?: number; refuse?: string[] } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.host === "argon.test") {
      if (url.pathname === "/api/watchlist/chains")
        return new Response(JSON.stringify(CHAINS), { status: 200 });
      const chain = url.searchParams.get("chain") ?? "";
      const body = BY_CHAIN[chain];
      if (body === undefined)
        return new Response("no such chain", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.pathname === "/v1/equity/returns") {
      if (options.returns !== true)
        // Verbatim from the mini on 2026-09-09 (apex 0.1.5).
        return new Response(
          JSON.stringify({
            error: {
              code: "unknown_symbol",
              message: "no artifact for returns under asset_class=equity",
              symbol: "returns",
              asset_class: "equity",
            },
          }),
          { status: 404, statusText: "Not Found" },
        );
      const symbols = (url.searchParams.get("symbols") ?? "").split(",");
      return new Response(
        JSON.stringify(
          returnsBody(
            symbols,
            url.searchParams.get("start")!,
            url.searchParams.get("end")!,
          ),
        ),
        { status: 200 },
      );
    }
    const symbol = url.pathname.split("/")[3] ?? "";
    if (options.refuse?.includes(symbol) === true)
      return new Response("nope", { status: 500, statusText: "Server Error" });
    if (url.searchParams.get("timeframe") === "1m") {
      const count = options.minuteBars ?? 0;
      return new Response(
        JSON.stringify({
          symbol,
          timeframe: "1m",
          count,
          bars: Array.from({ length: count }, (_unused, index) => ({
            // The real 12:25:00Z..12:35:00Z window, both ends inclusive.
            time: `2026-09-04T12:${String(25 + index).padStart(2, "0")}:00+00:00`,
            open: 773.3,
            high: 773.4109,
            low: 771.46,
            close: 773.4109,
            volume: 343,
          })),
        }),
        { status: 200 },
      );
    }
    const closes = CLOSES[symbol];
    if (closes === undefined)
      return new Response("no such symbol", { status: 404, statusText: "Not Found" });
    return new Response(
      JSON.stringify({
        symbol,
        bars: Object.entries(closes)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([time, close]) => ({
            time: `${time}T00:00:00+00:00`,
            open: close,
            high: close,
            low: close,
            close,
            volume: 0,
          })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

type Member = {
  symbol: string;
  ret: number | null;
  excess_vs_basket: number | null;
  rank: number | null;
};
type Basket = {
  id: string;
  ret: number | null;
  excess_vs_spy: number | null;
  members: Member[];
  weakest: string | null;
  strongest: string | null;
  priced: string;
};
type Table = {
  date: string;
  pickedBy: string;
  window: { start: string; end: string };
  benchmarks: Record<string, number | null>;
  baskets: Basket[];
  crossSection: Array<{
    symbol: string;
    ret: number | null;
    excess_vs_spy: number | null;
  }>;
  missing: Array<{ symbol: string; reason: string }>;
  notes: string[];
  source: string;
  intraday?: { symbol: string; bars: unknown[]; note: string };
};

async function eventDay(
  args: Record<string, unknown> = {},
  options: { returns?: boolean; minuteBars?: number; refuse?: string[] } = {},
): Promise<Table> {
  const tool = buildTools({
    stateRoot: "/nonexistent",
    env: { OW_APEX_API_BASE: APEX, OW_ARGON_API_BASE: ARGON },
    extensions,
    // Friday 2026-09-04, 20:15 ET — the session the fixture ends on.
    asOf: new Date("2026-09-05T00:15:00.000Z"),
    calendar: { weekdaysOnly: true, closed: [] },
  }).find((entry) => entry.name === "ow_event_day");
  if (tool === undefined) throw new Error("ow_event_day is not built");
  return JSON.parse(
    await tool.run(args, { fetchImpl: serve(options) }),
  ) as Table;
}

/** apex publishes four decimals; the tool publishes the full quotient. */
const four = (value: number | null): number | null =>
  value === null ? null : Number(value.toFixed(4));

const basketOf = (table: Table, id: string): Basket => {
  const found = table.baskets.find((basket) => basket.id === id);
  if (found === undefined) throw new Error(`no basket ${id}`);
  return found;
};

describe("ow_event_day", () => {
  it("picks the day a basket moved furthest from SPY, and says which", async () => {
    const table = await eventDay();
    // Over 2026-08-31..09-04 the widest spread is the ag theme on 09-01:
    // basket +2.3521 % against SPY -0.6870 %, a 0.0304 gap. Computer/GPU's
    // widest is 09-02 at 0.0288 — the pick is arithmetic, not the day with
    // the loudest tape.
    expect(table.date).toBe("2026-09-01");
    expect(table.pickedBy).toContain("theme:el-nino-ag-2026");
    expect(table.pickedBy).toContain("0.0304");
    expect(table.window).toEqual({
      start: "2026-08-31",
      end: "2026-09-04",
    });
  });

  it("takes the caller's date instead, and says so", async () => {
    const table = await eventDay({ date: "2026-09-04" });
    expect(table.date).toBe("2026-09-04");
    expect(table.pickedBy).toBe("the caller named this date");
    expect(four(table.benchmarks.SPY)).toBe(-0.0039);
    expect(four(table.benchmarks.QQQ)).toBe(0.0018);
  });

  it("prices EVERY member of the basket, ranked, not two names", async () => {
    // 2026-09-04, the day the page called a hardware rally.
    const table = await eventDay({ date: "2026-09-04" });
    const gpu = basketOf(table, "Computer/GPU");
    expect(gpu.priced).toBe("7 of 7");
    expect(gpu.members.map((row) => row.symbol)).toEqual([
      "AMD",
      "SMCI",
      "ARM",
      "HPQ",
      "DELL",
      "NVDA",
      "HPE",
    ]);
    expect(gpu.members.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(four(gpu.ret)).toBe(0.0189);
    expect(four(gpu.excess_vs_spy)).toBe(0.0228);
    // NVDA closed at 230.36 that day, +0.84 % — and SIXTH of seven inside its
    // own basket, which is the fact the two-name paragraph hid.
    const nvda = gpu.members.find((row) => row.symbol === "NVDA")!;
    expect(four(nvda.ret)).toBe(0.0084);
    expect(four(nvda.excess_vs_basket)).toBe(-0.0105);
    expect(nvda.rank).toBe(6);
  });

  it("summarises the two ends without replacing the rows", async () => {
    const gpu = basketOf(await eventDay({ date: "2026-09-04" }), "Computer/GPU");
    expect(gpu.strongest).toBe("AMD");
    expect(gpu.weakest).toBe("HPE");
    expect(four(gpu.members.find((row) => row.symbol === "AMD")!.ret)).toBe(
      0.0469,
    );
    expect(four(gpu.members.find((row) => row.symbol === "HPE")!.ret)).toBe(
      -0.0448,
    );
  });

  it("carries the declared cross-section, each against SPY", async () => {
    const table = await eventDay({ date: "2026-09-04" });
    const xlk = table.crossSection.find((row) => row.symbol === "XLK")!;
    expect(four(xlk.ret)).toBe(0.007);
    expect(four(xlk.excess_vs_spy)).toBe(0.0109);
    // The eleven declared sector ETFs plus the theme's four instruments.
    expect(table.crossSection).toHaveLength(15);
  });

  it("takes an operator's extra tickers rather than inventing any", async () => {
    const table = await eventDay({
      date: "2026-09-04",
      symbolsExtra: ["DBA"],
    });
    expect(table.crossSection).toHaveLength(15); // already declared, not doubled
    expect(
      table.crossSection.filter((row) => row.symbol === "DBA"),
    ).toHaveLength(1);
  });

  it("leaves a basket the source cannot price null, never zero", async () => {
    const table = await eventDay({ date: "2026-09-04" });
    const cyber = basketOf(table, "Cybersecurity");
    expect(cyber.priced).toBe("0 of 13");
    expect(cyber.ret).toBeNull();
    expect(cyber.excess_vs_spy).toBeNull();
    expect(cyber.weakest).toBeNull();
    expect(cyber.strongest).toBeNull();
    expect(cyber.members.every((row) => row.ret === null)).toBe(true);
    expect(cyber.members.every((row) => row.rank === null)).toBe(true);
    const crwd = table.missing.find((row) => row.symbol === "CRWD");
    expect(crwd?.reason).toContain("404");
  });

  it("reports a symbol apex refuses as missing, and ranks the rest", async () => {
    const table = await eventDay({ date: "2026-09-04" }, { refuse: ["NVDA"] });
    const gpu = basketOf(table, "Computer/GPU");
    expect(gpu.priced).toBe("6 of 7");
    const nvda = gpu.members.find((row) => row.symbol === "NVDA")!;
    expect(nvda.ret).toBeNull();
    expect(nvda.rank).toBeNull();
    expect(nvda.excess_vs_basket).toBeNull();
    expect(
      table.missing.find((row) => row.symbol === "NVDA")?.reason,
    ).toContain("500");
  });

  it("falls back to daily bars when /v1/equity/returns 404s", async () => {
    const table = await eventDay({ date: "2026-09-04" });
    expect(table.source).toBe("apex-bars-fallback");
    expect(table.notes.some((note) => note.includes("404"))).toBe(true);
  });

  it("reads apex 0.1.6's returns route verbatim when it answers", async () => {
    const table = await eventDay({ date: "2026-09-04" }, { returns: true });
    expect(table.source).toBe("apex-returns");
    // The same arithmetic off the same closes: the endpoint's arrival moves
    // `source` and nothing else.
    expect(four(basketOf(table, "Computer/GPU").ret)).toBe(0.0189);
    expect(four(table.benchmarks.SPY)).toBe(-0.0039);
    expect(table.missing.some((row) => row.symbol === "CRWD")).toBe(true);
  });

  it("attaches the 1m window only when asked, both ends inclusive", async () => {
    const plain = await eventDay({ date: "2026-09-04" });
    expect(plain.intraday).toBeUndefined();
    const windowed = await eventDay(
      {
        date: "2026-09-04",
        window: { start: "2026-09-04T12:25:00Z", end: "2026-09-04T12:35:00Z" },
      },
      { minuteBars: 11 },
    );
    // Eleven bars for a ten-minute window: verified live on 2026-09-09.
    expect(windowed.intraday?.symbol).toBe("SPY");
    expect(windowed.intraday?.bars).toHaveLength(11);
    expect(windowed.intraday?.note).toContain("inclusive");
  });

  it("keeps the day's table when the 1m window cannot be served", async () => {
    const table = await eventDay(
      {
        date: "2026-09-04",
        window: { start: "2026-09-04T12:25:00Z", end: "2026-09-04T12:35:00Z" },
      },
      { minuteBars: 0 },
    );
    expect(four(basketOf(table, "Computer/GPU").ret)).toBe(0.0189);
    expect(table.notes.some((note) => note.includes("no 1m bar"))).toBe(true);
  });
});
