/**
 * option-wizard's tools (spec §3). All read-only; nothing here places, stages
 * or amends an order, and no tool with order semantics exists to be dropped.
 *
 * **The rule this file exists to enforce: a tool that cannot reach its system
 * throws.** It never returns a placeholder, a default, an empty-but-plausible
 * row or an invented number. One fabricated price would make every other
 * number in the daily email unusable, so absence is reported as absence — in
 * the style of a provider's `probeReason()`, naming the env var or the
 * host:port that is missing.
 * @module dsh-plugin-tenant-option-wizard/tools
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolRunContext, ToolVocabularyEntry } from "@helium/core";
import {
  ProposalSchema,
  evaluateProposal,
  tenantThresholds,
} from "../gates/ib-preflight.js";

const execFileAsync = promisify(execFile);

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["ow_tv_watchlist", { mutating: false, requiresEnv: "OW_TV_ENABLED" }],
  ["ow_spot", { mutating: false, requiresEnv: "OW_TV_ENABLED" }],
  ["ow_argon_metrics", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  ["ow_apex_bars", { mutating: false, requiresEnv: "OW_APEX_API_BASE" }],
  ["ow_ib_positions", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_uw_chain", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_ticker_metrics", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_market_state", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_macro_rates", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  ["ow_ib_preflight", { mutating: false }],
]);

type Env = Record<string, string | undefined>;

function need(env: Env, name: string, tool: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is unset; ${tool} has no live route`);
  }
  return value;
}

/**
 * IB, reached through xenon's read-only query API rather than through the TWS
 * wire protocol.
 *
 * xenon already holds live connections to IB Gateway 4001 and exposes them
 * over HTTP; re-implementing a framed binary client here would be a second
 * broker integration for this desk to keep correct. The key matters more than
 * the convenience: `XENON_QUERY_API_KEY` is authorised for a fixed allow-list
 * of read paths and is REFUSED (401) on every write path — `/orders/place`,
 * `/orders/cancel`, `/portfolio/sync`. So "this tenant can never place an
 * order" is enforced by the credential itself, not only by which tools exist
 * (spec §5). Verified against xenon `src/xenon/api/auth.py` and
 * `docs/reference/readonly-query-api.md`.
 *
 * Endpoints used, captured live 2026-09-02 against account U1***7831:
 *   GET /portfolio            -> { bankroll, positions[], account_summary{
 *                                  net_liquidation, buying_power, initial_margin,
 *                                  excess_liquidity, maintenance_margin, ... } }
 *   GET /options/expirations  -> { symbol, expirations: ["20260902", ...] }
 *   GET /options/chain        -> { symbol, expiry, exchange, strikes: [50.0, ...] }
 *   GET /orders/quote         -> single-contract bid/ask/mid
 */
