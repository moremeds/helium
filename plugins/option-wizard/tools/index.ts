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
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolRunContext, ToolVocabularyEntry } from "@helium/core";
import {
  candidatesFrom,
  extractJson,
  type CandidateView,
} from "../render/index.js";
import { priceStructure, width } from "../render/math.js";
import {
  ProposalSchema,
  evaluateProposal,
  tenantThresholds,
} from "../gates/ib-preflight.js";

const execFileAsync = promisify(execFile);

/**
 * The US equity venues TradingView tags an optionable listing with. Everything
 * else in a watchlist — futures, forex, crypto, foreign listings, index
 * pseudo-tickers, and the "###Section" headers that carry no exchange at all —
 * is not something a defined-risk options proposal can be written against.
 * AMEX is what TradingView calls NYSE Arca, which is where most ETFs live.
 */
const US_EQUITY_VENUES = new Set(["NASDAQ", "NYSE", "AMEX", "BATS", "ARCA"]);

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  // Both of these have TWO sources now — TradingView where the machine has it,
  // Unusual Whales or the operator's list where it does not — so neither has a
  // single key whose absence disables it. `requiresEnv` names exactly one key,
  // so naming OW_TV_ENABLED here made the run report reads them as broken on
  // the very machine they were made to work on. An honest gap report is only
  // honest while its entries are true.
  ["ow_tv_watchlist", { mutating: false }],
  ["ow_spot", { mutating: false }],
  ["ow_argon_metrics", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  ["ow_argon_levels", { mutating: false, requiresEnv: "OW_ARGON_API_BASE" }],
  ["ow_apex_bars", { mutating: false, requiresEnv: "OW_APEX_API_BASE" }],
  ["ow_ib_positions", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_uw_chain", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_ticker_metrics", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_market_state", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_gex", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_earnings", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  // No `requiresEnv`: the state root is always known, and an empty reports
  // directory is a real answer — the first ever run of a phase — not a
  // misconfiguration to report as a broken tool.
  ["ow_reports", { mutating: false }],
  // Same reasoning as ow_reports: it reads the same report directory, and "no
  // brief yesterday" is an answer the editor prints in one line, not an outage.
  ["ow_prior_brief", { mutating: false }],
  // No `requiresEnv` either: OW_OPENCLI_BIN has a working default, and a
  // `requiresEnv` on a key with a default reports a working machine as broken
  // (the note above ow_tv_watchlist is the precedent).
  ["ow_frank", { mutating: false }],
  ["ow_macro_rates", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  ["ow_uw_calendar", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_iv_term", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_headlines", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_argon_policy_path", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  // No `requiresEnv`: like ow_tv_watchlist these ride the local TradingView /
  // Browser Bridge app through opencli, gated on OW_TV_ENABLED, and naming one
  // key would report a working machine as broken.
  ["ow_x_posts", { mutating: false }],
  ["ow_tv_commodities", { mutating: false }],
  ["ow_ib_preflight", { mutating: false }],
  // Pure arithmetic over numbers the caller already has: no env, no network.
  ["ow_price_structure", { mutating: false }],
  // Two sources like ow_spot, so no single key whose absence disables it.
  ["ow_strike_check", { mutating: false }],
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
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  const doFetch = ctx?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
  } catch (error: unknown) {
    throw new Error(
      `${tool}: IB query api unreachable at ${url.host} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`,
    );
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
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
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
    throw new Error(
      `${tool}: ${JSON.stringify(raw)} is not a symbol this tool will pass on`,
    );
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
      [
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "-At",
        "-c",
        wrapped,
        url,
      ],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error: unknown) {
    throw new Error(
      `${tool}: argon postgres query failed — ${
        error instanceof Error
          ? error.message.split("\n").slice(0, 3).join(" ")
          : String(error)
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
 * financial conditions — has no TradingView ticker at all (checked 2026-09-03:
 * there is no TV quote for FRED:BAMLH0A0HYM2). Their twin is FRED itself.
 * `fredgraph.csv?id=<series>` needs no API key and runs 1–2 days behind, against
 * the ~9 days argon's mirror was behind on 2026-09-03. Verified 2026-09-03 09:51
 * UTC: `id=BAMLH0A0HYM2` answered `observation_date,BAMLH0A0HYM2` rows ending
 * `2026-09-01,2.65`. That host answers from the mini directly and through its
 * proxy, and NOT from the laptop (SSL fails) — so the fetch degrades to a named
 * `skipped` reason, never to an estimate. So the daily row stays the HISTORY,
 * `fredDirect` carries the fresher point, and `staleSeries` keeps naming the
 * mirror's age rather than letting a reader assume the whole payload is as live
 * as its liveliest field.
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
): Promise<
  | { quotes: unknown[]; spreads?: { "2s10s": number }; fetchedAt: string }
  | { unavailable: string }
> {
  if (env.OW_TV_ENABLED !== "1") {
    return {
      unavailable:
        'OW_TV_ENABLED is not "1"; no live levels, daily series only',
    };
  }
  const bin = env.OPENCLI_BIN;
  if (bin === undefined || bin.trim() === "") {
    return {
      unavailable: "OPENCLI_BIN is unset; no live levels, daily series only",
    };
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
      { close?: unknown; change_abs?: unknown } | undefined;
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
      ...(typeof row?.change_abs === "number"
        ? { changeAbs: row.change_abs }
        : {}),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });
  }
  if (quotes.length === 0) {
    return {
      unavailable: "every TradingView symbol answered without a numeric close",
    };
  }
  // The one curve spread anyone quotes, subtracted here so nobody quotes it
  // from memory. Yields arrive in percent, so the difference is x100 for bps.
  // Absent when either leg did not answer: a half-computed spread is worse
  // than none.
  const level = (label: string) =>
    (quotes as Array<{ name?: unknown; last?: unknown }>).find(
      (quote) => quote.name === label,
    )?.last;
  const two = level("2y");
  const ten = level("10y");
  const spreads =
    typeof two === "number" && typeof ten === "number"
      ? { "2s10s": Number(((ten - two) * 100).toFixed(1)) }
      : undefined;
  return {
    quotes,
    ...(spreads === undefined ? {} : { spreads }),
    fetchedAt: new Date().toISOString(),
  };
}

/** The FRED ids TradingView can quote. What is NOT in here is what
 *  `staleSeries` names and what `fredDirect` fetches — one set, so the two
 *  halves cannot drift into disagreeing about which series has a live twin. */
const TV_TWIN_IDS = new Set(
  TV_LIVE.flatMap((e) => (e.fredId === undefined ? [] : [e.fredId])),
);

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
  const newest = new Map<string, string>();
  for (const row of rows) {
    const id = row.series_id;
    const obs = row.obs_date;
    if (typeof id !== "string" || typeof obs !== "string") continue;
    if (TV_TWIN_IDS.has(id)) continue;
    const seen = newest.get(id);
    if (seen === undefined || obs > seen) newest.set(id, obs);
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return [...newest]
    .map(([seriesId, latestObs]) => ({
      seriesId,
      latestObs,
      ageDays: Math.round(
        (today - Date.parse(`${latestObs}T00:00:00Z`)) / 86_400_000,
      ),
    }))
    .filter((entry) => entry.ageDays >= 1)
    .sort(
      (a, b) =>
        b.ageDays - a.ageDays || a.seriesId.localeCompare(b.seriesId, "en"),
    );
}

/** No API key and no tier: FRED's own graph endpoint answers CSV. Verified
 *  2026-09-03 09:51 UTC, `?id=BAMLH0A0HYM2` → `observation_date,BAMLH0A0HYM2`
 *  rows ending `2026-09-01,2.65`. */
const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const FRED_SOURCE = "FRED direct (fredgraph.csv), ~1-2 day lag";

type FredPoint = {
  series: string;
  value: number;
  asOf: string;
  source: string;
};
type FredSkip = { series: string; reason: string };

/**
 * The last row that carries a NUMBER, not merely the last row.
 *
 * FRED dates every calendar row and writes `.` where there is no observation,
 * so a holiday or a not-yet-published day sits at the bottom of the file.
 * Taking the final line would hand back a NaN, or a date with nothing under
 * it; scanning backwards for a parseable value is what keeps the date and the
 * value the same observation.
 */
export function parseFredCsv(
  csv: string,
): { value: number; asOf: string } | undefined {
  const lines = csv.split("\n");
  for (let at = lines.length - 1; at >= 1; at -= 1) {
    const [asOf, raw] = (lines[at] ?? "").trim().split(",");
    if (asOf === undefined || raw === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) continue;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) continue;
    return { value, asOf };
  }
  return undefined;
}

/**
 * One FRED point per series TradingView cannot quote, fetched together.
 *
 * argon's mirror is the HISTORY and stays the primary result; this is the
 * fresher point next to it, so it never throws — a failure comes back as a
 * named `skipped` line and never as an estimate. The laptop cannot reach this
 * host at all (SSL fails), the mini can, and that difference has to read as a
 * reason rather than as a number.
 *
 * `Promise.all` because eight sequential round trips inside a launchd-timed
 * phase is eight times the wall clock for the same eight answers.
 */
export async function fredDirect(
  series: readonly string[],
  ctx?: ToolRunContext,
  until?: string,
): Promise<{ points: FredPoint[]; skipped: FredSkip[] }> {
  const doFetch = ctx?.fetchImpl ?? fetch;
  const settled = await Promise.all(
    series.slice(0, 8).map(async (id): Promise<FredPoint | FredSkip> => {
      const url = new URL(FRED_CSV);
      url.searchParams.set("id", symbolLiteral(id, "ow_macro_rates"));
      // 2026-09-05, as-of: `coed` (cut-off end date) is what makes the CSV
      // STOP at the replayed day, and `parseFredCsv` then takes the last row
      // that carries a number — the same rule as a live run, applied to a
      // shorter file. `cosd` only bounds the download. ASSUMED, from
      // fredgraph.csv's documented query parameters; not re-fetched here,
      // because this host cannot reach the FRED CDN at all (the tool comment
      // above records that the laptop's SSL fails and the mini's does not). If
      // a future run shows `asOf` past the last row, the observation date on
      // the point is the tell — it is carried on every point. `cosd` (the
      // start date) is deliberately NOT set: it would only shrink a download
      // that is already one column of dates, and a second bound is a second
      // thing to get wrong.
      // 2026-09-05: `until` is the day BEFORE the as-of day, computed by the
      // caller under the same rule as the SQL cuts — a daily series' row for
      // day D is not published until D has closed, and the first replay quoted
      // an 09-02 DGS10 into an 09-02 premarket brief.
      if (until !== undefined) url.searchParams.set("coed", until);
      try {
        const response = await doFetch(url, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          return {
            series: id,
            reason: `fredgraph.csv returned ${String(response.status)} ${response.statusText}`,
          };
        }
        const point = parseFredCsv(await response.text());
        if (point === undefined) {
          return {
            series: id,
            reason: "fredgraph.csv carried no numeric observation",
          };
        }
        return { series: id, ...point, source: FRED_SOURCE };
      } catch (error: unknown) {
        return {
          series: id,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const points: FredPoint[] = [];
  const skipped: FredSkip[] = [];
  for (const row of settled) {
    if ("value" in row) points.push(row);
    else skipped.push(row);
  }
  return { points, skipped };
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
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  const doFetch = ctx?.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    // ponytail: a bare fetch has no timeout at all, so one hung UW connection
    // held a whole phase open until launchd gave up on it.
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

/** One argon FastAPI call. No credential — argon's own API takes none for
 *  these routes — so the only failure modes are "unreachable" and a non-2xx
 *  status, both named with the host and path so a gap is actionable rather
 *  than a bare network error. */
async function argonGet(
  tool: string,
  base: string,
  path: string,
  ctx?: ToolRunContext,
): Promise<unknown> {
  const url = new URL(path, base);
  const doFetch = ctx?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error: unknown) {
    throw new Error(
      `${tool}: argon unreachable at ${url.host}${url.pathname} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

/** One ticker's compact price-anchor row for ow_argon_levels. Every one of
 *  the four argon calls is awaited independently (Promise.allSettled) so a
 *  single sub-endpoint being down (404, timeout, argon mid-deploy) degrades
 *  that ticker's row rather than the whole call — `unavailable` names which
 *  ones did not answer and why. */
async function argonLevelsForTicker(
  tool: string,
  base: string,
  ticker: string,
  ctx?: ToolRunContext,
): Promise<
  Record<string, unknown> & { ticker: string; unavailable?: string[] }
> {
  const encoded = encodeURIComponent(ticker);
  const calls: Array<[string, string]> = [
    ["dealer", `/api/regime/dealer?ticker=${encoded}`],
    ["gex", `/api/regime/gex?ticker=${encoded}`],
    ["magnets", `/api/stock/${encoded}/magnets`],
    ["technicals", `/api/stock/${encoded}/technicals/live`],
  ];
  const settled = await Promise.allSettled(
    calls.map(([key, path]) =>
      argonGet(tool, base, path, ctx).then((body) => [key, body] as const),
    ),
  );
  const ok = new Map<string, Record<string, unknown>>();
  const unavailable: string[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const [key, body] = outcome.value;
      ok.set(key, body as Record<string, unknown>);
    } else {
      unavailable.push(
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
      );
    }
  }
  const dealer = ok.get("dealer") as
    | {
        spot?: number;
        closest_levels?: Array<Record<string, unknown>>;
        odte_share_pct?: number;
      }
    | undefined;
  const gex = ok.get("gex") as
    | {
        spot?: number;
        data_date?: string;
        levels?: Record<string, { strike?: number } | undefined>;
        expected_range?: { low?: number; high?: number };
        mq?: { hvl?: number } | null;
      }
    | undefined;
  const magnets = ok.get("magnets") as
    | {
        as_of?: string;
        levels?: {
          support?: number;
          resistance?: number;
          sma20?: number;
          pivot_a?: { price?: number };
          pivot_b?: { price?: number };
        };
      }
    | undefined;
  const technicals = ok.get("technicals") as { spot?: number } | undefined;

  const out: Record<string, unknown> & {
    ticker: string;
    unavailable?: string[];
  } = { ticker };

  // Freshest spot wins: technicals/live is a live tape read, gex/dealer are
  // the same scan's own spot, magnets carries only yesterday's close.
  if (technicals?.spot !== undefined)
    out.spot = { value: technicals.spot, source: "technicals/live" };
  else if (gex?.spot !== undefined)
    out.spot = { value: gex.spot, source: "gex" };
  else if (dealer?.spot !== undefined)
    out.spot = { value: dealer.spot, source: "dealer" };

  const ml = magnets?.levels;
  if (ml !== undefined) {
    const technical: Record<string, unknown> = {};
    if (ml.support !== undefined) technical.support = ml.support;
    if (ml.resistance !== undefined) technical.resistance = ml.resistance;
    if (ml.pivot_a?.price !== undefined) technical.pivot_a = ml.pivot_a.price;
    if (ml.pivot_b?.price !== undefined) technical.pivot_b = ml.pivot_b.price;
    if (ml.sma20 !== undefined) technical.sma20 = ml.sma20;
    if (Object.keys(technical).length > 0) {
      out.technical = technical;
      out.technicalAsOf = magnets?.as_of;
    }
  }

  const gl = gex?.levels;
  if (gl !== undefined) {
    const gamma: Record<string, unknown> = {};
    if (gl.gex_flip?.strike !== undefined) gamma.gex_flip = gl.gex_flip.strike;
    if (gl.call_wall?.strike !== undefined)
      gamma.call_wall = gl.call_wall.strike;
    if (gl.put_wall?.strike !== undefined) gamma.put_wall = gl.put_wall.strike;
    if (gl.max_magnet?.strike !== undefined)
      gamma.max_magnet = gl.max_magnet.strike;
    // mq (ManaQuant's own hvl snapshot) is nullable per-ticker on argon's own
    // schema — absent here, not zero, when argon has none for this scan.
    if (gex?.mq?.hvl !== undefined && gex.mq.hvl !== null)
      gamma.hvl = gex.mq.hvl;
    if (Object.keys(gamma).length > 0) {
      out.gamma = gamma;
      out.gammaAsOf = gex?.data_date;
    }
  }

  if (Array.isArray(dealer?.closest_levels)) {
    // `gamma` is KEPT, not dropped. It is the only per-strike exposure
    // MAGNITUDE any tool in this tenant returns — the gex endpoint's own
    // `levels` map is flattened to strikes above, and ow_uw_gex answers a
    // single aggregate spot-gamma number. Without it the renderer can print
    // where the walls are but not how big they are, which is the difference
    // between a ladder and a profile.
    out.closest_levels = dealer.closest_levels.map((level) => ({
      label: level.label,
      role: level.role,
      strike: level.strike,
      distance_pct: level.distance_pct,
      ...(typeof level.gamma === "number" ? { gamma: level.gamma } : {}),
    }));
  }
  if (dealer?.odte_share_pct !== undefined)
    out.odte_share_pct = dealer.odte_share_pct;

  if (
    gex?.expected_range?.low !== undefined &&
    gex.expected_range.high !== undefined
  ) {
    out.expected_range = {
      low: gex.expected_range.low,
      high: gex.expected_range.high,
    };
  }

  const asOf = gex?.data_date ?? magnets?.as_of;
  if (asOf !== undefined) out.as_of = asOf;
  if (unavailable.length > 0) out.unavailable = unavailable;
  return out;
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
): Promise<
  { exchange: string; close: number; changeAbs?: number } | undefined
> {
  if (env.OW_TV_ENABLED !== "1")
    throw new Error(`OW_TV_ENABLED is not "1"; ${tool} is disabled`);
  const bin = need(env, "OPENCLI_BIN", tool);
  const ticker = symbolLiteral(raw, tool);
  for (const exchange of ["NASDAQ", "AMEX", "NYSE"]) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        bin,
        [
          "tradingview",
          "quote",
          "--ticker",
          ticker,
          "--exchange",
          exchange,
          "-f",
          "json",
        ],
        { timeout: 30_000 },
      ));
    } catch {
      continue;
    }
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    const row = (Array.isArray(parsed) ? parsed[0] : parsed) as
      { close?: unknown; change_abs?: unknown } | undefined;
    if (typeof row?.close !== "number") continue;
    return {
      exchange,
      close: row.close,
      ...(typeof row.change_abs === "number"
        ? { changeAbs: row.change_abs }
        : {}),
    };
  }
  return undefined;
}

