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
  ["ow_argon_watchlist", { mutating: false, requiresEnv: "OW_ARGON_API_BASE" }],
  ["ow_ib_positions", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_ib_chain", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_ib_quote", { mutating: false, requiresEnv: "OW_IB_API_BASE" }],
  ["ow_uw_ticker_metrics", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_uw_market_state", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
  ["ow_macro_rates", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
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
 * argon's real response shape, not an invented one. `[VERIFIED — spec §3,
 * from /Users/chenxi/projects/argon/src/uw_scan/api/routers/watchlist.py:107-186]`.
 * `scanned_at` is null for a watchlist ticker with no card row yet; consumers
 * must tolerate that rather than filtering it away.
 */
export interface WatchlistResponse {
  scanned_at_min: string | null;
  scanned_at_max: string | null;
  scheduler_lag_seconds: number | null;
  queue: { total: number; queued: number; running: number; oldest_requested_at: string | null };
  hot_count: number;
  hot_max: number;
  tickers: unknown[];
}

const TvParams = z.object({
  flagColors: z.array(z.enum(["red", "orange", "yellow", "green", "blue", "purple"])).optional(),
});
const ArgonParams = z.object({
  sector: z.string().optional(),
  chain: z.string().optional(),
  setup: z.string().optional(),
  freshWithinMinutes: z.number().int().positive().optional(),
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
const MATURITIES = ["3month", "2year", "5year", "7year", "10year", "30year"] as const;
const MacroParams = z.object({ maturities: z.array(z.enum(MATURITIES)).min(1).optional() });

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
      name: "ow_argon_watchlist",
      description:
        "argon's scanned watchlist (GET /api/watchlist): cards with spot, iv_rank, gamma, skew and positioning per ticker.",
      paramsSchema: ArgonParams,
      mutating: false,
      dshParams: {
        sector: { type: "string", description: "Filter by sector" },
        chain: { type: "string", description: "Filter by chain" },
        setup: { type: "string", description: "Filter by setup type" },
        freshWithinMinutes: {
          type: "number",
          description: "Only cards scanned within this many minutes",
        },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const params = ArgonParams.parse(args);
        const base = need(env, "OW_ARGON_API_BASE", "ow_argon_watchlist");
        const url = new URL("/api/watchlist", base);
        if (params.sector !== undefined) url.searchParams.set("sector", params.sector);
        if (params.chain !== undefined) url.searchParams.set("chain", params.chain);
        if (params.setup !== undefined) url.searchParams.set("setup", params.setup);
        if (params.freshWithinMinutes !== undefined) {
          url.searchParams.set("fresh_within_minutes", String(params.freshWithinMinutes));
        }
        const doFetch = ctx?.fetchImpl ?? fetch;
        let response: Response;
        try {
          response = await doFetch(url);
        } catch (error: unknown) {
          throw new Error(
            `ow_argon_watchlist: argon unreachable at ${url.host} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!response.ok) {
          throw new Error(
            `ow_argon_watchlist: ${url.pathname} returned ${response.status} ${response.statusText}`,
          );
        }
        // Passed through verbatim: argon owns this shape and re-typing it here
        // would be a second place for it to drift.
        const body = (await response.json()) as WatchlistResponse;
        return JSON.stringify(body);
      },
    },
    {
      name: "ow_ib_positions",
      description: "Open positions, net liquidation and buying power from IB Gateway (read-only).",
      paramsSchema: NoParams,
      mutating: false,
      dshParams: {},
      async run(_args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        // Passed through verbatim. xenon owns this shape; re-typing it here
        // would be a second place for it to drift, and `account_summary`
        // carries exactly the net-liq and buying-power the preflight gate
        // reads.
        return JSON.stringify(await ibGet(env, "ow_ib_positions", "/portfolio", {}, ctx));
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
      // Spec §3 names UW routes `central_bank_rates` and `yield_curve`; neither
      // appears in the live OpenAPI docs (searched 2026-09-02). What does exist
      // is GET /api/economy/{indicator} with `fed-funds` and `treasury-yield`
      // (+ `maturity`), Advanced+ tier — so the curve is assembled from those
      // rather than from a path that could not be verified to exist.
      name: "ow_macro_rates",
      description:
        "Fed funds series and the treasury yield curve from Unusual Whales' economy endpoint.",
      paramsSchema: MacroParams,
      mutating: false,
      dshParams: {
        maturities: {
          type: "array",
          description: "Treasury maturities: 3month, 2year, 5year, 7year, 10year, 30year",
        },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { maturities } = MacroParams.parse(args);
        const tool = "ow_macro_rates";
        const yieldCurve: Record<string, unknown> = {};
        for (const maturity of maturities ?? MATURITIES) {
          yieldCurve[maturity] = await uwGet(
            env,
            tool,
            "/api/economy/treasury-yield",
            { maturity },
            ctx,
          );
        }
        return JSON.stringify({
          centralBankRates: await uwGet(env, tool, "/api/economy/fed-funds", {}, ctx),
          yieldCurve,
          asOf: new Date().toISOString(),
        });
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