async function ibGet(
  env: Env,
  tool: string,
  path: string,
  query: Record<string, string> = {},
  ctx?: ToolRunContext,
): Promise<unknown> {
  const base = need(env, "OW_IB_API_BASE", tool);
  const key = need(env, "OW_IB_API_KEY", tool);
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const doFetch = ctx?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { headers: { "X-API-Key": key, Accept: "application/json" } });
  } catch (error: unknown) {
    throw new Error(
      `${tool}: IB query api unreachable at ${url.host} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(`${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * `2026-09-18` or `20260918` -> whole days from today, the unit every DTE
 * threshold uses.
 *
 * Both spellings, because the separator is the vendor's choice and getting it
 * wrong fails SILENTLY: slicing `2026-10-16` by fixed offsets reads a month of
 * `"-1"`, `Number` gives NaN, the comparison is false, and every expiry drops
 * out of the band as if the ticker listed none. That is exactly what happened
 * on the first live call after the chain moved from IB (compact) to Unusual
 * Whales (dashed).
 */
export function dteOf(expiry: string, now: Date): number {
  const digits = expiry.replace(/\D/gu, "");
  const parsed = Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((parsed - today) / 86_400_000);
}

/**
 * A symbol or series id, validated as a SQL/URL literal.
 *
 * Every identifier here reaches either a psql `-c` string or a path segment,
 * and the tool takes them from a model's tool call — the one input on this
 * whole surface that is neither ours nor the vendor's. An allow-list is the
 * only defence that does not depend on getting quoting right.
 */
export function symbolLiteral(raw: string, tool: string): string {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:!-]{0,23}$/.test(value)) {
    throw new Error(`${tool}: ${JSON.stringify(raw)} is not a symbol this tool will pass on`);
  }
  return value;
}

/**
 * Read-only query against argon's Postgres, through psql.
 *
 * ponytail: psql over a driver. The alternative is a connection pool and a new
 * dependency for a handful of SELECTs a day, and the execFile pattern is
 * already here for opencli. `ON_ERROR_STOP` plus `--single-transaction` means
 * a broken query fails the tool instead of returning a partial result set, and
 * the connection string is a libpq URL so credentials stay in the env.
 */
async function pgJson(env: Env, tool: string, sql: string): Promise<unknown[]> {
  const url = need(env, "OW_ARGON_PG_URL", tool);
  const bin = env.OW_PSQL_BIN ?? "psql";
  const wrapped = `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      bin,
      ["-v", "ON_ERROR_STOP=1", "--single-transaction", "-At", "-c", wrapped, url],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error: unknown) {
    throw new Error(
      `${tool}: argon postgres query failed — ${
        error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ") : String(error)
      }`,
    );
  }
  const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Rates, breakevens, credit and financial conditions — the legs a regime read
 *  actually uses. All verified present in argon's store on 2026-09-02. */
const DEFAULT_MACRO_SERIES = [
  "DGS10",
  "DFII10",
  "T10YIE",
  "T5YIFR",
  "VIXCLS",
  "BAMLH0A0HYM2",
  "DTWEXBGS",
  "ANFCI",
] as const;

/**
 * What TradingView can quote live, and the FRED series each one is the
 * intraday twin of.
 *
 * argon's macro store is a DAILY FRED mirror and its scanner runs behind. On
 * 2026-09-02 its newest DGS10 was 2026-08-25 at 4.64 while the curve was at
 * 4.812, and its newest VIXCLS was 15.45 while VIX was at 16.72 — a rates read
 * and a vol read that a report dated today would both have got wrong. So the
 * daily series stays as the HISTORY (only it can carry a 30-day path) and
 * today's level comes off TradingView.
 *
 * DGS2, DGS5 and DGS30 are named even though argon ingests none of them: the
 * mapping is what the two halves join on, and naming a series argon lacks is
 * how a reader sees there is no daily path behind that tenor.
 *
 * DXY deliberately carries NO `fredId`. TVC:DXY is the ICE dollar index
 * against six currencies; DTWEXBGS is the Fed's broad trade-weighted index
 * against twenty-six, and on 2026-09-02 they read 99.84 and 118.06. They move
 * together and are not the same number — presenting one as the other's live
 * value would be the stale-data error again with an extra step. It is offered
 * as its own index, and `note` says so.
 *
 * Everything else in the default set — breakevens, the 10y real yield, HY OAS,
 * financial conditions — has no TradingView ticker at all. Those stay daily,
 * and `staleSeries` names them with their age rather than letting a reader
 * assume the whole payload is as live as its liveliest field.
 */
const TV_LIVE: ReadonlyArray<{
  ticker: string;
  exchange: string;
  label: string;
  fredId?: string;
  note?: string;
}> = [
  { ticker: "US02Y", exchange: "TVC", label: "2y", fredId: "DGS2" },
  { ticker: "US05Y", exchange: "TVC", label: "5y", fredId: "DGS5" },
  { ticker: "US10Y", exchange: "TVC", label: "10y", fredId: "DGS10" },
  { ticker: "US30Y", exchange: "TVC", label: "30y", fredId: "DGS30" },
  { ticker: "VIX", exchange: "TVC", label: "VIX", fredId: "VIXCLS" },
  {
    ticker: "DXY",
    exchange: "TVC",
    label: "DXY",
    note: "ICE dollar index (6 currencies). NOT the live value of DTWEXBGS, which is the Fed broad index over 26 and reads on a different scale.",
  },
];

/**
 * One TVC quote per instrument, or the reason there are none.
 *
 * It does NOT throw: argon's daily history is the primary result and losing the
 * intraday overlay must not cost the caller the path as well. It never returns
 * silence either — a missing overlay comes back as an `unavailable` string, so
 * the difference between "nothing moved" and "we could not read it" survives
 * into the report.
 *
 * `fetchedAt` is deliberately not called a quote time. opencli's `time` field
 * moves with the REQUEST (two calls a minute apart returned the same 4.812 at
 * two different `time`s, verified 2026-09-02), so it dates our read and says
 * nothing about the feed's own age. TradingView does not expose that age here;
 * treat the level as intraday but not as tick-fresh.
 */
export async function tvLiveLevels(
  env: Env,
  tool: string,
): Promise<{ quotes: unknown[]; fetchedAt: string } | { unavailable: string }> {
  if (env.OW_TV_ENABLED !== "1") {
    return { unavailable: 'OW_TV_ENABLED is not "1"; no live levels, daily series only' };
  }
  const bin = env.OPENCLI_BIN;
  if (bin === undefined || bin.trim() === "") {
    return { unavailable: "OPENCLI_BIN is unset; no live levels, daily series only" };
  }
  const quotes: unknown[] = [];
  for (const entry of TV_LIVE) {
    const argv = [
      "tradingview",
      "quote",
      "--ticker",
      symbolLiteral(entry.ticker, tool),
      "--exchange",
      entry.exchange,
      "-f",
      "json",
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(bin, argv, { timeout: 30_000 }));
    } catch (error: unknown) {
      return {
        unavailable:
          `${bin} ${argv.join(" ")} failed — ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    const parsed: unknown = JSON.parse(stdout);
    const row = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { close?: unknown; change_abs?: unknown }
      | undefined;
    const close = row?.close;
    // An instrument that answers without a number is dropped rather than
    // reported as zero — a 0.00 VIX or a 0.00% yield reads as a real and
    // catastrophic level.
    if (typeof close !== "number") continue;
    quotes.push({
      name: entry.label,
      symbol: `${entry.exchange}:${entry.ticker}`,
      ...(entry.fredId === undefined ? {} : { fredId: entry.fredId }),
      last: close,
      ...(typeof row?.change_abs === "number" ? { changeAbs: row.change_abs } : {}),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });
  }
  if (quotes.length === 0) {
    return { unavailable: "every TradingView symbol answered without a numeric close" };
  }
  return { quotes, fetchedAt: new Date().toISOString() };
}

/**
 * The series that have NO live twin, with how far behind each one is.
 *
 * argon's scanner falls behind and says nothing when it does. Without this a
 * reader sees a payload whose liveliest field is minutes old and assumes the
 * rest of it is too. Naming the lag costs one line and is the difference
 * between "credit is calm" and "credit was calm eight sessions ago".
 */