/**
 * The spot, from whichever source THIS MACHINE actually has.
 *
 * TradingView is a desktop GUI app driven over CDP by opencli, so its
 * availability is a property of a MACHINE AND A MOMENT, not of the codebase.
 * Both boxes have it (mini: /usr/local/bin/opencli, TradingView.app logged in,
 * verified 2026-09-02) — but the app can be closed, the CDP port down, or the
 * session logged out, and none of those announce themselves. An earlier comment
 * here asserted the mini had no opencli at all; that came from a non-login
 * `ssh macmini command -v opencli`, whose PATH omits /usr/local/bin. Do not
 * re-derive machine facts from a shell whose PATH you did not print.
 *
 * So the second source is not a mini-only crutch, it is the answer to "TV is a
 * GUI app". Unusual Whales answers the same question over the credential the
 * chain already requires, so the fallback costs no new secret and no new
 * dependency.
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
): Promise<
  | {
      source: string;
      close: number;
      changeAbs?: number;
      prevClose?: number;
      changePct?: number;
      marketTime?: string;
    }
  | undefined
> {
  // `changePct` is computed HERE, in code, so the regime step can compare a
  // move to a threshold without doing the subtraction itself — the one
  // arithmetic step a model gets wrong. Two decimals; absent when there is no
  // prior close to measure from.
  const change = (
    close: number,
    prevClose: number | undefined,
  ): { prevClose?: number; changePct?: number } =>
    prevClose === undefined || prevClose <= 0
      ? {}
      : {
          prevClose,
          changePct:
            Math.round(((close - prevClose) / prevClose) * 10000) / 100,
        };
  if (env.OW_TV_ENABLED === "1" && (env.OPENCLI_BIN ?? "") !== "") {
    const hit = await tvLast(env, tool, raw);
    if (hit !== undefined) {
      return {
        source: hit.exchange,
        close: hit.close,
        ...(hit.changeAbs === undefined ? {} : { changeAbs: hit.changeAbs }),
        ...change(
          hit.close,
          hit.changeAbs === undefined ? undefined : hit.close - hit.changeAbs,
        ),
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
    ...(typeof row.market_time === "string"
      ? { marketTime: row.market_time }
      : {}),
    // A row whose `close` fell back to `prev_close` is a 0.00% move by
    // construction, which is what a session that has not printed IS.
    ...change(close, numeric(row.prev_close)),
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
):
  | { root: string; expiry: string; right: "C" | "P"; strike: number }
  | undefined {
  const match = /^([A-Z0-9.]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/u.exec(
    symbol,
  );
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

/** A UW tide is one print per minute for the whole RTH session -- 390 of them,
 *  ~139 KB across the three tides, and no persona in team.yaml reads a single
 *  minute: they read the SHAPE and the last level. Thinned across (never a tail
 *  window, see thinAcross) the shape and both ends survive at a fifth the size.
 *  Trimming the tool is issue #81's job; this is the one field measured at
 *  2026-09-03 sizes to sit above the 128 KiB spill ceiling with no reader. */
const TIDE_PRINTS = 80;

/**
 * A tide with every print later than `cut` removed, plus how many survived.
 *
 * 2026-09-05. VERIFIED: a tide answers `{ data: [...] }` and each print is
 * individually timestamped — the tool already thins that array. ASSUMED: the
 * field is `timestamp`, with `time`/`date` tried as fallbacks; a print whose
 * stamp does not parse is DROPPED, because a print that cannot be dated cannot
 * be shown to predate the instant, and one leaked print is the whole defect.
 */
function trimTide(tide: unknown, cut: number): { body: unknown; kept: number } {
  if (tide === null || typeof tide !== "object") return { body: tide, kept: 0 };
  const body = tide as { data?: unknown };
  if (!Array.isArray(body.data)) return { body: tide, kept: 0 };
  const data = body.data.filter((print) => {
    const row = print as Record<string, unknown>;
    const at = Date.parse(String(row.timestamp ?? row.time ?? row.date ?? ""));
    return Number.isFinite(at) && at <= cut;
  });
  return { body: { ...body, data }, kept: data.length };
}

function thinTide(tide: unknown): unknown {
  if (tide === null || typeof tide !== "object") return tide;
  const body = tide as { data?: unknown };
  if (!Array.isArray(body.data)) return tide;
  return { ...body, data: thinAcross(body.data, TIDE_PRINTS) };
}

/** The bound on how much prior PROSE ow_reports may hand back. It rode on the
 *  context-spill ceiling until that ceiling was measured and raised to 128 KiB;
 *  this number is about a model filling a gap from a wall of narrative, not
 *  about context cost, so it keeps its own 8 KB. */
const REPORTS_PROSE_CEILING_BYTES = 8 * 1024;

/** Yesterday's brief is background, not evidence: it exists so the editor can
 *  write "what changed", and a real premarket report is 17 KB on disk. Two
 *  thousand characters is the headline, the decision block and the opening of
 *  each section — enough to diff against, too little to copy from. */
const PRIOR_BRIEF_CEILING_CHARS = 2000;

/** The zone the report filenames are stamped in — the tenant's own
 *  `reportTimezone`. Named here rather than read off this process's clock so
 *  "yesterday" means the same calendar day the filenames do. */
const REPORT_ZONE = "America/New_York";

const PriorBriefParams = z.object({
  phase: z
    .enum(["premarket", "intraday", "close", "weekly", "frank"])
    .optional(),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

/** The PROSE half of a prior brief's JSON document, never the numbers — a
 *  fresh tool answers those better and this text is a day old. Section bodies
 *  are cut to their opening because a delta needs the CLAIM, not the whole
 *  argument, and one long section would otherwise spend the whole ceiling. */
function pickBriefProse(doc: Record<string, unknown>): Record<string, unknown> {
  const sections = Array.isArray(doc.sections)
    ? doc.sections.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const { title, body } = entry as Record<string, unknown>;
        if (typeof title !== "string" || typeof body !== "string") return [];
        return [{ title, body: body.slice(0, 240) }];
      })
    : [];
  return {
    ...(typeof doc.headline === "string" ? { headline: doc.headline } : {}),
    ...(doc.decision !== null && typeof doc.decision === "object"
      ? { decision: doc.decision }
      : {}),
    ...(sections.length === 0 ? {} : { sections }),
  };
}

function round4(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number(value.toFixed(4));
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const TvParams = z.object({
  flagColors: z
    .array(z.enum(["red", "orange", "yellow", "green", "blue", "purple"]))
    .optional(),
});
// The cap carries its own instruction. A bare Zod `too_big` reaches the model
// as a path and a number, and on 2026-09-03 gex-reporter answered it by
// re-calling with the same 63 tickers — one wasted round trip per phase. The
// message is the cheapest place to say what to do instead.
const SpotParams = z.object({
  tickers: z.array(z.string().min(1)).min(1).max(24, {
    message:
      "ow_spot takes at most 24 tickers per call — split the list into batches of 24 or fewer and call again",
  }),
});
const LegParams = z.object({
  right: z.enum(["call", "put"]),
  action: z.enum(["buy", "sell"]),
  strike: z.number().positive(),
  expiry: z.string().min(1),
  ratio: z.number().positive().optional(),
  mid: z.number().optional(),
});
const PriceStructureParams = z.object({
  legs: z.array(LegParams).min(1).max(8),
  spot: z.number().positive().optional(),
});
const StrikeCheckParams = z.object({
  ticker: z.string().min(1),
  strikes: z
    .array(
      z.object({
        strike: z.number().positive(),
        right: z.enum(["call", "put"]),
      }),
    )
    .min(1)
    .max(20),
});
const NoParams = z.object({});
const UwChainParams = z.object({
  ticker: z.string().min(1),
  minDte: z.number().int().nonnegative(),
  maxDte: z.number().int().positive(),
  strikeWindowPct: z.number().positive().max(50).optional(),
  minOpenInterest: z.number().int().nonnegative().optional(),
});
const TickerMetricsParams = z.object({
  tickers: z.array(z.string().min(1)).min(1).max(25),
});
// sector and etf are REQUIRED: the tide endpoints are per-sector and per-ETF,
// and picking a default here would be picking a market view on the caller's
// behalf.
const MarketStateParams = z.object({
  sector: z.string().min(1),
  etf: z.string().min(1),
});
const FRANK_PUBLICATION = "https://franktrading.substack.com";

const ReportsParams = z.object({
  phase: z.string().min(1).max(64).optional(),
  days: z.number().int().min(1).max(10),
  /** Task ids whose prose to include on top of the ledger. Absent means the
   *  ledger alone, which is what a settlement step wants. */
  steps: z.array(z.string().min(1).max(64)).max(6).optional(),
});

/** `## <task> — <role>`, written by the CLI's own report writer. Splitting on
 *  it is not guesswork about a model's formatting: both ends of this are ours. */
const STEP_HEADING = /^## ([a-z0-9-]+) — .*$/gmu;

function stepsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const found = [...markdown.matchAll(STEP_HEADING)];
  for (let i = 0; i < found.length; i += 1) {
    const here = found[i]!;
    const start = here.index + here[0].length;
    const end = i + 1 < found.length ? found[i + 1]!.index : markdown.length;
    out.set(here[1]!, markdown.slice(start, end).trim());
  }
  return out;
}

