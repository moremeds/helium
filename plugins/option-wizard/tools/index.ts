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
  ["ow_argon_metrics", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }],
  ["ow_apex_bars", { mutating: false, requiresEnv: "OW_APEX_API_BASE" }],
  ["ow_ib_positions", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_ib_chain", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_ib_quote", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
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

/** `20260918` -> whole days from today, the unit every DTE threshold uses. */
function dteOf(expiry: string, now: Date): number {
  const parsed = Date.UTC(
    Number(expiry.slice(0, 4)),
    Number(expiry.slice(4, 6)) - 1,
    Number(expiry.slice(6, 8)),
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


const TvParams = z.object({
  flagColors: z.array(z.enum(["red", "orange", "yellow", "green", "blue", "purple"])).optional(),
});
const NoParams = z.object({});
const ChainParams = z.object({
  ticker: z.string().min(1),
  minDte: z.number().int().nonnegative(),
  maxDte: z.number().int().positive(),
});
const QuoteParams = z.object({
  ticker: z.string().min(1),
  conIds: z.array(z.number().int().positive()).min(1).max(20),
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
        if (env.OW_TV_ENABLED !== "1") {
          throw new Error("OW_TV_ENABLED is not \"1\"; ow_tv_watchlist is disabled");
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
          source: "tradingview",
          tickers: [...symbols].sort(),
          asOf: new Date().toISOString(),
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
      name: "ow_ib_chain",
      description: "Listed expiries and strikes for a ticker within a DTE band, from IB Gateway.",
      paramsSchema: ChainParams,
      mutating: false,
      dshParams: {
        ticker: { type: "string", required: true, description: "Underlying symbol" },
        minDte: { type: "number", required: true, description: "Minimum days to expiry" },
        maxDte: { type: "number", required: true, description: "Maximum days to expiry" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { ticker, minDte, maxDte } = ChainParams.parse(args);
        const tool = "ow_ib_chain";
        const listed = (await ibGet(env, tool, "/options/expirations", { symbol: ticker }, ctx)) as {
          expirations?: unknown;
        };
        const all = Array.isArray(listed.expirations) ? listed.expirations : [];
        const now = new Date();
        const inBand = all
          .filter((value): value is string => typeof value === "string")
          .filter((expiry) => {
            const dte = dteOf(expiry, now);
            return dte >= minDte && dte <= maxDte;
          });
        const expiries = [];
        for (const expiry of inBand) {
          const chain = (await ibGet(
            env,
            tool,
            "/options/chain",
            { symbol: ticker, expiry },
            ctx,
          )) as { strikes?: unknown; exchange?: unknown };
          expiries.push({
            expiry,
            dte: dteOf(expiry, now),
            exchange: chain.exchange,
            strikes: chain.strikes,
          });
        }
        // An empty band is a FACT, not a failure: a ticker can genuinely list
        // no expiry between minDte and maxDte. The count of what was listed is
        // reported alongside so the caller can tell that apart from a bad symbol.
        return JSON.stringify({ ticker, minDte, maxDte, listedExpiries: all.length, expiries });
      },
    },
    {
      name: "ow_ib_quote",
      description: "Bid, ask, mid, open interest and greeks for contract ids, from IB Gateway.",
      paramsSchema: QuoteParams,
      mutating: false,
      dshParams: {
        ticker: { type: "string", required: true, description: "Underlying symbol" },
        conIds: { type: "array", required: true, description: "IB contract ids" },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { ticker, conIds } = QuoteParams.parse(args);
        const quotes = [];
        for (const conId of conIds) {
          quotes.push(
            await ibGet(
              env,
              "ow_ib_quote",
              "/orders/quote",
              { ticker, con_id: String(conId) },
              ctx,
            ),
          );
        }
        return JSON.stringify({ ticker, quotes });
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