export function staleSeries(
  rows: ReadonlyArray<{ series_id?: unknown; obs_date?: unknown }>,
  now = new Date(),
): Array<{ seriesId: string; latestObs: string; ageDays: number }> {
  const live = new Set(TV_LIVE.flatMap((e) => (e.fredId === undefined ? [] : [e.fredId])));
  const newest = new Map<string, string>();
  for (const row of rows) {
    const id = row.series_id;
    const obs = row.obs_date;
    if (typeof id !== "string" || typeof obs !== "string") continue;
    if (live.has(id)) continue;
    const seen = newest.get(id);
    if (seen === undefined || obs > seen) newest.set(id, obs);
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [...newest]
    .map(([seriesId, latestObs]) => ({
      seriesId,
      latestObs,
      ageDays: Math.round((today - Date.parse(`${latestObs}T00:00:00Z`)) / 86_400_000),
    }))
    .filter((entry) => entry.ageDays >= 1)
    .sort((a, b) => b.ageDays - a.ageDays || a.seriesId.localeCompare(b.seriesId, "en"));
}

/** Verified 2026-09-02 against argon's own client: base
 *  `https://api.unusualwhales.com`, bearer token in `Authorization`
 *  (`/Users/chenxi/projects/argon/src/uw_scan/api/client.py:111`). */
const UW_BASE = "https://api.unusualwhales.com";

async function uwGet(
  env: Env,
  tool: string,
  path: string,
  query: Record<string, string> = {},
  ctx?: ToolRunContext,
): Promise<unknown> {
  const key = need(env, "OW_UW_API_KEY", tool);
  const url = new URL(path, UW_BASE);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const doFetch = ctx?.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}


/**
 * One TradingView quote, trying the exchanges a US listing can be on. There is
 * no lookup table: `search` answers with a display name ("NYSE Arca") while
 * `quote` wants a code ("AMEX"), so a resolver would be a translation table
 * that rots. Trying in order costs one extra subprocess on the miss.
 *
 * Shared by ow_spot and ow_uw_chain. A chain without the spot it sits against
 * is exactly the shape that shipped a 420/410 spread on a 707 underlying.
 */
export async function tvLast(
  env: Env,
  tool: string,
  raw: string,
): Promise<{ exchange: string; close: number; changeAbs?: number } | undefined> {
  if (env.OW_TV_ENABLED !== "1") throw new Error(`OW_TV_ENABLED is not "1"; ${tool} is disabled`);
  const bin = need(env, "OPENCLI_BIN", tool);
  const ticker = symbolLiteral(raw, tool);
  for (const exchange of ["NASDAQ", "AMEX", "NYSE"]) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        bin,
        ["tradingview", "quote", "--ticker", ticker, "--exchange", exchange, "-f", "json"],
        { timeout: 30_000 },
      ));
    } catch {
      continue;
    }
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    const row = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { close?: unknown; change_abs?: unknown }
      | undefined;
    if (typeof row?.close !== "number") continue;
    return {
      exchange,
      close: row.close,
      ...(typeof row.change_abs === "number" ? { changeAbs: row.change_abs } : {}),
    };
  }
  return undefined;
}

/**
 * The spot, from whichever source THIS MACHINE actually has.
 *
 * TradingView is a desktop app driven over CDP by opencli. That is a laptop
 * fact, not a deployment one: the mini has neither opencli nor a logged-in
 * chart (`ssh macmini command -v opencli` -> nothing, 2026-09-02). A price
 * path through it therefore leaves the mini with no spot, no chain — since
 * ow_uw_chain refuses to trim strikes around nothing — and a designer that
 * correctly returns no proposals every single day. Unusual Whales answers the
 * same question over the credential the chain already requires, so the fallback
 * costs no new secret and no new dependency.
 *
 * TradingView stays FIRST where it exists: it is the live regular-session last,
 * and it is what every strike shipped so far was checked against. UW's
 * `market_time` names which session its close came from, which the caller
 * reports rather than hiding.
 *
 * Verified 2026-09-02 against the live endpoint, SPY:
 *   {"data":{"close":"761.21","high":"761.85","low":"759.29","open":"760.86",
 *    "volume":329841,"total_volume":329841,"market_time":"premarket",
 *    "tape_time":"2026-09-02T11:52:58Z","prev_close":"761.78"}}
 * Every price is a STRING, hence `numeric`. `prev_close` is the backstop for a
 * ticker whose session has not printed yet — a stale price that says it is
 * stale beats no price at all, because no price is what silences a whole run.
 */
export async function spotOf(
  env: Env,
  tool: string,
  raw: string,
  ctx?: ToolRunContext,
): Promise<{ source: string; close: number; changeAbs?: number; marketTime?: string } | undefined> {
  if (env.OW_TV_ENABLED === "1" && (env.OPENCLI_BIN ?? "") !== "") {
    const hit = await tvLast(env, tool, raw);
    if (hit !== undefined) {
      return {
        source: hit.exchange,
        close: hit.close,
        ...(hit.changeAbs === undefined ? {} : { changeAbs: hit.changeAbs }),
      };
    }
  }
  const ticker = symbolLiteral(raw, tool);
  const state = (await uwGet(
    env,
    tool,
    `/api/stock/${encodeURIComponent(ticker)}/stock-state`,
    {},
    ctx,
  )) as { data?: unknown };
  const row = (state.data ?? {}) as {
    close?: unknown;
    prev_close?: unknown;
    market_time?: unknown;
  };
  const close = numeric(row.close) ?? numeric(row.prev_close);
  if (close === undefined) return undefined;
  return {
    source: "unusualwhales",
    close,
    ...(typeof row.market_time === "string" ? { marketTime: row.market_time } : {}),
  };
}

/**
 * OCC option symbol -> its parts. `SPY261016P00725000` is SPY, 2026-10-16, put,
 * strike 725. The root is variable length and the strike is fixed at 8 digits
 * in thousandths, which is what makes the split unambiguous from the right.
 *
 * Unusual Whales returns no `strike` field at all — the strike exists only
 * inside this symbol — so every strike this tenant reads from UW comes through
 * here. Verified 2026-09-02 against a live
 * `/api/stock/SPY/option-contracts?expiry=2026-10-16` response.
 */