/** `option-wizard-2026-09-02-premarket.md` -> {date, phase}. Anything that does
 *  not match is not one of our reports and is ignored rather than guessed at. */
const REPORT_NAME = /^option-wizard-(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/u;

const EarningsParams = z.object({
  tickers: z.array(z.string().min(1).max(8)).min(1).max(12),
});

const GexParams = z.object({
  tickers: z.array(z.string().min(1).max(8)).max(12).optional(),
});
const ArgonLevelsParams = z.object({
  tickers: z.array(z.string().min(1).max(8)).min(1).max(12),
});
const MacroParams = z.object({
  series: z.array(z.string().min(1)).min(1).max(24).optional(),
  lookbackDays: z.number().int().positive().max(3650).optional(),
});
const BarsParams = z.object({
  symbol: z.string().min(1),
  assetClass: z
    .enum(["equity", "index", "rates", "crypto", "futures"])
    .optional(),
  timeframe: z.string().min(1).optional(),
  lookbackDays: z.number().int().positive().max(3650).optional(),
});

const IvTermParams = z.object({
  tickers: z.array(z.string().min(1).max(8)).min(1).max(3),
});
const HeadlinesParams = z.object({
  searchTerm: z.string().min(1).max(64).optional(),
  ticker: z.string().min(1).max(8).optional(),
  limit: z.number().int().positive().max(25).optional(),
  majorOnly: z.boolean().optional(),
});
/**
 * The only handles this tool will read. Free-form handles are forbidden
 * because a wrong one answers confidently: `@gregip` (verified 2026-09-03)
 * resolves to an unrelated Polish account, and its posts would have entered a
 * macro read as a Fed reporter's. Every handle here was fetched live on
 * 2026-09-03 and is the person the label claims.
 */
const X_HANDLES = [
  "NickTimiraos",
  "GregDaco",
  "Claudia_Sahm",
  "federalreserve",
  "AnnaEconomist",
] as const;
const XPostsParams = z.object({
  handle: z.enum(X_HANDLES),
  limit: z.number().int().positive().max(20).optional(),
});
/**
 * Commodities TradingView actually quotes, each verified live on 2026-09-03 on
 * this laptop. TVC:USOIL, TVC:UKOIL and TVC:COPPER are NOT here: all three
 * answered "No quote returned — verify the exchange", so the front futures
 * contract is used for oil and copper instead. A symbol that stops answering
 * is dropped from the payload rather than reported as zero.
 */
const TV_COMMODITIES: ReadonlyArray<{
  label: string;
  ticker: string;
  exchange: string;
}> = [
  { label: "gold", ticker: "GOLD", exchange: "TVC" },
  { label: "silver", ticker: "SILVER", exchange: "TVC" },
  { label: "WTI crude", ticker: "CL1!", exchange: "NYMEX" },
  { label: "Brent crude", ticker: "BZ1!", exchange: "NYMEX" },
  { label: "copper", ticker: "HG1!", exchange: "COMEX" },
  { label: "natgas", ticker: "NG1!", exchange: "NYMEX" },
];

/** The most recently modified `.md` under `<root>/<dir>/`. Absent root, absent
 *  file and an empty tree are all "no article", reported by the caller as the
 *  failure it is — never as an empty string that reads like a silent Frank. */
async function newestMarkdown(root: string): Promise<string | undefined> {
  let best: { path: string; mtimeMs: number } | undefined;
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return undefined;
  }
  for (const entry of dirs) {
    let names: string[];
    try {
      names = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = join(root, entry, name);
      const info = await stat(path);
      if (best === undefined || info.mtimeMs > best.mtimeMs)
        best = { path, mtimeMs: info.mtimeMs };
    }
  }
  return best === undefined ? undefined : readFile(best.path, "utf8");
}

/**
 * Frank's real article slugs are date-prefixed — `/p/12292025-trading-recap-
 * and-outlook`. The publication listing also carries evergreen index pages
 * (`/p/weekly-recap-and-outlook`), which are a wall of "Read full story"
 * links and no article at all; one of those returned as "Frank's newest note"
 * is a whole run comparing our view against nothing.
 */
export function isDatedPostUrl(url: string): boolean {
  const at = url.indexOf("/p/");
  if (at < 0) return false;
  return /^\d{6,8}(?:[^0-9]|$)/u.test(url.slice(at + 3));
}

/** The first dated article link on an index page, or undefined. */
export function firstDatedPostUrl(markdown: string): string | undefined {
  for (const match of markdown.matchAll(/https?:\/\/[^\s)\]"'>]+/gu)) {
    const url = match[0].replace(/[.,)]+$/u, "");
    if (isDatedPostUrl(url)) return url;
  }
  return undefined;
}

/**
 * The tools with no dated archive behind them, mapped to the source that has
 * none — a live quote, a live chain, a live account, a live browser session.
 * In an as-of replay each one refuses BEFORE the network, which is the whole
 * point: a live source asked about last Tuesday answers about today, and an
 * answer about today inside a replay is worse than no answer at all.
 *
 * 2026-09-05, what was checked and what was assumed: assumed for all thirteen.
 * None of these routes has a documented dated form we use — TradingView's
 * opencli quote route, xenon's live account/greeks endpoints, argon's live
 * regime views and UW's chain/metrics/GEX/earnings/IV-term/headlines endpoints
 * are read here in their current-value form only. Where UW does expose a
 * historic variant (`/api/historic_chains`, dated GEX), wiring it is separate
 * work; until then the honest answer is "unavailable", not a today value with
 * a past label on it.
 */
const AS_OF_BLIND: ReadonlyMap<string, string> = new Map([
  ["ow_tv_watchlist", "TradingView"],
  ["ow_spot", "the live quote route"],
  ["ow_strike_check", "the live quote route"],
  ["ow_argon_levels", "argon's live regime API"],
  ["ow_ib_positions", "xenon's live account API"],
  ["ow_uw_chain", "the Unusual Whales chain endpoint as used here"],
  ["ow_uw_ticker_metrics", "the Unusual Whales ticker-metrics endpoint"],
  ["ow_uw_gex", "the Unusual Whales exposure endpoints as used here"],
  ["ow_uw_earnings", "the Unusual Whales earnings endpoint"],
  ["ow_uw_iv_term", "the Unusual Whales IV-term endpoint"],
  ["ow_uw_headlines", "the Unusual Whales news endpoint"],
  ["ow_tv_commodities", "TradingView"],
  // 2026-09-05: moved here after the first replay. GET
  // /api/market/economic-calendar carries a SHORT FORWARD window and nothing
  // behind it — it answered with 0 rows on 2026-09-05 — so a past instant gets
  // either an empty list or the wrong week. Client-side filtering cannot
  // recover a window the endpoint never returned, and an empty list read as a
  // finding: the regime step wrote "the calendar is empty" as if that were
  // news about the replayed day.
  ["ow_uw_calendar", "economic calendar"],
  ["ow_frank", "the Substack reader (no dated archive access here)"],
]);

/**
 * ` AND <column> < DATE 'yyyy-mm-dd'`, or nothing when there is no as-of day.
 * The date is produced by Intl, never by a caller, so it cannot carry SQL.
 *
 * 2026-09-05, strictly LESS THAN and not `<=`: a daily-keyed record for day D
 * is only known once D has closed, so at 08:45 ET on 09-02 the row keyed 09-02
 * did not exist yet. The first replay quoted a 09-02 DGS10, a 09-02 policy
 * snapshot and 09-02 argon metrics into an 09-02 premarket brief — each one a
 * number from later that same day, and each indistinguishable from a real
 * premarket read. Exported so the rule can be tested without a database.
 */
export function dateCutSql(
  column: string,
  asOfDay: string | undefined,
): string {
  return asOfDay === undefined ? "" : ` AND ${column} < DATE '${asOfDay}'`;
}

/** The calendar day before `day`, both `yyyy-mm-dd`. Plain calendar
 *  arithmetic on a date-only string: parsed as UTC midnight and written back
 *  the same way, so no zone can move it. */
function priorDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/**
 * The last OPEN day before `day`, per the calendar the tenant declares. Both
 * `yyyy-mm-dd`.
 *
 * The closures are not guessed here: they are the `calendar:` block in
 * `tenant.yaml`, hand-maintained from nyse.com, and this walks back over them
 * the same way it walks back over a weekend. With no calendar passed it falls
 * back to weekends only, which is what this did before the block existed — a
 * closed day then answers with an empty session labelled `prior`, honest but
 * useless, and that is exactly the outcome the declaration removes.
 *
 * Exported so the walk can be tested without building a tool.
 */
export function priorOpenDay(
  day: string,
  calendar?: { weekdaysOnly: boolean; closed: string[] },
): string {
  const closed = new Set(calendar?.closed ?? []);
  const weekends = calendar === undefined || calendar.weekdaysOnly;
  const shut = (d: string): boolean =>
    closed.has(d) ||
    (weekends && new Date(`${d}T00:00:00Z`).getUTCDay() % 6 === 0);
  let out = priorDay(day);
  // Bounded: a run of closed days longer than a fortnight is a broken
  // declaration, not a holiday, and looping forever on it would hang the run.
  for (let step = 0; step < 14 && shut(out); step += 1) out = priorDay(out);
  return out;
}

const AS_OF_BLIND_SENTENCE =
  "Unavailable in an as-of replay: this source is live-only and returns nothing for a past instant. Record that only in Layer Coverage; never write about the gap in a headline, title or section body.";

export function buildTools(cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
  /** Point-in-time replay instant. Undefined is an ordinary run and every
   *  tool below behaves exactly as it did before this flag existed. */
  asOf?: Date;
  variant?: string;
  pit?: { markUnavailable: (tool: string, reason: string) => void };
  /** The tenant's `calendar:` block, passed through by the runner. Absent in a
   *  test or an older host: the prior-day walk then skips weekends only. */
  calendar?: { weekdaysOnly: boolean; closed: string[] };
}) {
  const { env } = cfg;
  const asOf = cfg.asOf;
  const asOfIso = asOf?.toISOString();
  // The as-of DAY in the zone this tenant files its reports in. Every dated
  // filter below is a date, not an instant, and taking that date off the
  // process clock's zone is how a replay of a US morning reads as the previous
  // day — the same trap ow_reports and ow_prior_brief already document.
  const asOfDay =
    asOf === undefined
      ? undefined
      : new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_ZONE }).format(
          asOf,
        );
  const dateCut = (column: string): string => dateCutSql(column, asOfDay);
  const built = [
    {
      // opencli's TradingView adapter is read-only and drives the LOCAL app over
      // CDP. Installed on both boxes, but a GUI app is never a guarantee: it can
      // be closed or its debugging port down, so its absence at run time is a
      // degraded run, not a failed one (spec §5, §7). Surface
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
          description:
            "Colored flag lists: red, orange, yellow, green, blue, purple",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { flagColors } = TvParams.parse(args);
        // OW_UNIVERSE is the OPERATOR's list, not a guess made here: this tool
        // will not invent a universe, it will only read the one someone wrote
        // down. It says so in `source`, because a frozen list and today's flags
        // are not the same thing and a reader must be able to tell.
        const operatorUniverse = (why: string): string => {
          const listed = (env.OW_UNIVERSE ?? "")
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry) => entry !== "");
          if (listed.length === 0) {
            throw new Error(
              `ow_tv_watchlist: ${why}, and OW_UNIVERSE names no fallback tickers, so there ` +
                "is no universe to build. Refusing to return an empty one, which reads as a " +
                "market with nothing in it.",
            );
          }
          return JSON.stringify({
            source: "operator list (OW_UNIVERSE)",
            note:
              `TradingView was not usable on this run (${why}). These are the tickers the ` +
              "operator listed, not today's flagged watchlists — the list is as current as " +
              "whoever set it.",
            tickers: [...new Set(listed)].sort((a, b) =>
              a.localeCompare(b, "en"),
            ),
            fetchedAt: new Date().toISOString(),
          });
        };
        const tvHere =
          env.OW_TV_ENABLED === "1" && (env.OPENCLI_BIN ?? "") !== "";
        if (!tvHere) {
          return operatorUniverse(
            "TradingView is not enabled here (needs OW_TV_ENABLED=1 and OPENCLI_BIN)",
          );
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
            // TradingView is a GUI app: closed, mid-update, or CDP port down are
            // all normal, and none of them mean "the market is empty". Fall back
            // to the operator list rather than failing the whole run — but SAY
            // which one the reader is looking at.
            return operatorUniverse(
              `${bin} ${argv.join(" ")} failed — ${
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
            // TradingView symbols carry their exchange ("NASDAQ:AAPL"), and that
            // prefix is the only reliable way to tell an optionable US listing
            // from the rest of what a real watchlist holds. Captured live from
            // the mini's own lists, 2026-09-02: 170 of 253 entries are
            // NASDAQ/AMEX/NYSE, and the other 83 are section HEADERS with no
            // prefix at all ("###BOND", "###SECTION 1" — 26 of them), futures
            // (CME_MINI:ES1!, NYMEX:CL1!), forex (FX:EURUSD), crypto
            // (BITSTAMP:BTCUSD), foreign listings (KRX:000660, TSE:6981) and
            // index pseudo-tickers (TVC:NDX, CBOE:VIX, SPCFD:SPX).
            //
            // Taking the bare ticker off every one of those put "###BOND" and
            // "ES1!" into the universe handed to the designer. That is the
            // 420/410 failure wearing a different hat: a plausible-looking
            // string in a slot that is supposed to hold a tradeable instrument.
            // Filtering on the exchange rather than on the ticker's SHAPE is
            // what makes this stable — no regex can tell SPY from SPX, but the
            // venue always can.
            for (const symbol of parts) {
              if (typeof symbol !== "string") continue;
              const trimmed = symbol.trim();
              const colon = trimmed.indexOf(":");
              if (colon === -1) continue;
              if (!US_EQUITY_VENUES.has(trimmed.slice(0, colon).toUpperCase()))
                continue;
              const ticker = trimmed.slice(colon + 1).trim();
              if (ticker !== "") symbols.add(ticker);
            }
          }
        }
        // After every requested colour, not inside the loop: one empty colour
        // among several is a fact about that list, while nothing at all across
        // all of them means the shape changed under us.
        if (symbols.size === 0) {
          return operatorUniverse(
            `${bin} returned watchlists but no symbol could be read from them`,
          );
        }
        return JSON.stringify({
          // This said "`source` on each quote is the exchange..." — copied from
          // ow_spot, describing quotes, in a payload that has none. A wrong note
          // is worse than no note: it is a confident sentence about a field that
          // is not there, aimed at a reader that cannot check.
          source: "TradingView watchlists (live)",
          note:
            "Today's flagged lists, filtered to US equity and ETF listings — " +
            "TradingView section headers, futures, forex, crypto, foreign " +
            "listings and index pseudo-tickers are not optionable and are dropped.",
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
        "Last price for each ticker, from TradingView where this machine has it and from Unusual Whales otherwise. Call this before naming any strike: a strike is only meaningful next to the spot it sits against. At most 24 tickers per call: split a longer universe into batches of 24 or fewer.",
      paramsSchema: SpotParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          required: true,
          description:
            "Ticker symbols, at most 24 per call — split a longer list into batches of 24 or fewer",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { tickers } = SpotParams.parse(args);
        const tool = "ow_spot";
        const quotes: unknown[] = [];
        // The REASON travels with the name. "no price for SPY" and "no price
        // for SPY because this machine has no UW credential" are the same
        // sentence to a reader and different facts to an operator.
        const missing: Array<{ ticker: string; reason: string }> = [];
        // ponytail: ceiling of 6 in flight. A ticker TradingView does not have
        // costs three 30s subprocess timeouts, so 24 names in a row is a
        // 36-minute worst case that outlives the phase window it feeds. Six is
        // the whole fix — batches, not a queue, because the wall time that
        // matters is the slowest ticker's, not the scheduler's elegance.
        const SPOT_CONCURRENCY = 6;
        const settled: Array<{
          ticker: string;
          hit: Awaited<ReturnType<typeof spotOf>>;
          why: string;
        }> = [];
        for (let at = 0; at < tickers.length; at += SPOT_CONCURRENCY) {
          // Order in = order out: each chunk is resolved in place, so the
          // caller's ticker list and the returned quote list still line up.
          settled.push(
            ...(await Promise.all(
              tickers.slice(at, at + SPOT_CONCURRENCY).map(async (raw) => {
                const ticker = symbolLiteral(raw, tool);
                try {
                  return {
                    ticker,
                    hit: await spotOf(env, tool, ticker, ctx),
                    why: "",
                  };
                } catch (error: unknown) {
                  // One unreachable ticker must not take the other twenty-three
                  // with it: it goes on the noPrice list like any other name.
                  return {
                    ticker,
                    hit: undefined,
                    why: error instanceof Error ? error.message : String(error),
                  };
                }
              }),
            )),
          );
        }
        for (const { ticker, hit, why } of settled) {
          // A ticker with no price is NAMED, never dropped and never guessed at.
          // Silence here is what produced the 420 strike on a 707 underlying.
          if (hit === undefined)
            missing.push({
              ticker,
              reason:
                why === ""
                  ? "no quote from TradingView or Unusual Whales"
                  : why,
            });
          else
            quotes.push({
              ticker,
              source: hit.source,
              last: hit.close,
              ...(hit.marketTime === undefined
                ? {}
                : { marketTime: hit.marketTime }),
              ...(hit.changeAbs === undefined
                ? {}
                : { changeAbs: hit.changeAbs }),
              ...(hit.prevClose === undefined
                ? {}
                : { prevClose: hit.prevClose }),
              ...(hit.changePct === undefined
                ? {}
                : { changePct: hit.changePct }),
            });
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
        tickers: {
          type: "array",
          required: true,
          description: "Up to 25 symbols",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { tickers } = TickerMetricsParams.parse(args);
        const list = tickers
          .map((ticker) => `'${symbolLiteral(ticker, "ow_argon_metrics")}'`)
          .join(",");
        const rows = await pgJson(
          env,
          "ow_argon_metrics",
          `SELECT t.ticker,
                  to_jsonb(iv) - 'inserted_at' - 'updated_at_src' AS iv,
                  to_jsonb(gx) - 'payload'                        AS gex,
                  to_jsonb(sk)                                    AS skew
             FROM (SELECT unnest(ARRAY[${list}]) AS ticker) t
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.iv_rank_history r
                                 WHERE r.ticker = t.ticker${dateCut("r.market_date")}
                                 ORDER BY r.market_date DESC LIMIT 1) iv ON true
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.greek_exposure_daily g
                                 WHERE g.ticker = t.ticker${dateCut("g.trade_date")}
                                 ORDER BY g.trade_date DESC LIMIT 1) gx ON true
             LEFT JOIN LATERAL (SELECT * FROM uw_scan.skew_analytics_snapshot s
                                 WHERE s.ticker = t.ticker${dateCut("s.market_date")}
                                 ORDER BY s.market_date DESC LIMIT 1) sk ON true`,
        );
        // 2026-09-05: the `< DATE` cut inside each LIMIT 1 subquery is the
        // whole as-of change here — the LATERAL still takes the newest row,
        // just the newest one that existed BEFORE the replayed day opened; a
        // row keyed to that day was written later that day. VERIFIED
        // against the column names already documented on this tool
        // (market_date / trade_date / market_date); ASSUMED that argon's
        // mirror never back-dates a row it wrote later, which no column here
        // can distinguish.
        return JSON.stringify({
          source: "argon.uw_scan",
          ...(asOfDay === undefined ? {} : { asOf: asOfDay }),
          rows,
        });
      },
    },
    {
      name: "ow_ib_positions",
      description:
        "Open positions, net liquidation and buying power from IB Gateway (read-only).",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(
        _args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const body = (await ibGet(
          env,
          "ow_ib_positions",
          "/portfolio",
          {},
          ctx,
        )) as {
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
        const syncedAt =
          typeof body.last_sync === "string" ? Date.parse(body.last_sync) : NaN;
        if (Number.isNaN(syncedAt)) {
          throw new Error(
            "ow_ib_positions: /portfolio carried no readable last_sync; refusing an undateable account snapshot",
          );
        }
        const ageHours = (Date.now() - syncedAt) / 3_600_000;
        const maxAgeHours = Number(env.OW_IB_MAX_SNAPSHOT_AGE_HOURS ?? "24");
        if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
          throw new Error(
            "OW_IB_MAX_SNAPSHOT_AGE_HOURS is not a positive number; ow_ib_positions has no freshness bound to check against",
          );
        }
        if (ageHours > maxAgeHours) {
          // The raw `last_sync` is NOT quoted here on purpose. xenon writes it
          // without a zone designator (`2026-07-29T20:27:18.543065`), and a
          // role that copies it into a coverage table has two bad options:
          // repeat it zoneless, or append the `Z` it believes is right. The
          // second is what happened on 2026-09-02 — and the as-of gate, which
          // looks for the prose stamp verbatim in the tool output, refused a
          // `Z` the tool never wrote and failed the whole intraday run. The
          // age is the actionable number; an undateable instant is not.
          throw new Error(
            `ow_ib_positions: the account snapshot is ${ageHours.toFixed(1)}h old, ` +
              `past the ${String(maxAgeHours)}h bound. ` +
              "xenon refreshes it with POST /portfolio/sync, which this read-only key cannot call. " +
              "No account figures are returned rather than dating today's risk from a stale book.",
          );
        }
        // Age travels WITH the data, so a consumer that ignores the bound still
        // cannot mistake the vintage.
        return JSON.stringify({
          ...body,
          snapshotAgeHours: Number(ageHours.toFixed(2)),
        });
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
        "Option chain for a ticker within a DTE band, from Unusual Whales: strike, NBBO bid/ask, open interest, IV and greeks, trimmed to the strikes around today's spot. The spot it was trimmed against is returned with it, and every contract carries `otmPct` — its signed distance from that spot, positive out of the money, negative in it. Copy that number; never compute one.",
      paramsSchema: UwChainParams,
      mutating: false,
      dshParams: {
        ticker: {
          type: "string",
          required: true,
          description: "Underlying symbol",
        },
        minDte: {
          type: "number",
          required: true,
          description: "Minimum days to expiry",
        },
        maxDte: {
          type: "number",
          required: true,
          description: "Maximum days to expiry",
        },
        // strikeWindowPct and minOpenInterest stay OUT of the model-facing
        // spec: dsh rejects a parameter declared `required: false`
        // ("unsupported JSON schema: parameters.X.required must be true when
        // present"), and a trimming knob is not a decision a role should be
        // making anyway. The zod schema still accepts both for direct callers.
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
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
          .map(
            (row) =>
              row as {
                expires?: unknown;
                open_interest?: unknown;
                volume?: unknown;
              },
          )
          .filter(
            (row): row is { expires: string } & typeof row =>
              typeof row.expires === "string",
          )
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
                typeof entry.option_symbol === "string"
                  ? parseOcc(entry.option_symbol)
                  : undefined;
              if (parsed === undefined) return [];
              const oi =
                typeof entry.open_interest === "number"
                  ? entry.open_interest
                  : 0;
              if (oi < oiFloor) return [];
              if (Math.abs(parsed.strike - spot.close) / spot.close > window)
                return [];
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
                  // Signed distance from the spot this chain was trimmed on.
                  // Positive is out of the money, negative is in it — the sign
                  // IS the moneyness, and no reader has to subtract anything.
                  otmPct: Number(
                    (
                      ((parsed.right === "C"
                        ? parsed.strike - spot.close
                        : spot.close - parsed.strike) /
                        spot.close) *
                      100
                    ).toFixed(2),
                  ),
                  openInterest: oi,
                  volume:
                    typeof entry.volume === "number" ? entry.volume : undefined,
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
            .sort(
              (a, b) =>
                a.strike - b.strike || a.right.localeCompare(b.right, "en"),
            );
          const trimmed = [
            ...thinAcross(
              contracts.filter((c) => c.right === "P"),
              40,
            ),
            ...thinAcross(
              contracts.filter((c) => c.right === "C"),
              40,
            ),
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
        tickers: {
          type: "array",
          required: true,
          description: "Up to 25 symbols",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
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
      description:
        "Market tide plus one sector tide and one ETF tide from Unusual Whales.",
      paramsSchema: MarketStateParams,
      mutating: false,
      dshParams: {
        sector: {
          type: "string",
          required: true,
          description: "Sector for the sector tide",
        },
        etf: {
          type: "string",
          required: true,
          description: "ETF symbol for the ETF tide",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { sector, etf } = MarketStateParams.parse(args);
        const tool = "ow_uw_market_state";
        // 2026-09-05, as-of: the three tide endpoints take an optional
        // `date=YYYY-MM-DD` and answer for that trading day. VERIFIED for
        // /api/market/market-tide and /api/market/{sector}/sector-tide against
        // the Unusual Whales OpenAPI docs read that day ("Date must be the
        // current or a past date. If no date is given, returns data for the
        // current/last market day"; tide history goes back to 2022-09-28).
        // ASSUMED for /api/market/{etf}/etf-tide by analogy with its two
        // siblings — not read in the docs. An endpoint that ignores an unknown
        // query parameter would answer for today; the reply carries `date`
        // where UW echoes it, and the `dated` key below says what was asked.
        // 2026-09-05, second pass: `date=` alone is NOT point-in-time. The
        // first replay asked for the 09-02 session at 08:45 ET and was handed
        // that day's whole RTH tape — the entire session the premarket brief
        // was supposed to be written before. The prints are individually
        // timestamped, so the fix is to cut them at the instant; when nothing
        // survives (a premarket instant, which is the normal case) the tide
        // for the PRIOR OPEN DAY is fetched instead and labelled as such, so
        // the model reads it as yesterday's tide and not as this morning's.
        const tideFor = async (path: string): Promise<unknown> => {
          if (asOf === undefined || asOfDay === undefined) {
            return thinTide(await uwGet(env, tool, path, {}, ctx));
          }
          const cut = asOf.getTime();
          const today = trimTide(
            await uwGet(env, tool, path, { date: asOfDay }, ctx),
            cut,
          );
          if (today.kept > 0) {
            return {
              session: "as-of",
              date: asOfDay,
              ...(thinTide(today.body) as Record<string, unknown>),
            };
          }
          const prior = priorOpenDay(asOfDay, cfg.calendar);
          return {
            session: "prior",
            date: prior,
            note: `No tide print on ${asOfDay} had happened by ${asOfIso ?? ""}; this is the ${prior} session's tide. It is the PREVIOUS session, not today's.`,
            ...(thinTide(
              await uwGet(env, tool, path, { date: prior }, ctx),
            ) as Record<string, unknown>),
          };
        };
        return JSON.stringify({
          tidePrints: `thinned across the session to <=${String(TIDE_PRINTS)} prints per tide`,
          marketTide: await tideFor("/api/market/market-tide"),
          sectorTide: await tideFor(
            `/api/market/${encodeURIComponent(sector)}/sector-tide`,
          ),
          etfTide: await tideFor(
            `/api/market/${encodeURIComponent(etf)}/etf-tide`,
          ),
        });
      },
    },
    {
      // GET /api/stock/{ticker}/gex-levels?source=vol
      // Verified against the live response 2026-09-02 (SPY):
      //   {"date":"2026-09-02","time":"2026-09-02T17:31:16.000000Z",
      //    "source":"vol","call_wall":"766","gamma_flip":"764.77",
      //    "gamma_magnet":"766","nearby_flips":["764.77","765.16","770.49",
      //    "758.3","771.37"],"put_wall":"764"}
      // Every level is a STRING in the response and stays a string here: the
      // model quotes the level it was given, and a Number() round-trip is how
      // "764.77" becomes 764.7699999 in a trading email.
      // `source=vol` is volume-derived exposure — the same basis UW's own
      // levels page shows. There is no net GEX/DEX total on this endpoint.
      //
      // GET /api/stock/{ticker}/spot-exposures
      // Verified live 2026-09-03 (SPY): {"data":[{"time":
      //   "2026-09-03T10:30:40.099000Z","ticker":"SPY","start_time":
      //   "2026-09-03T10:30:00.000000Z","price":"764.55",
      //   "gamma_per_one_percent_move_oi":"-17753186963.86",
      //   "charm_per_one_percent_move_oi":"-656557390747.5",
      //   "vanna_per_one_percent_move_oi":"563446443.17", ...}, ...]} — plus
      // *_dir/*_vol variants that were "0" in that snapshot. Every value is a
      // STRING and stays one here for the same reason as the levels above.
      // `limit` is IGNORED by this endpoint: `?limit=1` and `?limit=3` both
      // returned the full session, ~180 rows, OLDEST FIRST. There is no
      // server-side way to ask for only the latest row, so the tool fetches
      // the whole array and picks the row with the max `time` itself — the
      // array is never returned to the caller, only that one row. This is
      // the only real timestamp for net gamma exposure UW exposes; the old
      // ow_argon_metrics net GEX/DEX row carried `trade_date` only (a date,
      // no time), which fails the as-of-verbatim gate.
      name: "ow_uw_gex",
      description:
        "Unusual Whales GEX levels per ticker: call wall, put wall, gamma flip, gamma magnet, nearby flips, and spot gamma exposure per 1% move, each with the as-of time UW returned.",
      paramsSchema: GexParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          description: 'Tickers, e.g. ["SPY","QQQ"]. Defaults to SPY and QQQ.',
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { tickers } = GexParams.parse(args);
        const wanted = (tickers ?? ["SPY", "QQQ"]).map((t) =>
          symbolLiteral(t, "ow_uw_gex"),
        );
        const levels: unknown[] = [];
        const unavailable: Array<{ ticker: string; reason: string }> = [];
        for (const ticker of wanted) {
          let level: Record<string, unknown>;
          try {
            const raw = (await uwGet(
              env,
              "ow_uw_gex",
              `/api/stock/${encodeURIComponent(ticker)}/gex-levels`,
              { source: "vol" },
              ctx,
            )) as Record<string, unknown>;
            const body = (raw.data ?? raw) as Record<string, unknown>;
            level = {
              ticker,
              // Untouched, in UW's own words and UW's own types.
              date: body.date,
              asOf: body.time,
              source: body.source,
              callWall: body.call_wall,
              putWall: body.put_wall,
              gammaFlip: body.gamma_flip,
              gammaMagnet: body.gamma_magnet,
              nearbyFlips: body.nearby_flips,
            };
          } catch (error: unknown) {
            // One ticker's outage is not the tool's outage; a fabricated level
            // would be. The absent one is NAMED so the reader can see the gap.
            unavailable.push({
              ticker,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          try {
            const rawSpot = (await uwGet(
              env,
              "ow_uw_gex",
              `/api/stock/${encodeURIComponent(ticker)}/spot-exposures`,
              {},
              ctx,
            )) as Record<string, unknown>;
            const rows = (rawSpot.data ?? rawSpot) as Array<
              Record<string, unknown>
            >;
            if (!Array.isArray(rows) || rows.length === 0) {
              throw new Error(`${ticker}: spot-exposures returned no rows`);
            }
            // `limit` is ignored server-side (verified 2026-09-03) — fetch the
            // whole session and pick the row with the max `time` ourselves.
            let latest = rows[0];
            for (const row of rows) {
              if (
                typeof row.time === "string" &&
                typeof latest.time === "string" &&
                row.time > latest.time
              ) {
                latest = row;
              }
            }
            level.spotGamma = {
              time: latest.time,
              price: latest.price,
              gammaPer1PctOi: latest.gamma_per_one_percent_move_oi,
              charmPer1PctOi: latest.charm_per_one_percent_move_oi,
              vannaPer1PctOi: latest.vanna_per_one_percent_move_oi,
            };
          } catch (error: unknown) {
            unavailable.push({
              ticker,
              reason: `spotGamma: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          levels.push(level);
        }
        if (levels.length === 0) {
          throw new Error(
            `ow_uw_gex: no ticker returned levels — ${unavailable
              .map((entry) => `${entry.ticker}: ${entry.reason}`)
              .join("; ")}`,
          );
        }
        return JSON.stringify({ levels, unavailable });
      },
    },
    {
      // Verified live 2026-09-03 against GET /api/stock/{ticker}/info: the
      // response carries `next_earnings_date` ("2026-11-18" for NVDA) and
      // `announce_time` ("postmarket" for SNOW, "unknown" for NVDA). There is
      // no per-ticker "next earnings" endpoint in the UW public API — the
      // earnings tag only exposes historical and by-date calendars — so the
      // company-info row is the source of record for this question.
      //
      // Everything else on that row is excluded on purpose: logo, beta,
      // sector, marketcap, outstanding, avg30_volume, short_description,
      // uw_tags, has_options, has_dividend, has_investment_arm. None of them
      // decide whether an expiry spans earnings, and all of them would eat the
      // context budget this tool imposes on itself — nothing downstream trims
      // a tool result, so what is returned here is what a role reads.
      //
      // An ETF answers with `next_earnings_date: null` (verified: SMH, issue
      // type "ETF"). That is a real answer, not an outage, so it comes back as
      // a row with a null date and its issue type — `missing` is reserved for
      // "no data / request failed", the only kind of entry a caller must treat
      // as an unanswered question. An ETF has no earnings and should not be
      // asked about at all; this branch only keeps one that slips through from
      // reading as an outage.
      name: "ow_uw_earnings",
      description:
        "Next scheduled earnings date per single-name ticker, with `daysToEarnings` already subtracted for you (and premarket/postmarket report time when Unusual Whales knows it). A ticker with no scheduled earnings — an ETF, say — comes back as a row with `nextEarningsDate: null` and its `issueType`; `missing` means only that there was no data or the request failed.",
      paramsSchema: EarningsParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          description: 'Tickers to look up, e.g. ["NVDA","SNOW"].',
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { tickers } = EarningsParams.parse(args);
        const wanted = tickers.map((t) => symbolLiteral(t, "ow_uw_earnings"));
        const rows: unknown[] = [];
        const missing: Array<{ ticker: string; reason: string }> = [];
        // A ticker with no earnings is an answer; a ticker UW would not talk
        // about is not. Only the second kind may fail the whole tool.
        let answered = 0;
        for (const ticker of wanted) {
          try {
            const raw = (await uwGet(
              env,
              "ow_uw_earnings",
              `/api/stock/${encodeURIComponent(ticker)}/info`,
              {},
              ctx,
            )) as Record<string, unknown>;
            const body = (raw.data ?? raw) as Record<string, unknown>;
            const date = body.next_earnings_date;
            if (typeof date !== "string" || date === "") {
              answered += 1;
              rows.push({
                ticker,
                issueType: String(body.issue_type ?? "unknown"),
                nextEarningsDate: null,
              });
              continue;
            }
            // "unknown" is UW's own word for "we do not know the time of day";
            // passing it through as a report time would read as a fact.
            const time = body.announce_time;
            answered += 1;
            rows.push({
              ticker,
              nextEarningsDate: date,
              // Calendar days from today. Subtracted here because a model
              // subtracting dates gets it off by one, and an off-by-one on an
              // earnings date is a position held through a print.
              daysToEarnings: dteOf(date, new Date()),
              ...(typeof time === "string" && time !== "" && time !== "unknown"
                ? { reportTime: time }
                : {}),
            });
          } catch (error: unknown) {
            missing.push({
              ticker,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (answered === 0) {
          throw new Error(
            `ow_uw_earnings: no ticker answered — ${missing
              .map((entry) => `${entry.ticker}: ${entry.reason}`)
              .join("; ")}`,
          );
        }
        return JSON.stringify({
          asOf: new Date().toISOString(),
          rows,
          missing,
        });
      },
    },
    {
      // Reads what THIS tenant wrote on earlier runs (delivery-markdown,
      // <stateRoot>/reports). It is the only way a later phase can grade an
      // earlier one, and it needs no database: the report file IS the record.
      //
      // It returns the LEDGER, not the prose. The first version returned each
      // report's full markdown, and on 2026-09-02 that shipped a fabricated
      // settlement into a delivered email: the premarket report is 50,912
      // bytes, and at the time NOTHING in the harness trimmed a tool result
      // before it reached a context: `applyOutputPolicy` had no live caller.
      // So the 50 KB arrived whole, buried the proposals somewhere in the
      // middle of a context, and markout settled the nearest table it could
      // see. The harness now spills over 8 KB (provider.run installs the
      // post-execute seam), but that is a backstop that hands back a HEAD and
      // a path — it is not a substitute for a tool returning what was asked
      // for. Size discipline is THIS TOOL'S choice and nobody else's. The
      // proposals it needs are ~2 KB; the prose that buried them was never
      // what it wanted.
      //
      // The ids are minted by `candidatesFrom`, the same function the renderer
      // builds the email with, so an id settled here is an id that was mailed.
      name: "ow_reports",
      description:
        "This tenant's own past calls, newest first: each report's numbered proposals with the id, the 失效 levels and the target. `steps` adds named steps' prose on top (e.g. drift, markout, recap) when the narrative is what you need.",
      paramsSchema: ReportsParams,
      mutating: false,
      dshParams: {
        phase: {
          type: "string",
          description: "premarket | intraday | close | weekly | frank",
        },
        days: {
          type: "number",
          required: true,
          description: "How many days back, 1-10.",
        },
        steps: {
          type: "array",
          description:
            'Task ids whose prose to include, e.g. ["drift"] or ["markout","recap"]. Omit for the proposals alone.',
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { phase, days, steps } = ReportsParams.parse(args);
        const dir = join(cfg.stateRoot, "reports");
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          // No directory yet means no report yet — the first ever run of a
          // phase is a legitimate empty answer, not a broken tool.
          return JSON.stringify({ dir, reports: [] });
        }
        // `days` bounds how many distinct report DATES to walk back, counted
        // from the newest file. Counting dates keeps this tool out of the
        // timezone question altogether: filenames are stamped in the zone the
        // tenant declares, and a cutoff subtracted from this process's clock
        // disagrees with them by a whole day whenever the two are on different
        // dates — which, for a HK-scheduled run reading ET-dated files, is
        // most of the day.
        const rows: Array<{
          date: string;
          phase: string;
          candidates: CandidateView[];
          steps?: Record<string, string>;
        }> = [];
        const seen = new Set<string>();
        for (const name of names.sort().reverse()) {
          const match = REPORT_NAME.exec(name);
          if (match === null) continue;
          const [, date, found] = match;
          // 2026-09-05, as-of: a report written AFTER the replayed instant is
          // this tenant reading its own future. The day is in the filename
          // (REPORT_NAME group 1), stamped in the same zone `asOfDay` is
          // computed in, so the comparison is a string compare on two dates
          // from one zone — VERIFIED by construction, no clock involved.
          // `days` then counts back from the newest SURVIVING date, which is
          // the as-of day's report rather than today's.
          if (asOfDay !== undefined && date > asOfDay) continue;
          if (!seen.has(date)) {
            if (seen.size >= days) break;
            seen.add(date);
          }
          if (phase !== undefined && found !== phase) continue;
          const byStep = stepsOf(await readFile(join(dir, name), "utf8"));
          rows.push({
            date,
            phase: found,
            // A report with no `review` step (intraday, weekly, frank) has no
            // proposals of its own, and an empty list is the honest answer —
            // its content is prose and `steps` is how to ask for it.
            // `found` is the phase this stored file was written for, straight
            // off its own name — the same segment the run that wrote it minted
            // into its ids, so a settling role gets them back under exactly the
            // names they were promised under.
            candidates: candidatesFrom(byStep.get("review") ?? "", date, found)
              .candidates,
            ...(steps === undefined
              ? {}
              : {
                  steps: Object.fromEntries(
                    steps.flatMap((task) => {
                      const text = byStep.get(task);
                      return text === undefined ? [] : [[task, text] as const];
                    }),
                  ),
                }),
          });
        }

        // Bound the payload HERE, because nothing downstream will. There is
        // no output policy wired into any run (see the ow_reports comment
        // above), so a tool that returns 50 KB puts 50 KB into a context. A
        // model told "the 09-01 close prose was dropped" reads the ledger it
        // still has; a model handed an unbounded wall of prose fills the gap
        // from the nearest table on screen, which is exactly how the
        // 2026-09-02 close email came to settle six theses that never existed.
        // The candidates are never dropped — they are the ledger.
        const dropped: string[] = [];
        const payload = (): string =>
          JSON.stringify({
            dir,
            reports: rows,
            ...(dropped.length === 0
              ? {}
              : {
                  dropped,
                  note: "Prose dropped to fit the tool-output ceiling; the proposals above are complete. Do not infer the dropped narrative — read fewer days if you need it.",
                }),
          });
        const over = (): boolean =>
          Buffer.byteLength(payload(), "utf8") > REPORTS_PROSE_CEILING_BYTES;
        for (let i = rows.length - 1; i >= 0 && over(); i -= 1) {
          const row = rows[i]!;
          if (row.steps === undefined) continue;
          delete row.steps;
          dropped.push(`${row.date}-${row.phase}`);
        }
        return payload();
      },
    },
    {
      // The editor writes DELTAS, so it needs the document it is writing one
      // against. `ow_reports` cannot serve that: it deliberately returns the
      // settlement LEDGER and drops the prose (see its comment above), and the
      // prose is the whole question here.
      //
      // Reads the same `<stateRoot>/reports/<tenant>-<day>-<phase>.md` files
      // delivery-markdown writes. STRICTLY BEFORE `today` — a run that has
      // already written its own report for today would otherwise read itself
      // and conclude nothing changed, every single morning.
      //
      // Capped at ~2 KB, the same discipline as ow_reports and for the same
      // reason: yesterday's premarket report is 17 KB on a real run, and an
      // uncapped one would bury today's own data under a document the reader
      // has already read once.
      name: "ow_prior_brief",
      description:
        "The previous day's delivered brief for a phase: its masthead headline, its decision block and the opening of each narrative section, capped at ~2 KB. Read it to say what CHANGED since; it is never evidence about today's tape.",
      paramsSchema: PriorBriefParams,
      mutating: false,
      dshParams: {
        phase: {
          type: "string",
          description:
            "premarket (default) | intraday | close | weekly | frank",
        },
        today: {
          type: "string",
          description:
            "YYYY-MM-DD report day to look back FROM, exclusive. Omit for today in the tenant's report zone.",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { phase, today } = PriorBriefParams.parse(args);
        const wanted = phase ?? "premarket";
        // The report day in the zone the filenames are stamped in. Same
        // reasoning as ow_reports' date counting: a cutoff taken from this
        // process's clock disagrees with the filenames by a whole day for a
        // HK-scheduled run reading ET-dated files.
        // 2026-09-05, as-of: the replayed day replaces "today" as the
        // exclusive cutoff, so a replay of 09-02 reads the 09-01 brief and not
        // whatever the last run on disk happened to write. An explicit `today`
        // argument still wins — a caller naming a day means that day. VERIFIED
        // by construction (same zone as the filenames); nothing external.
        const cutoff =
          today ??
          asOfDay ??
          new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_ZONE }).format(
            new Date(),
          );
        const dir = join(cfg.stateRoot, "reports");
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return JSON.stringify({
            dir,
            prior: null,
            reason: "no reports directory yet",
          });
        }
        const found = names
          .map((name) => ({ name, match: REPORT_NAME.exec(name) }))
          .filter(
            (row) =>
              row.match !== null &&
              row.match[2] === wanted &&
              row.match[1]! < cutoff,
          )
          .sort((a, b) => b.match![1]!.localeCompare(a.match![1]!))[0];
        if (found === undefined) {
          return JSON.stringify({
            dir,
            prior: null,
            reason: `no ${wanted} report on disk dated before ${cutoff}`,
          });
        }
        const day = found.match![1]!;
        const byStep = stepsOf(await readFile(join(dir, found.name), "utf8"));
        // The prior run's own editor document when it had one; the regime step
        // is the fallback for a report written before the editor existed.
        // Either way this is prose the reader has already seen.
        const source = byStep.get("edit") ?? byStep.get("regime") ?? "";
        const parsed = extractJson(source);
        const text = (
          parsed === null ? source : JSON.stringify(pickBriefProse(parsed))
        ).slice(0, PRIOR_BRIEF_CEILING_CHARS);
        return JSON.stringify({
          dir,
          prior: { day, phase: wanted, file: found.name, text },
          note: "Yesterday's own words. Quote it only to say what changed; every number about TODAY comes from a live tool.",
        });
      },
    },
    {
      // Two opencli calls, verified locally 2026-09-03:
      //   opencli substack publication <url> --limit 1 -f json
      //     -> [{ "title", "url", "publish_time": "2026-08-31T12:37:14.509Z", … }]
      //   opencli web read --url <post url>
      //     -> writes web-articles/<title>/<title>.md under the CWD and prints
      //        a JSON envelope with status: success. 26.6 KB, no paywall cut,
      //        because the Chromium bridge carries the logged-in session — the
      //        mini's login is prepared by the operator, and its absence shows
      //        up here as a short or truncated markdown, never as an invention.
      // CWD is a scratch dir under the state root precisely BECAUSE `web read`
      // writes files where it stands: pointed at the repo it would litter the
      // checkout (doctrine 5 — blast radius is where it runs).
      name: "ow_frank",
      description:
        "Frank's latest Substack note: its url, publish time, and full markdown text.",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(): Promise<string> {
        const bin =
          (env.OW_OPENCLI_BIN ?? "").trim() === ""
            ? "opencli"
            : env.OW_OPENCLI_BIN!;
        const cwd = join(cfg.stateRoot, "scratch", "frank");
        await mkdir(cwd, { recursive: true });
        // Every `web read` gets its own directory, named for the url it was
        // given. `newestMarkdown` used to scan the ONE shared web-articles
        // tree, so the newest file by mtime could be last week's article that
        // this run never fetched, returned as today's note with today's url
        // stapled to it. A per-url directory makes the binding structural: the
        // only .md in there is the one this call wrote.
        const readPage = async (url: string): Promise<string | undefined> => {
          const into = join(
            cwd,
            "reads",
            url.replace(/[^A-Za-z0-9]+/gu, "-").slice(-80),
          );
          await mkdir(into, { recursive: true });
          const readArgv = ["web", "read", "--url", url];
          try {
            await execFileAsync(bin, readArgv, { cwd: into, timeout: 180_000 });
          } catch (error: unknown) {
            throw new Error(
              `ow_frank: ${bin} ${readArgv.join(" ")} failed — ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return newestMarkdown(join(into, "web-articles"));
        };
        // `--limit 1` returned the evergreen `/p/weekly-recap-and-outlook`
        // index (verified 2026-09-04: it and `/p/education` sit above every
        // dated post in the listing), and that page's first dated link was the
        // 2025-12-29 note — so the run compared this week against nine months
        // ago. Ask for a page of rows and take the first DATED slug; the index
        // page is read only when no row is dated.
        const listArgv = [
          "substack",
          "publication",
          FRANK_PUBLICATION,
          "--limit",
          "10",
          "-f",
          "json",
        ];
        let listed: string;
        try {
          ({ stdout: listed } = await execFileAsync(bin, listArgv, {
            cwd,
            timeout: 120_000,
          }));
        } catch (error: unknown) {
          throw new Error(
            `ow_frank: ${bin} ${listArgv.join(" ")} failed — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed: unknown = JSON.parse(
          listed.trim() === "" ? "[]" : listed,
        );
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const datedRow = rows.find(
          (row) =>
            typeof (row as { url?: unknown })?.url === "string" &&
            isDatedPostUrl((row as { url: string }).url),
        );
        const post = (datedRow ?? rows[0]) as
          | { url?: unknown; publish_time?: unknown; title?: unknown }
          | undefined;
        if (typeof post?.url !== "string") {
          throw new Error(
            `ow_frank: no post url in ${bin} substack publication output`,
          );
        }
        // An undated slug is an index page, not a note. Read it once for the
        // links it carries and follow the newest dated one; never hand it back
        // as the article.
        let url = post.url;
        if (!isDatedPostUrl(url)) {
          const index = await readPage(url);
          const dated =
            index === undefined ? undefined : firstDatedPostUrl(index);
          if (dated === undefined) {
            throw new Error(
              `ow_frank: ${url} is not a dated article slug and its page carries no ` +
                "dated article link — refusing to return an index page as Frank's note",
            );
          }
          url = dated;
        }
        // `web read` names the directory and the file after the article title,
        // and the exact slugging is opencli's business, not ours — so find the
        // one .md it just wrote rather than reconstructing its name.
        const markdown = await readPage(url);
        if (markdown === undefined) {
          throw new Error(
            `ow_frank: ${bin} web read wrote no markdown for ${url}`,
          );
        }
        // A real note runs tens of KB. A short body or a page of "Read full
        // story" teasers is a paywall cut or an index that slipped the slug
        // check — both look like an article and neither is one.
        const teasers = markdown.split("Read full story").length - 1;
        if (markdown.length < 500 || teasers >= 3) {
          throw new Error(
            `ow_frank: ${url} read as ${String(markdown.length)} chars with ` +
              `${String(teasers)} "Read full story" links — that is an index or a ` +
              "paywall cut, not the note",
          );
        }
        return JSON.stringify({
          url,
          publishedAt:
            typeof post.publish_time === "string"
              ? post.publish_time
              : undefined,
          title: typeof post.title === "string" ? post.title : undefined,
          markdown,
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
        "Rates, breakevens, credit spreads and financial-conditions series from argon's macro store, each with its observation date, plus today's live levels from TradingView for the 2y/5y/10y/30y curve, VIX and DXY. `series` is the daily path; `liveNow` is the current level; `fredDirect` is FRED's own observation, 1-2 days old, for the series TradingView cannot quote (HY OAS, breakevens, the 10y real yield, financial conditions, the dollar index) or the reason it was skipped; `staleSeries` says how far behind argon's daily mirror is. Quote `liveNow` for today, `fredDirect` for those series' latest level, `series` for the trend, and the lag whenever you cite a series listed in `staleSeries`.",
      paramsSchema: MacroParams,
      mutating: false,
      dshParams: {
        series: {
          type: "array",
          description:
            "FRED series ids; omit for the default rates/vol/credit set",
        },
        lookbackDays: {
          type: "number",
          description: "How far back to return observations (default 30)",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { series, lookbackDays } = MacroParams.parse(args);
        const wanted = series ?? [...DEFAULT_MACRO_SERIES];
        const list = wanted
          .map((id) => `'${symbolLiteral(id, "ow_macro_rates")}'`)
          .join(",");
        const days = lookbackDays ?? 30;
        const rows = await pgJson(
          env,
          "ow_macro_rates",
          // DISTINCT ON: argon's mirror holds ~30 copies of every (series, day)
          // row, and 2026-09-03 measured 4,391 rows for 145 distinct
          // observations -- 271 KB for what is 8 lines a day. One row per day.
          // 2026-09-05, as-of: the lookback window slides to end at the
          // replayed day instead of at today — same width, moved. VERIFIED by
          // construction against this table's own `obs_date` column. The end
          // of the window is `dateCut`, which is strictly LESS THAN the as-of
          // day: a daily observation for day D is not published until D has
          // closed.
          `SELECT DISTINCT ON (series_id, obs_date)
                  series_id, obs_date::text AS obs_date, value
             FROM uw_scan.macro_series_daily
            WHERE series_id IN (${list})
              AND obs_date >= ${asOfDay === undefined ? "current_date" : `DATE '${asOfDay}'`} - ${String(Math.trunc(days))}${dateCut("obs_date")}
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
        // Four keys, never merged: `series` is the daily path with its own
        // observation dates, `liveNow` is today's level off TradingView,
        // `fredDirect` is FRED's own 1–2 day-old point for the series
        // TradingView cannot quote, and `staleSeries` is the age of argon's
        // mirror. A single blended field would let a caller quote an 8-day-old
        // 10y as this morning's, which is exactly what this overlay exists to
        // remove.
        return JSON.stringify({
          series: { source: "argon.uw_scan.macro_series_daily", rows },
          // 2026-09-05, as-of: TradingView quotes ONE level, the current one,
          // so in a replay the live overlay is removed rather than filled with
          // today's curve sitting under a past date — the single most
          // dangerous number this tool could hand a replay. The daily series
          // above is then the only thing quotable, and the note says so.
          liveNow:
            asOf === undefined
              ? {
                  source: "tradingview",
                  ...(await tvLiveLevels(env, "ow_macro_rates")),
                }
              : {
                  unavailable: "as-of",
                  asOf: asOfIso,
                  reason:
                    "TradingView quotes the current level only; there is no live level for a past instant",
                  note: "Quote `series` and `fredDirect` with their own observation dates. There is NO live level in this run — do not describe any number here as today's or as the current print.",
                },
          fredDirect: await fredDirect(
            wanted.filter((id) => !TV_TWIN_IDS.has(id)),
            ctx,
            asOfDay === undefined ? undefined : priorDay(asOfDay),
          ),
          staleSeries: staleSeries(
            rows as Array<{ series_id?: unknown; obs_date?: unknown }>,
          ),
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
        symbol: {
          type: "string",
          required: true,
          description: "Ticker, e.g. SPY",
        },
        assetClass: {
          type: "string",
          description: "equity (default), index, rates, crypto, futures",
        },
        timeframe: { type: "string", description: "e.g. 1d (default), 1h, 5m" },
        lookbackDays: {
          type: "number",
          description: "Calendar days back from today (default 180)",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { symbol, assetClass, timeframe, lookbackDays } =
          BarsParams.parse(args);
        const tool = "ow_apex_bars";
        const base = need(env, "OW_APEX_API_BASE", tool);
        const ticker = symbolLiteral(symbol, tool);
        const klass = assetClass ?? "equity";
        const back = lookbackDays ?? 180;
        // 2026-09-05, as-of: the window ENDS at the replayed instant and the
        // lookback is measured back from it, so a replay sees the same depth
        // of history the live run would have seen on that day and not one bar
        // after it. VERIFIED: `/v1/{asset_class}/{symbol}/bars` takes an
        // optional `end: datetime` beside `start`
        // (apex `src/api/routes/chart.py:228-242`, read 2026-09-05), and both
        // are parsed the same way — so `end` needs the same offset-aware form
        // the existing comment demands of `start`. `toISOString()` gives it.
        const until = asOf?.getTime() ?? Date.now();
        const start = new Date(until - back * 86_400_000).toISOString();
        const url = new URL(
          `/v1/${encodeURIComponent(klass)}/${encodeURIComponent(ticker)}/bars`,
          base,
        );
        url.searchParams.set("timeframe", timeframe ?? "1d");
        url.searchParams.set("start", start);
        if (asOf !== undefined) url.searchParams.set("end", asOf.toISOString());
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
          throw new Error(
            `${tool}: ${url.pathname} returned ${response.status} ${response.statusText}`,
          );
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
      // Verified 2026-09-03 against the live response: GET
      // /api/market/economic-calendar takes NO parameters and answers
      // { data: [{ type, time (ISO Z), event, forecast, prev,
      // reported_period }] } across a multi-week window, forecast/prev null
      // for speeches. `reported_period` is excluded — the event name already
      // carries the month, and it is empty on every non-report row.
      name: "ow_uw_calendar",
      description:
        "The US economic calendar for the next 7 days from Unusual Whales: when each release or Fed speech lands (UTC), with the consensus forecast and the previous print where there is one. It says WHEN and WHO, never what the market expects.",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(
        _args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const raw = (await uwGet(
          env,
          "ow_uw_calendar",
          "/api/market/economic-calendar",
          {},
          ctx,
        )) as {
          data?: unknown;
        };
        const all = Array.isArray(raw.data) ? raw.data : [];
        // 2026-09-05, as-of: the 7-day window slides to start at the replayed
        // instant, so a replay is told what was still AHEAD on that day rather
        // than what is ahead now. VERIFIED by construction — the endpoint takes
        // no parameters (see the comment above) and returns a multi-week
        // window, so the filter is entirely client-side and needs nothing from
        // UW. Its limit is the same window: an instant older than what the
        // endpoint still carries filters down to nothing, and an empty `rows`
        // with the as-of stamped on it is the honest reading of that.
        const now = asOf?.getTime() ?? Date.now();
        const horizon = now + 7 * 86_400_000;
        const rows = (all as Array<Record<string, unknown>>)
          .filter((row) => {
            const at = Date.parse(String(row.time ?? ""));
            return Number.isFinite(at) && at >= now && at <= horizon;
          })
          .map((row) => ({
            time: row.time,
            type: row.type,
            event: row.event,
            forecast: row.forecast ?? null,
            prev: row.prev ?? null,
          }))
          .sort((a, b) => String(a.time).localeCompare(String(b.time)));
        return JSON.stringify({ asOf: new Date(now).toISOString(), rows });
      },
    },
    {
      // argon's scanner writes a fed-funds-futures path nightly. Row shape
      // verified live 2026-09-03:
      //   snapshot_date  2026-09-02
      //   meeting_date   2026-09-16
      //   payload        { label:"9/16", source:"Frenzy Capital Fed Watch",
      //                    stance:"HIKE", status:"ok", probability:60.0,
      //                    implied_rate:"3.78", target_range:"3.75-4.00%",
      //                    probabilities:{ "Hold":"0.4", "Cut 25 bp":"0.0",
      //                      "Cut 50 bp":"0.0", "Hike 25 bp":"0.6",
      //                      "Hike 50 bp":"0.0" } }
      //   source, first_seen_at, last_seen_at (the scanner's own bookkeeping)
      // This is FUTURES-IMPLIED via Frenzy Capital, not the CME FedWatch
      // number, and `source` says so on every payload so a citation cannot
      // silently become "CME says".
      name: "ow_argon_policy_path",
      description:
        "The market-implied Fed path from argon: for each upcoming FOMC meeting, the implied rate, the target range and the full probability distribution over hold/cut/hike, with the snapshot date they were computed on. Futures-implied via Frenzy Capital — not CME FedWatch — and any citation must say so and carry the snapshot date.",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(): Promise<string> {
        const rows = await pgJson(
          env,
          "ow_argon_policy_path",
          // 2026-09-05, as-of: the newest snapshot that existed ON the
          // replayed day, and the meetings that were still ahead of it. Both
          // halves have to move together — the latest snapshot with today's
          // meeting filter would answer about a path priced after the fact.
          // VERIFIED by construction against the two date columns this tool's
          // comment already documents (snapshot_date, meeting_date). The
          // snapshot cut is strictly BEFORE the as-of day — the scanner writes
          // the path for day D during D, so an 08:45 ET replay must read the
          // previous night's snapshot — while `meeting_date >=` stays
          // inclusive: a meeting held ON the as-of day is still ahead of it.
          `SELECT DISTINCT ON (meeting_date)
                  snapshot_date::text AS snapshot_date,
                  meeting_date::text AS meeting_date,
                  payload
             FROM uw_scan.rates_policy_path
            WHERE snapshot_date = (SELECT max(snapshot_date) FROM uw_scan.rates_policy_path
                                    WHERE true${dateCut("snapshot_date")})
              AND meeting_date >= ${asOfDay === undefined ? "current_date" : `DATE '${asOfDay}'`}
            ORDER BY meeting_date, last_seen_at DESC`,
        );
        if (rows.length === 0) {
          throw new Error(
            "ow_argon_policy_path: argon holds no fed-funds path for a meeting on or after today; " +
              "reporting the gap rather than a flat path that reads as a market pricing nothing",
          );
        }
        const first = rows[0] as { snapshot_date?: unknown };
        return JSON.stringify({
          source: "frenzy_capital fed-funds futures via argon",
          snapshotDate: first.snapshot_date,
          meetings: rows,
        });
      },
    },
    {
      // argon's HTTP API, not its Postgres — these four responses are
      // computed views (dealer regime, options-implied levels, the
      // technical-support/resistance model, live technicals), not table rows
      // a SELECT can reproduce.
      //
      // Verified live 2026-09-03 on the mini (`ssh macmini curl … :8400`;
      // this laptop has no local argon):
      //   GET /api/regime/dealer?ticker=SPY ->
      //     {"status":"ok","ticker":"SPY","spot":768.86,"net_gex":280354.25,
      //      "closest_levels":[{"label":"Call Wall","role":"resistance",
      //      "strike":770.0,"distance_pct":0.00148,"gamma":75477.69},
      //      {"label":"Gamma Flip","role":"flip","strike":766.0,...}],
      //      "odte_share_pct":1.0}
      //   GET /api/regime/gex?ticker=SPY ->
      //     {"data_date":"2026-09-03","spot":768.90,
      //      "levels":{"gex_flip":{"strike":770.0,...},
      //      "call_wall":{"strike":770.0,...},"put_wall":{"strike":765.0,...},
      //      "max_magnet":{"strike":770.0,...}},
      //      "expected_range":{"low":762.99,"high":774.81,"iv_1d":0.7685},
      //      "mq":null}
      //   GET /api/stock/SPY/magnets ->
      //     {"as_of":"2026-09-02","levels":{"resistance":759.57,
      //      "support":725.43,"sma20":768.976,
      //      "pivot_a":{"price":759.57},"pivot_b":{"price":725.43}}}
      //   GET /api/stock/SPY/technicals/live ->
      //     {"spot":768.72,"spot_source":"xenon_ws",
      //      "captured_at":"2026-09-03T22:22:15.989000+08:00"}
      // `mq` (ManaQuant's own hvl/expected-range snapshot) was null on this
      // scan — GexResponse.mq is nullable and only some tickers carry it —
      // so `gamma.hvl` is simply absent rather than guessed at.
      //
      // Every sub-endpoint is fetched independently and one 404/timeout does
      // not fail the others: a ticker with a live dealer regime but a down
      // magnets service still gets a partial row, named as partial, rather
      // than the whole ticker disappearing.
      name: "ow_argon_levels",
      description:
        "Real price anchors from argon per ticker: spot, technical support/resistance/pivots, dealer-gamma levels (flip, call/put wall, max magnet, hvl), the nearest options-structure levels with their role (support/resistance/accelerator/flip), and today's expected range. A structure's strikes must sit ON one of these levels or inside expected_range — never on a level this tool did not return.",
      paramsSchema: ArgonLevelsParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          required: true,
          description:
            'Tickers to fetch levels for, e.g. ["SPY","QQQ"]. Up to 12 per call.',
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { tickers } = ArgonLevelsParams.parse(args);
        const tool = "ow_argon_levels";
        const base = need(env, "OW_ARGON_API_BASE", tool);
        const results = await Promise.all(
          tickers.map((raw) =>
            argonLevelsForTicker(tool, base, symbolLiteral(raw, tool), ctx),
          ),
        );
        if (
          results.every(
            (row) =>
              row.spot === undefined &&
              row.technical === undefined &&
              row.gamma === undefined &&
              row.closest_levels === undefined,
          )
        ) {
          throw new Error(
            `${tool}: argon returned nothing usable for any of ${tickers.join(", ")} — ` +
              `${results.map((row) => `${row.ticker}: ${(row.unavailable ?? []).join("; ")}`).join(" | ")}`,
          );
        }
        return JSON.stringify({ source: "argon", levels: results });
      },
    },
    {
      // Verified 2026-09-03 against the live NVDA response: GET
      // /api/stock/{ticker}/volatility/term-structure answers
      // { data: [{ date, ticker, expiry, dte, volatility, implied_move,
      // implied_move_perc }] }, every number a STRING.
      //
      // The dte 0 row is dropped. On 2026-09-02 NVDA's expiring-today row read
      // volatility 5.31 — 531% — which is the arithmetic of an expiring
      // contract, not a vol level anyone can trade an expiry choice off. It
      // would be the single biggest number in the payload and read as a
      // regime signal.
      name: "ow_uw_iv_term",
      description:
        "Implied-volatility term structure per ticker from Unusual Whales: one row per expiry with its DTE, the implied volatility and the implied move. Same-day (0 DTE) expiries are excluded. At most 3 tickers.",
      paramsSchema: IvTermParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          description: 'At most 3 tickers, e.g. ["NVDA"].',
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const parsed = IvTermParams.safeParse(args);
        if (!parsed.success) {
          throw new Error(
            "ow_uw_iv_term: `tickers` must be 1 to 3 symbols — one request per ticker is a " +
              "separate round trip, so ask for the expiries you will actually choose between",
          );
        }
        const rows: unknown[] = [];
        for (const raw of parsed.data.tickers) {
          const ticker = symbolLiteral(raw, "ow_uw_iv_term");
          const body = (await uwGet(
            env,
            "ow_uw_iv_term",
            `/api/stock/${encodeURIComponent(ticker)}/volatility/term-structure`,
            {},
            ctx,
          )) as { data?: unknown };
          for (const row of (Array.isArray(body.data)
            ? body.data
            : []) as Array<Record<string, unknown>>) {
            const dte = Number(row.dte);
            if (!Number.isFinite(dte) || dte <= 0) continue;
            rows.push({
              ticker,
              date: row.date,
              expiry: row.expiry,
              dte,
              volatility: Number(row.volatility),
              implied_move_perc: Number(row.implied_move_perc),
            });
          }
        }
        return JSON.stringify({ rows });
      },
    },
    {
      // Verified 2026-09-03 against the live response: GET
      // /api/news/headlines answers { data: [{ created_at, headline, tickers,
      // sentiment, is_major, source, tags, meta }] }. There is NO url field —
      // 25 rows carried none — so this tool returns no link; inventing one
      // would be a citation a reader could not check.
      //
      // `meta` (per-ticker quote blobs) and `tags` are excluded: they are the
      // bulk of the payload and nothing here reads them. 25 rows of the kept
      // fields is ~7.4 KB, under core's summariser cut, which is why 25 is the
      // hard maximum rather than a page size.
      name: "ow_uw_headlines",
      description:
        "Market headlines from Unusual Whales, newest first, with their timestamp, tickers and sentiment. Quotable ONLY as a citation (timestamp plus the headline verbatim); it is not evidence of what the market expects. No URL: the feed carries none.",
      paramsSchema: HeadlinesParams,
      mutating: false,
      dshParams: {
        searchTerm: {
          type: "string",
          description: 'Free-text filter, e.g. "Powell"',
        },
        ticker: {
          type: "string",
          description: "Restrict to headlines tagged with this ticker",
        },
        limit: {
          type: "number",
          description: "Rows to return, default 15, max 25",
        },
        majorOnly: {
          type: "boolean",
          description: "Major headlines only (default true)",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { searchTerm, ticker, limit, majorOnly } =
          HeadlinesParams.parse(args);
        const body = (await uwGet(
          env,
          "ow_uw_headlines",
          "/api/news/headlines",
          {
            limit: String(Math.min(limit ?? 15, 25)),
            major_only: String(majorOnly ?? true),
            ...(searchTerm === undefined ? {} : { search_term: searchTerm }),
            ...(ticker === undefined
              ? {}
              : { ticker: symbolLiteral(ticker, "ow_uw_headlines") }),
          },
          ctx,
        )) as { data?: unknown };
        const rows = (
          (Array.isArray(body.data) ? body.data : []) as Array<
            Record<string, unknown>
          >
        ).map((row) => ({
          created_at: row.created_at,
          headline: row.headline,
          tickers: row.tickers ?? [],
          sentiment: row.sentiment ?? null,
        }));
        return JSON.stringify({ rows });
      },
    },
    {
      // opencli's twitter adapter, same Browser Bridge dependency as the
      // TradingView tools and gated the same way on OW_TV_ENABLED. Field
      // names verified 2026-09-03 against `opencli twitter tweets
      // NickTimiraos -f json`: a bare ARRAY of { id, author, name, text,
      // likes, retweets, replies, views, is_retweet, created_at, url,
      // has_media, media_urls, quoted_tweet }.
      //
      // Engagement counts are excluded on purpose. A post is usable here as a
      // citation of what a named person said at a named time — likes and views
      // are the raw material of "the market thinks", which this tenant may not
      // conclude from a timeline.
      name: "ow_x_posts",
      description:
        "Recent posts from one of a fixed list of Fed reporters and economists on X. Quotable ONLY as a citation: author, timestamp, link and the text verbatim. It is never evidence of what the market expects, and free-form handles are refused.",
      paramsSchema: XPostsParams,
      mutating: false,
      dshParams: {
        handle: {
          type: "string",
          required: true,
          description: `One of: ${X_HANDLES.join(", ")}`,
        },
        limit: {
          type: "number",
          description: "Posts to return, default 10, max 20",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const parsed = XPostsParams.safeParse(args);
        if (!parsed.success) {
          throw new Error(
            `ow_x_posts: handle must be one of ${X_HANDLES.join(", ")}. A handle that is not on ` +
              "this list is refused rather than fetched: a near-miss answers confidently with " +
              "the wrong person's posts.",
          );
        }
        if (env.OW_TV_ENABLED !== "1") {
          throw new Error(
            'ow_x_posts: OW_TV_ENABLED is not "1"; this machine has no browser bridge',
          );
        }
        const bin = env.OPENCLI_BIN;
        if (bin === undefined || bin.trim() === "") {
          throw new Error(
            "ow_x_posts: OPENCLI_BIN is unset; there is no route to X",
          );
        }
        const { handle, limit } = parsed.data;
        const argv = [
          "twitter",
          "tweets",
          handle,
          "--limit",
          String(limit ?? 10),
          "-f",
          "json",
        ];
        let stdout: string;
        try {
          ({ stdout } = await execFileAsync(bin, argv, { timeout: 60_000 }));
        } catch (error: unknown) {
          throw new Error(
            `ow_x_posts: ${bin} twitter tweets ${handle} failed — ` +
              (error instanceof Error
                ? error.message.split("\n")[0]
                : String(error)),
          );
        }
        const parsedOut: unknown = JSON.parse(stdout);
        const all = (Array.isArray(parsedOut) ? parsedOut : []).map(
          (row: Record<string, unknown>) => ({
            author: row.author,
            created_at: row.created_at,
            url: row.url,
            text: row.text,
          }),
        );
        // 2026-09-05, as-of: X has no dated archive on this route — the
        // timeline is fetched live and filtered here to what had been POSTED
        // by the replayed instant. That works only while the wanted posts are
        // still inside the newest `limit`; a replay far enough back keeps
        // nothing, and an empty list would read as "this reporter said
        // nothing that week", which is a false and quotable fact. So an empty
        // filter result is an explicit as-of unavailability instead.
        // VERIFIED: `created_at` is on every row (the shape this tool already
        // returns). ASSUMED: that it is an ISO instant parseable by Date —
        // a row whose timestamp does not parse is DROPPED rather than kept,
        // because a row that cannot be dated cannot be shown to predate the
        // instant.
        if (asOf === undefined) return JSON.stringify({ rows: all });
        const cut = asOf.getTime();
        const rows = all.filter((row) => {
          const at = Date.parse(String(row.created_at ?? ""));
          return Number.isFinite(at) && at <= cut;
        });
        if (rows.length === 0) {
          const reason = "timeline window exhausted";
          cfg.pit?.markUnavailable("ow_x_posts", reason);
          return JSON.stringify({
            unavailable: "as-of",
            asOf: asOfIso,
            reason,
            detail: `the newest ${String(all.length)} posts on this timeline are all later than the replayed instant`,
          });
        }
        return JSON.stringify({ asOf: asOfIso, rows });
      },
    },
    {
      // The same opencli TradingView quote route tvLiveLevels uses, over a
      // fixed commodity list (see TV_COMMODITIES for what answered live on
      // 2026-09-03 and what did not). Like tvLiveLevels it drops an instrument
      // that answers without a numeric close rather than reporting a 0.00
      // price, which would read as a real and catastrophic level.
      name: "ow_tv_commodities",
      description:
        "Live commodity levels from TradingView: gold, silver, WTI and Brent crude, copper and natural gas, each with its percent change on the day. Cite when a commodity is actually part of the read; there is no obligation to mention it every run.",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(): Promise<string> {
        if (env.OW_TV_ENABLED !== "1") {
          throw new Error(
            'ow_tv_commodities: OW_TV_ENABLED is not "1"; this machine has no browser bridge',
          );
        }
        const bin = env.OPENCLI_BIN;
        if (bin === undefined || bin.trim() === "") {
          throw new Error(
            "ow_tv_commodities: OPENCLI_BIN is unset; there is no route to quotes",
          );
        }
        const rows: unknown[] = [];
        for (const entry of TV_COMMODITIES) {
          let stdout: string;
          try {
            ({ stdout } = await execFileAsync(
              bin,
              [
                "tradingview",
                "quote",
                "--ticker",
                entry.ticker,
                "--exchange",
                entry.exchange,
                "-f",
                "json",
              ],
              { timeout: 30_000 },
            ));
          } catch {
            continue;
          }
          const out: unknown = JSON.parse(stdout);
          const row = (Array.isArray(out) ? out[0] : out) as
            { close?: unknown; change?: unknown } | undefined;
          if (typeof row?.close !== "number") continue;
          rows.push({
            label: entry.label,
            symbol: `${entry.exchange}:${entry.ticker}`,
            close: row.close,
            ...(typeof row.change === "number"
              ? { change_pct: row.change }
              : {}),
          });
        }
        if (rows.length === 0) {
          throw new Error(
            "ow_tv_commodities: no commodity answered with a numeric close; is the TradingView app running?",
          );
        }
        return JSON.stringify({ asOf: new Date().toISOString(), rows });
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
        ticker: {
          type: "string",
          required: true,
          description: "Underlying symbol",
        },
        strategy: {
          type: "string",
          required: true,
          description: "e.g. put-credit-spread",
        },
        legs: {
          type: "array",
          required: true,
          description:
            "right/expiry/strike/action/ratio, plus the NBBO mid of each leg",
        },
        rationale: {
          type: "string",
          required: true,
          description: "Why this structure",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const proposal = ProposalSchema.parse(args);
        return JSON.stringify(evaluateProposal(proposal, tenantThresholds()));
      },
    },
    {
      // The renderer's own `priceStructure`, exposed unchanged. The email has
      // always printed the derived numbers rather than the model's; this lets
      // the model see the SAME numbers before it commits, instead of writing a
      // take-profit level off a max gain it computed itself. On 09-02 five of
      // five proposals disagreed with their own arithmetic, and one printed a
      // debit spread's max loss as the width instead of the debit.
      name: "ow_price_structure",
      description:
        "Expiry payoff for a defined-risk structure, computed from the legs and their NBBO mids: net (positive is a credit, per share), maxGain and maxLoss per spread in dollars (null means unbounded), breakevens, width, the payoff at ±5/10/20% of spot when a spot is given, and `exit` — takeProfit (half of maxGain) and stop (twice the credit received, or the debit paid), BOTH already in the same per-spread dollars as maxGain and maxLoss. Pure arithmetic — call it and COPY the numbers; never compute a max loss, a breakeven, a take-profit or a stop yourself.",
      paramsSchema: PriceStructureParams,
      mutating: false,
      dshParams: {
        legs: {
          type: "array",
          required: true,
          description:
            "right (call|put), action (buy|sell), strike, expiry, optional ratio, and the NBBO mid of each leg",
        },
        spot: {
          type: "number",
          required: true,
          description: "The spot ow_spot returned for this ticker",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { legs, spot } = PriceStructureParams.parse(args);
        const pricing = priceStructure(legs, spot);
        // The exit levels, multiplied out HERE. The persona used to say "take
        // profit at 50% of maxGain, stop at 2x the credit", which is a x0.5 and
        // a x2 done by a model — the same class of arithmetic that was wrong in
        // 8 of 11 numbers audited on 09-02/09-03. Units are the per-spread
        // dollars maxGain and maxLoss are already in, so no conversion is left
        // for the reader either: `net` is per share, so a credit stop is x100.
        const exit =
          pricing.kind !== "priced"
            ? undefined
            : {
                takeProfit:
                  pricing.maxGain === null
                    ? null
                    : Number((pricing.maxGain * 0.5).toFixed(2)),
                stop: Number(
                  (pricing.net > 0
                    ? pricing.net * 2 * 100
                    : Math.abs(pricing.net) * 100
                  ).toFixed(2),
                ),
              };
        return JSON.stringify({
          ...pricing,
          width: width(legs),
          ...(exit === undefined ? {} : { exit }),
        });
      },
    },
    {
      // For a strike proposed without a chain call. Same spot resolution as
      // ow_spot, so the number here and the number the gate checks against are
      // one number. A 180 put under a 183.60 spot was called in the money on
      // 09-03; that is a comparison, and a comparison belongs in code.
      name: "ow_strike_check",
      description:
        "Where each proposed strike sits against the live spot: signed distPct (positive above spot) and moneyness (ITM/OTM/ATM) per strike, given its right. Copy these; never estimate a distance or decide moneyness in your head.",
      paramsSchema: StrikeCheckParams,
      mutating: false,
      dshParams: {
        ticker: {
          type: "string",
          required: true,
          description: "Underlying symbol",
        },
        strikes: {
          type: "array",
          required: true,
          description: "Each entry is { strike, right } with right call or put",
        },
      },
      async run(
        args: Record<string, unknown>,
        ctx?: ToolRunContext,
      ): Promise<string> {
        const { ticker, strikes } = StrikeCheckParams.parse(args);
        const tool = "ow_strike_check";
        const spot = await spotOf(env, tool, ticker, ctx);
        if (spot === undefined) {
          throw new Error(
            `${tool}: no spot for ${ticker} from TradingView or Unusual Whales. ` +
              "Refusing to judge a strike against a price nobody has.",
          );
        }
        const rows = strikes.map((entry) => ({
          strike: entry.strike,
          right: entry.right,
          spot: spot.close,
          distPct: Number(
            (((entry.strike - spot.close) / spot.close) * 100).toFixed(2),
          ),
          moneyness:
            entry.strike === spot.close
              ? "ATM"
              : entry.right === "call"
                ? entry.strike < spot.close
                  ? "ITM"
                  : "OTM"
                : entry.strike > spot.close
                  ? "ITM"
                  : "OTM",
        }));
        return JSON.stringify({
          ticker,
          spot: spot.close,
          spotSource: spot.source,
          rows,
          fetchedAt: new Date().toISOString(),
        });
      },
    },
  ];
  if (asOf === undefined) return built;
  // One place, not thirteen edits: a live-only tool in a replay is replaced by
  // its refusal wholesale, so there is no path through its body that could
  // still reach the network. Thirteen inline guards would each have to be
  // right; this has to be right once.
  return built.map((tool) => {
    const source = AS_OF_BLIND.get(tool.name);
    if (source === undefined) return tool;
    const reason = `${source} has no history`;
    cfg.pit?.markUnavailable(tool.name, reason);
    const payload = JSON.stringify({
      unavailable: "as-of",
      asOf: asOfIso,
      reason,
    });
    return {
      ...tool,
      description: `${tool.description} ${AS_OF_BLIND_SENTENCE}`,
      run: async (): Promise<string> => payload,
    };
  });
}