export function parseOcc(
  symbol: string,
): { root: string; expiry: string; right: "C" | "P"; strike: number } | undefined {
  const match = /^([A-Z0-9.]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/u.exec(symbol);
  if (match === null) return undefined;
  const [, root, yy, mm, dd, right, strike] = match;
  // The root is variable length, so without a calendar check the match can
  // simply eat a stray digit into the root and read a date of month 61 —
  // "SPY2610161P00725000" does exactly that. A symbol that does not name a real
  // day is not an option symbol.
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return {
    root: root!,
    expiry: `20${yy!}-${mm!}-${dd!}`,
    right: right as "C" | "P",
    strike: Number(strike) / 1000,
  };
}

/** UW returns some numbers as JSON strings ("5.09") and some as numbers, and
 *  leaves others null on untraded contracts. One reader for all three, and a
 *  missing number stays missing rather than becoming a zero that reads as a
 *  real bid of nothing. */
/**
 * Keep at most `cap` entries SPANNING the list, not the `cap` nearest its
 * middle. The difference is the whole point: a defined-risk spread needs a long
 * wing several percent out, and the first version of this trim kept the 60
 * contracts nearest spot — which collapsed a SPY put chain to strikes 738-780
 * around a 761.78 spot. The designer then wrote a 746/724 spread whose 724 leg
 * was never in the chain it was shown, which is precisely the unanchored strike
 * ow_spot exists to prevent, reintroduced by the trimming.
 *
 * Both ends are always kept, so the caller can see how far the window reaches.
 */
export function thinAcross<T>(rows: readonly T[], cap: number): T[] {
  if (rows.length <= cap || cap < 2) return rows.slice(0, Math.max(cap, 0));
  const step = (rows.length - 1) / (cap - 1);
  const kept: T[] = [];
  for (let i = 0; i < cap; i += 1) kept.push(rows[Math.round(i * step)]!);
  return [...new Set(kept)];
}

function round4(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number(value.toFixed(4));
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const TvParams = z.object({
  flagColors: z.array(z.enum(["red", "orange", "yellow", "green", "blue", "purple"])).optional(),
});
const SpotParams = z.object({ tickers: z.array(z.string().min(1)).min(1).max(24) });
const NoParams = z.object({});
const UwChainParams = z.object({
  ticker: z.string().min(1),
  minDte: z.number().int().nonnegative(),
  maxDte: z.number().int().positive(),
  strikeWindowPct: z.number().positive().max(50).optional(),
  minOpenInterest: z.number().int().nonnegative().optional(),
});
const TickerMetricsParams = z.object({ tickers: z.array(z.string().min(1)).min(1).max(25) });
// sector and etf are REQUIRED: the tide endpoints are per-sector and per-ETF,
// and picking a default here would be picking a market view on the caller's
// behalf.
const MarketStateParams = z.object({ sector: z.string().min(1), etf: z.string().min(1) });
const MacroParams = z.object({
  series: z.array(z.string().min(1)).min(1).max(24).optional(),
  lookbackDays: z.number().int().positive().max(3650).optional(),
});
const BarsParams = z.object({
  symbol: z.string().min(1),
  assetClass: z.enum(["equity", "index", "rates", "crypto", "futures"]).optional(),
  timeframe: z.string().min(1).optional(),
  lookbackDays: z.number().int().positive().max(3650).optional(),
});

export function buildTools(cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
}) {
  const { env } = cfg;
  return [
    {
      // opencli's TradingView adapter is read-only and drives the LOCAL app over
      // CDP; on the mini the app is installed but opencli is not, so this tool's
      // absence is a degraded run, not a failed one (spec §5, §7). Surface
      // verified 2026-09-02 against `opencli tradingview watchlists --help`:
      // options `--id`, `--color <red|orange|…>`, `-f json`; columns
      // id, name, symbol_count, symbols.
      name: "ow_tv_watchlist",
      description:
        "TradingView watchlists (read-only) via opencli. Returns the union of the requested colored-flag lists, or every watchlist when no color is given.",
      paramsSchema: TvParams,
      mutating: false,
      dshParams: {
        flagColors: {
          type: "array",
          description: "Colored flag lists: red, orange, yellow, green, blue, purple",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { flagColors } = TvParams.parse(args);
        // TradingView is a desktop app driven by opencli, so the mini has no
        // watchlist and the universe step would hand the designer an empty set
        // — a run that completes and proposes nothing, every day. OW_UNIVERSE
        // is the OPERATOR's list, not a guess made here: this tool will not
        // invent a universe, it will only read the one someone wrote down. It
        // says so in `source`, because a frozen list and today's flags are not
        // the same thing and a reader must be able to tell.
        const tvHere = env.OW_TV_ENABLED === "1" && (env.OPENCLI_BIN ?? "") !== "";
        if (!tvHere) {
          const listed = (env.OW_UNIVERSE ?? "")
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry) => entry !== "");
          if (listed.length === 0) {
            throw new Error(
              "ow_tv_watchlist: TradingView is not on this machine (needs OW_TV_ENABLED=1 and " +
                "OPENCLI_BIN) and OW_UNIVERSE names no fallback tickers, so there is no " +
                "universe to build. Refusing to return an empty one, which reads as a market " +
                "with nothing in it.",
            );
          }
          return JSON.stringify({
            source: "operator list (OW_UNIVERSE)",
            note:
              "TradingView is not available on this machine. These are the tickers the operator " +
              "listed, not today's flagged watchlists — the list is as current as whoever set it.",
            tickers: [...new Set(listed)].sort((a, b) => a.localeCompare(b, "en")),
            fetchedAt: new Date().toISOString(),
          });
        }
        const bin = need(env, "OPENCLI_BIN", "ow_tv_watchlist");
        const symbols = new Set<string>();
        for (const color of flagColors ?? [undefined]) {
          const argv = ["tradingview", "watchlists", "-f", "json"];
          if (color !== undefined) argv.push("--color", color);
          let stdout: string;
          try {
            ({ stdout } = await execFileAsync(bin, argv, { timeout: 30_000 }));
          } catch (error: unknown) {
            throw new Error(
              `ow_tv_watchlist: ${bin} ${argv.join(" ")} failed — ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          const parsed: unknown = JSON.parse(stdout);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            const list = (row as { symbols?: unknown }).symbols;
            // `symbols` comes back as a COMMA-SEPARATED STRING, not an array —
            // captured live 2026-09-02: {"id":132043044,"name":"Daily",
            // "symbol_count":5,"symbols":"NASDAQ:LULU,NYSE:MCD,NYSE:KO,..."}.
            // Reading it as an array only was silent: every list was skipped and
            // the tool returned a plausible EMPTY universe, which is the one
            // shape this file exists to never produce. Both are accepted because
            // -f json is opencli's shape, not TradingView's, and it can change.
            const parts = Array.isArray(list)
              ? list
              : typeof list === "string"
                ? list.split(",")
                : [];
            // TradingView symbols carry their exchange ("NASDAQ:AAPL"); the rest
            // of the pipeline keys on the bare ticker.
            for (const symbol of parts) {
              if (typeof symbol !== "string") continue;
              const ticker = (symbol.split(":").pop() ?? symbol).trim();
              if (ticker !== "") symbols.add(ticker);
            }
          }
        }
        // After every requested colour, not inside the loop: one empty colour
        // among several is a fact about that list, while nothing at all across
        // all of them means the shape changed under us.
        if (symbols.size === 0) {
          throw new Error(
            `ow_tv_watchlist: ${bin} returned watchlists but no symbol could be read from them; ` +
              "refusing to report an empty universe as a result",
          );
        }
        return JSON.stringify({
          // Named per quote, not once for the list: on a machine with no
          // TradingView every price comes from UW, and on one with both the
          // list can legitimately mix the two.
          sourceNote:
            "`source` on each quote is the exchange when the price came from TradingView, or `unusualwhales`. A UW quote carries `marketTime` naming the session its close is from.",
          tickers: [...symbols].sort(),
          asOf: new Date().toISOString(),
        });
      },
    },
    {
      // The strike sanity floor.
      //
      // Run 846e96ff completed cleanly and proposed a QQQ 420/410 put spread
      // with QQQ at 707.64, and NVDA 130/120 with NVDA at 217.44 — strikes 40%
      // away from spot, invented because no role in that run had a price for
      // either name. `defined_risk` passed them, correctly: the STRUCTURE was
      // sound. A gate that checks shape cannot catch a fabricated level, so the
      // fix belongs upstream, in giving the roles a real one.
      //
      // TradingView rather than IB: IB's quote route answered 3 calls in 602s
      // and this is premarket, where there is no live trade to wait for anyway.
      // `close` here is the last regular-session print.
      //
      // Exchange is resolved by TRYING, not by looking up. `search` answers
      // with a display name ("NYSE Arca") and `quote` wants a code ("AMEX"), so
      // a resolver would be a translation table that rots. Three attempts in a
      // fixed order cost about a second and cannot disagree with the quote API
      // about its own vocabulary.
      name: "ow_spot",
      description:
        "Last price for each ticker, from TradingView where this machine has it and from Unusual Whales otherwise. Call this before naming any strike: a strike is only meaningful next to the spot it sits against.",
      paramsSchema: SpotParams,
      mutating: false,
      dshParams: {
        tickers: { type: "array", required: true, description: "Ticker symbols, at most 24" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { tickers } = SpotParams.parse(args);
        const tool = "ow_spot";
        const quotes: unknown[] = [];
        // The REASON travels with the name. "no price for SPY" and "no price
        // for SPY because this machine has no UW credential" are the same
        // sentence to a reader and different facts to an operator.
        const missing: Array<{ ticker: string; reason: string }> = [];
        for (const raw of tickers) {
          const ticker = symbolLiteral(raw, tool);
          let hit: Awaited<ReturnType<typeof spotOf>>;
          let why = "no quote from TradingView or Unusual Whales";
          try {
            hit = await spotOf(env, tool, ticker, ctx);
          } catch (error: unknown) {
            // One unreachable ticker must not take the other twenty-three with
            // it: it goes on the noPrice list like any other unpriced name.
            hit = undefined;
            why = error instanceof Error ? error.message : String(error);
          }
          // A ticker with no price is NAMED, never dropped and never guessed at.
          // Silence here is what produced the 420 strike on a 707 underlying.
          if (hit === undefined) missing.push({ ticker, reason: why });
          else quotes.push({ ticker, source: hit.source, last: hit.close, ...(hit.marketTime === undefined ? {} : { marketTime: hit.marketTime }), ...(hit.changeAbs === undefined ? {} : { changeAbs: hit.changeAbs }) });
        }
        if (quotes.length === 0) {
          throw new Error(
            `ow_spot: no price for any of ${tickers.join(", ")} — ${missing[0]?.reason ?? ""}; ` +
              "refusing to return an empty price list, which reads as a set of tickers that " +
              "are all worth nothing",
          );
        }
        return JSON.stringify({
          source: "tradingview",
          quotes,
          ...(missing.length === 0
            ? {}
            : {
                noPrice: missing,
                noPriceNote:
                  "No price was found for these. Do not name a strike on them — say they were unpriced.",
              }),
          fetchedAt: new Date().toISOString(),
        });
      },
    },
    {
      // Straight to argon's Postgres, not to argon's HTTP API.
      //
      // The API is a process that has to be up; the database is the system of
      // record and was up the whole time the API was returning 502. Reading
      // the shell instead of the store made "argon is unavailable" a daily
      // occurrence when the data was always there.
      //
      // Columns verified live 2026-09-02 against the running database:
      //   iv_rank_history(ticker, market_date, close, volatility, iv_rank_1y)
      //   greek_exposure_daily(ticker, trade_date, net_gex, net_dex,
      //                        call_gex, put_gex, call_delta, put_delta)
      //   skew_analytics_snapshot(ticker, market_date, spot, rr_25d, skew_25d,
      //                           rr_z_180d, deviation_class, regime,
      //                           directional_lean, lean_confidence)
      // Every row carries its own as-of date, because these tables are fed by
      // a scanner that can fall behind and a stale number must be visibly stale.
      name: "ow_argon_metrics",
      description:
        "Per-ticker IV rank, gamma/delta exposure and 25-delta skew from argon's store, each with the date it was observed.",
      paramsSchema: TickerMetricsParams,
      mutating: false,
      dshParams: {
        tickers: { type: "array", required: true, description: "Up to 25 symbols" },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { tickers } = TickerMetricsParams.parse(args);
        const list = tickers.map((ticker) => `'${symbolLiteral(ticker, "ow_argon_metrics")}'`).join(",");
        const rows = await pgJson(
          env,
          "ow_argon_metrics",
          `SELECT t.ticker,
                  to_jsonb(iv) - 'inserted_at' - 'updated_at_src' AS iv,
                  to_jsonb(gx) - 'payload'                        AS gex,
                  to_jsonb(sk)                                    AS skew
             FROM (SELECT unnest(ARRAY[${list}]) AS ticker) t
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.iv_rank_history r
                                 WHERE r.ticker = t.ticker
                                 ORDER BY r.market_date DESC LIMIT 1) iv ON true
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.greek_exposure_daily g
                                 WHERE g.ticker = t.ticker
                                 ORDER BY g.trade_date DESC LIMIT 1) gx ON true
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.skew_analytics_snapshot s
                                 WHERE s.ticker = t.ticker
                                 ORDER BY s.market_date DESC LIMIT 1) sk ON true`,
        );
        return JSON.stringify({ source: "argon.uw_scan", rows });
      },
    },
    {
      name: "ow_ib_positions",
      description: "Open positions, net liquidation and buying power from IB Gateway (read-only).",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(_args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const body = (await ibGet(env, "ow_ib_positions", "/portfolio", {}, ctx)) as {
          last_sync?: unknown;
        };
        // `/portfolio` is a PERSISTED SNAPSHOT, not a live read. xenon refreshes
        // it on `POST /portfolio/sync`, a write path this read-only key is
        // deliberately refused on — so the age of what comes back is unbounded
        // and nothing in the payload flags it. It was served 35 days stale and
        // passed through verbatim, and a role then reasoned about "today's"
        // buying power from a snapshot taken five weeks earlier. An account
        // number with the wrong date on it is not a weaker number, it is a
        // wrong one; refusing is the only honest option, and the message names
        // the exact command that fixes it.
        const syncedAt = typeof body.last_sync === "string" ? Date.parse(body.last_sync) : NaN;
        if (Number.isNaN(syncedAt)) {
          throw new Error("ow_ib_positions: /portfolio carried no readable last_sync; refusing an undateable account snapshot");
        }
        const ageHours = (Date.now() - syncedAt) / 3_600_000;
        const maxAgeHours = Number(env.OW_IB_MAX_SNAPSHOT_AGE_HOURS ?? "24");
        if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
          throw new Error("OW_IB_MAX_SNAPSHOT_AGE_HOURS is not a positive number; ow_ib_positions has no freshness bound to check against");
        }
        if (ageHours > maxAgeHours) {
          throw new Error(
            `ow_ib_positions: the account snapshot is ${ageHours.toFixed(1)}h old ` +
              `(last_sync ${String(body.last_sync)}), past the ${String(maxAgeHours)}h bound. ` +
              "xenon refreshes it with POST /portfolio/sync, which this read-only key cannot call. " +
              "No account figures are returned rather than dating today's risk from a stale book.",
          );
        }
        // Age travels WITH the data, so a consumer that ignores the bound still
        // cannot mistake the vintage.
        return JSON.stringify({ ...body, snapshotAgeHours: Number(ageHours.toFixed(2)) });
      },
    },
    {
      // Replaces ow_ib_chain + ow_ib_quote, which were one tool's worth of data
      // behind two IB round trips: a chain call, then one quote call per
      // contract id. Measured over four live runs that path cost 60-91s and
      // then returned 502 Bad Gateway, which cost a whole run its proposals —
      // and it was reaching for a live quote before the open, when there is no
      // live quote to reach for. One UW call per expiry carries the strikes AND
      // the NBBO AND open interest AND the greeks.
      //
      // Verified 2026-09-02 against live responses:
      //   GET /api/stock/SPY/expiry-breakdown
      //     -> data[]: { expires, open_interest, volume, chains }
      //   GET /api/stock/SPY/option-contracts?expiry=2026-10-16
      //     -> data[] (442 rows): { option_symbol, nbbo_bid, nbbo_ask,
      //        open_interest, volume, implied_volatility, delta, gamma, theta,
      //        vega, rho, last_price, last_tape_time, ... }
      // There is NO strike field: the strike lives in option_symbol (parseOcc).
      // implied_volatility is null on 181 of those 442 rows — the untraded
      // wings — which the open-interest floor removes rather than reporting as
      // a zero.
      name: "ow_uw_chain",
      description:
        "Option chain for a ticker within a DTE band, from Unusual Whales: strike, NBBO bid/ask, open interest, IV and greeks, trimmed to the strikes around today's spot. The spot it was trimmed against is returned with it.",
      paramsSchema: UwChainParams,
      mutating: false,
      dshParams: {
        ticker: { type: "string", required: true, description: "Underlying symbol" },
        minDte: { type: "number", required: true, description: "Minimum days to expiry" },
        maxDte: { type: "number", required: true, description: "Maximum days to expiry" },
        // strikeWindowPct and minOpenInterest stay OUT of the model-facing
        // spec: dsh rejects a parameter declared `required: false`
        // ("unsupported JSON schema: parameters.X.required must be true when
        // present"), and a trimming knob is not a decision a role should be
        // making anyway. The zod schema still accepts both for direct callers.
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { ticker, minDte, maxDte, strikeWindowPct, minOpenInterest } =
          UwChainParams.parse(args);
        const tool = "ow_uw_chain";
        const window = (strikeWindowPct ?? 8) / 100;
        const oiFloor = minOpenInterest ?? 250;

        // The spot comes FIRST and its absence is fatal. A chain trimmed around
        // nothing is a list of numbers with no anchor, and handing one to a
        // designer is how the 420/410 spread on a 707 underlying happened.
        const spot = await spotOf(env, tool, ticker, ctx);
        if (spot === undefined) {
          throw new Error(
            `${tool}: no spot for ${ticker} from TradingView or Unusual Whales, so there is nothing to ` +
              "centre a strike window on. Refusing to return a chain that cannot be read " +
              "against a price.",
          );
        }

        const encoded = encodeURIComponent(symbolLiteral(ticker, tool));
        const breakdown = (await uwGet(
          env,
          tool,
          `/api/stock/${encoded}/expiry-breakdown`,
          {},
          ctx,
        )) as { data?: unknown };
        const listed = Array.isArray(breakdown.data) ? breakdown.data : [];
        const now = new Date();
        const inBand = listed
          .map((row) => row as { expires?: unknown; open_interest?: unknown; volume?: unknown })
          .filter((row): row is { expires: string } & typeof row => typeof row.expires === "string")
          .map((row) => ({ ...row, dte: dteOf(row.expires, now) }))
          .filter((row) => row.dte >= minDte && row.dte <= maxDte)
          .sort((a, b) => a.dte - b.dte)
          .slice(0, 3);

        const expiries = [];
        for (const row of inBand) {
          const page = (await uwGet(
            env,
            tool,
            `/api/stock/${encoded}/option-contracts`,
            { expiry: row.expires },
            ctx,
          )) as { data?: unknown };
          const raw = Array.isArray(page.data) ? page.data : [];
          const contracts = raw
            .map((entry) => entry as Record<string, unknown>)
            .flatMap((entry) => {
              const parsed =
                typeof entry.option_symbol === "string" ? parseOcc(entry.option_symbol) : undefined;
              if (parsed === undefined) return [];
              const oi = typeof entry.open_interest === "number" ? entry.open_interest : 0;
              if (oi < oiFloor) return [];
              if (Math.abs(parsed.strike - spot.close) / spot.close > window) return [];
              const bid = numeric(entry.nbbo_bid);
              const ask = numeric(entry.nbbo_ask);
              return [
                {
                  right: parsed.right,
                  strike: parsed.strike,
                  bid,
                  ask,
                  ...(bid === undefined || ask === undefined
                    ? {}
                    : { mid: Number(((bid + ask) / 2).toFixed(2)) }),
                  openInterest: oi,
                  volume: typeof entry.volume === "number" ? entry.volume : undefined,
                  // Rounded to four places on the way out. UW answers with
                  // seventeen significant digits of float noise per greek, and
                  // five greeks across three expiries of chain is most of the
                  // payload — 65KB became 34KB for nothing anyone can trade on.
                  iv: round4(numeric(entry.implied_volatility)),
                  delta: round4(numeric(entry.delta)),
                  gamma: round4(numeric(entry.gamma)),
                  theta: round4(numeric(entry.theta)),
                  vega: round4(numeric(entry.vega)),
                },
              ];
            })
            .sort((a, b) => a.strike - b.strike || a.right.localeCompare(b.right, "en"));
          const trimmed = [
            ...thinAcross(contracts.filter((c) => c.right === "P"), 40),
            ...thinAcross(contracts.filter((c) => c.right === "C"), 40),
          ];
          expiries.push({
            expiry: row.expires,
            dte: row.dte,
            chainOpenInterest: row.open_interest,
            chainVolume: row.volume,
            contracts: trimmed,
          });
        }

        // An empty band is a FACT, not a failure: a ticker can genuinely list no
        // expiry between minDte and maxDte. The count of what WAS listed travels
        // with it so the caller can tell that apart from a bad symbol.
        return JSON.stringify({
          source: "unusualwhales",
          ticker,
          spot: spot.close,
          spotSource:
            spot.source === "unusualwhales"
              ? `unusualwhales${spot.marketTime === undefined ? "" : ` (${spot.marketTime})`}`
              : `tradingview ${spot.source}`,
          strikeWindowPct: window * 100,
          minOpenInterest: oiFloor,
          minDte,
          maxDte,
          listedExpiries: listed.length,
          expiries,
          note:
            "Quotes are the last NBBO Unusual Whales recorded, not a live book. Before the open " +
            "that is the previous session's close — there is no live quote to have.",
          fetchedAt: new Date().toISOString(),
        });
      },
    },
    {
      // Scoped to what argon does NOT serve. argon's cards already carry
      // iv_rank, gamma.* and skew.rr25d_30dte, so paying Unusual Whales a
      // second time for the same numbers would be pure cost (spec §3).
      // Endpoints verified 2026-09-02 against the UW OpenAPI docs:
      // GET /api/stock/{ticker}/volatility/term-structure, GET /api/stock/{ticker}/max-pain.
      name: "ow_uw_ticker_metrics",
      description:
        "Per-ticker IV term structure and max pain from Unusual Whales. IV rank, GEX and skew come from argon, not from here.",
      paramsSchema: TickerMetricsParams,
      mutating: false,
      dshParams: {
        tickers: { type: "array", required: true, description: "Up to 25 symbols" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { tickers } = TickerMetricsParams.parse(args);
        const rows = [];
        for (const ticker of tickers) {
          const encoded = encodeURIComponent(ticker);
          rows.push({
            ticker,
            ivTermStructure: await uwGet(
              env,
              "ow_uw_ticker_metrics",
              `/api/stock/${encoded}/volatility/term-structure`,
              {},
              ctx,
            ),
            maxPain: await uwGet(
              env,
              "ow_uw_ticker_metrics",
              `/api/stock/${encoded}/max-pain`,
              {},
              ctx,
            ),
          });
        }
        return JSON.stringify(rows);
      },
    },
    {
      // Endpoints verified 2026-09-02 against the UW OpenAPI docs:
      // GET /api/market/market-tide, /api/market/{sector}/sector-tide,
      // /api/market/{ticker}/etf-tide.
      name: "ow_uw_market_state",
      description: "Market tide plus one sector tide and one ETF tide from Unusual Whales.",
      paramsSchema: MarketStateParams,
      mutating: false,
      dshParams: {
        sector: { type: "string", required: true, description: "Sector for the sector tide" },
        etf: { type: "string", required: true, description: "ETF symbol for the ETF tide" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { sector, etf } = MarketStateParams.parse(args);
        const tool = "ow_uw_market_state";
        return JSON.stringify({
          marketTide: await uwGet(env, tool, "/api/market/market-tide", {}, ctx),
          sectorTide: await uwGet(
            env,
            tool,
            `/api/market/${encodeURIComponent(sector)}/sector-tide`,
            {},
            ctx,
          ),
          etfTide: await uwGet(
            env,
            tool,
            `/api/market/${encodeURIComponent(etf)}/etf-tide`,
            {},
            ctx,
          ),
        });
      },
    },
    {
      // Unusual Whales' `/api/economy/*` answers 403 on this subscription, and
      // the spec's `central_bank_rates` / `yield_curve` routes do not exist at
      // all. argon already ingests the FRED series into its own store, so the
      // rates leg comes from there — the same numbers, one hop closer, and no
      // tier to be refused by.
      //
      // Series verified present 2026-09-02: DGS10 (10y nominal), DFII10 (10y
      // real), T10YIE (10y breakeven), T5YIFR (5y5y forward), VIXCLS, ANFCI /
      // NFCI (financial conditions), BAMLH0A0HYM2 (HY OAS), DTWEXBGS (dollar).
      name: "ow_macro_rates",
      description:
        "Rates, breakevens, credit spreads and financial-conditions series from argon's macro store, each with its observation date, plus today's live levels from TradingView for the 2y/5y/10y/30y curve, VIX and DXY. `series` is the daily path; `liveNow` is the current level; `staleSeries` names the series that have no live twin and how many days behind each one is. Quote `liveNow` for today, `series` for the trend, and `staleSeries` whenever you cite a series listed there.",
      paramsSchema: MacroParams,
      mutating: false,
      dshParams: {
        series: {
          type: "array",
          description: "FRED series ids; omit for the default rates/vol/credit set",
        },
        lookbackDays: { type: "number", description: "How far back to return observations (default 30)" },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { series, lookbackDays } = MacroParams.parse(args);
        const wanted = series ?? [...DEFAULT_MACRO_SERIES];
        const list = wanted.map((id) => `'${symbolLiteral(id, "ow_macro_rates")}'`).join(",");
        const days = lookbackDays ?? 30;
        const rows = await pgJson(
          env,
          "ow_macro_rates",
          `SELECT series_id, obs_date::text AS obs_date, value
             FROM uw_scan.macro_series_daily
            WHERE series_id IN (${list})
              AND obs_date >= current_date - ${String(Math.trunc(days))}
            ORDER BY series_id, obs_date DESC`,
        );
        if (rows.length === 0) {
          throw new Error(
            `ow_macro_rates: argon's macro store has no observation for ${wanted.join(", ")} ` +
              `in the last ${String(days)} days; returning no rates rather than an empty curve that reads as flat`,
          );
        }
        // Two sources, two keys, never merged into one number: `series` is the
        // daily path and carries its own observation dates, `liveCurve` is
        // today's level. A single blended field would let a caller quote an
        // 8-day-old 10y as this morning's, which is exactly the mistake this
        // overlay exists to remove.
        // Three keys, never merged: `series` is the daily path with its own
        // observation dates, `liveNow` is today's level, and `staleSeries`
        // names what has neither. A single blended field would let a caller
        // quote an 8-day-old 10y as this morning's, which is exactly what this
        // overlay exists to remove.
        return JSON.stringify({
          series: { source: "argon.uw_scan.macro_series_daily", rows },
          liveNow: { source: "tradingview", ...(await tvLiveLevels(env, "ow_macro_rates")) },
          staleSeries: staleSeries(rows as Array<{ series_id?: unknown; obs_date?: unknown }>),
        });
      },
    },
    {
      // apex serves the EOD-synced lake; it is the desk's only deep daily
      // history and needs no credential (verified 2026-09-02: SPY 2026-08-25
      // close 765.91 over a bare GET, no header).
      //
      // `start` MUST be offset-aware — a bare YYYY-MM-DD makes apex answer 500
      // — and `price_mode=adjusted` is equity-only, both learned from argon's
      // own client rather than rediscovered here.
      name: "ow_apex_bars",
      description:
        "Historical daily/intraday OHLCV bars for one symbol from apex's market-data lake.",
      paramsSchema: BarsParams,
      mutating: false,
      dshParams: {
        symbol: { type: "string", required: true, description: "Ticker, e.g. SPY" },
        assetClass: { type: "string", description: "equity (default), index, rates, crypto, futures" },
        timeframe: { type: "string", description: "e.g. 1d (default), 1h, 5m" },
        lookbackDays: { type: "number", description: "Calendar days back from today (default 180)" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { symbol, assetClass, timeframe, lookbackDays } = BarsParams.parse(args);
        const tool = "ow_apex_bars";
        const base = need(env, "OW_APEX_API_BASE", tool);
        const ticker = symbolLiteral(symbol, tool);
        const klass = assetClass ?? "equity";
        const back = lookbackDays ?? 180;
        const start = new Date(Date.now() - back * 86_400_000).toISOString();
        const url = new URL(`/v1/${encodeURIComponent(klass)}/${encodeURIComponent(ticker)}/bars`, base);
        url.searchParams.set("timeframe", timeframe ?? "1d");
        url.searchParams.set("start", start);
        if (klass === "equity") url.searchParams.set("price_mode", "adjusted");
        const doFetch = ctx?.fetchImpl ?? fetch;
        let response: Response;
        try {
          response = await doFetch(url);
        } catch (error: unknown) {
          throw new Error(
            `${tool}: apex unreachable at ${url.host} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!response.ok) {
          throw new Error(`${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as { bars?: unknown[] };
        if (!Array.isArray(body.bars) || body.bars.length === 0) {
          throw new Error(
            `${tool}: apex has no ${timeframe ?? "1d"} bar for ${ticker} since ${start}; ` +
              "reporting the gap rather than an empty series",
          );
        }
        return JSON.stringify(body);
      },
    },
    {
      // The same evaluation the `ib-preflight` gate runs, exposed so a role can
      // ask before it commits. It writes nothing: the gate record file of spec
      // §4 is replaced by the audited gate span (see the gate's module header).
      name: "ow_ib_preflight",
      description:
        "Run the five preflight sub-gates over one proposal. Returns the content hash and each sub-gate's verdict; writes nothing.",
      paramsSchema: ProposalSchema,
      mutating: false,
      dshParams: {
        ticker: { type: "string", required: true, description: "Underlying symbol" },
        strategy: { type: "string", required: true, description: "e.g. put-credit-spread" },
        legs: { type: "array", required: true, description: "right/expiry/strike/action/ratio" },
        quantity: { type: "number", required: true, description: "Number of spreads" },
        limitPrice: { type: "number", required: true, description: "Net debit(+) / credit(-)" },
        rationale: { type: "string", required: true, description: "Why this structure" },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const proposal = ProposalSchema.parse(args);
        return JSON.stringify(evaluateProposal(proposal, tenantThresholds()));
      },
    },
  ];
}
