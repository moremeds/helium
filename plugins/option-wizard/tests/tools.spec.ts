/**
 * The property that matters: with nothing configured, every tool THROWS and
 * names what is missing. A tool that returned a plausible empty shape here
 * would put an invented number in a trading email.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VOCABULARY,
  buildTools,
  dteOf,
  parseOcc,
  thinAcross,
  symbolLiteral,
  staleSeries,
  tvLiveLevels,
  parseFredCsv,
  fredDirect,
} from "../tools/index.js";

const EMPTY_ENV: Record<string, string | undefined> = {};

// A real opencli cannot run in CI, and mocking execFile would test the mock.
// A tiny script on disk that prints a CAPTURED response exercises the actual
// subprocess + parse path against the real wire shape.
const tmp = mkdtempSync(join(tmpdir(), "ow-tv-"));

function tool(name: string, env = EMPTY_ENV) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("vocabulary", () => {
  it("declares every tool read-only", () => {
    for (const [, entry] of VOCABULARY) expect(entry.mutating).toBe(false);
  });

  it("matches the built catalog exactly", () => {
    const built = buildTools({ stateRoot: "/nonexistent", env: EMPTY_ENV }).map((t) => t.name);
    expect(built.sort()).toEqual([...VOCABULARY.keys()].sort());
  });

  it("declares no optional dsh parameter, which the runtime refuses", () => {
    // dsh rejects the whole role with "unsupported JSON schema:
    // parameters.X.required must be true when present" — and it rejects it at
    // ROUTING time, so a run gets as far as burning a regime step before dying.
    // One live run was lost to exactly that. A knob a role should not be
    // turning belongs in the zod schema only.
    for (const t of buildTools({ stateRoot: "/nonexistent", env: EMPTY_ENV })) {
      for (const [name, spec] of Object.entries(t.dshParams ?? {})) {
        // Omitting the key is fine — the runtime's complaint is specifically
        // about `required: false`, and ow_tv_watchlist.flagColors has shipped
        // for weeks with no `required` at all.
        expect(spec.required, `${t.name}.${name}`).not.toBe(false);
      }
    }
  });

  it("registers no tool with order semantics", () => {
    for (const name of VOCABULARY.keys()) {
      expect(name).not.toMatch(/order|place|submit|cancel|amend/u);
    }
  });
});

describe("absent environment", () => {
  it.each([
    ["ow_ib_positions", {}, "OW_IB_API_BASE is unset"],
    ["ow_argon_metrics", { tickers: ["SPY"] }, "OW_ARGON_PG_URL is unset"],
    ["ow_apex_bars", { symbol: "SPY" }, "OW_APEX_API_BASE is unset"],
    ["ow_argon_levels", { tickers: ["SPY"] }, "OW_ARGON_API_BASE is unset"],
    ["ow_uw_ticker_metrics", { tickers: ["AAPL"] }, "OW_UW_API_KEY is unset"],
    ["ow_uw_market_state", { sector: "Technology", etf: "XLK" }, "OW_UW_API_KEY is unset"],
    ["ow_macro_rates", { series: ["DGS10"] }, "OW_ARGON_PG_URL is unset"],
  ])("%s throws naming the missing key", async (name, args, message) => {
    await expect(tool(name).run(args as Record<string, unknown>)).rejects.toThrow(message);
  });

  it("ow_spot refuses with a price it cannot get, and says which source failed", async () => {
    // A run that completed cleanly proposed QQQ 420/410 with QQQ at 707.64,
    // because no role had a price. An ow_spot that returned nothing quietly
    // would put that back. The REASON is part of the refusal: on the mini the
    // answer is "no UW credential", not "SPY has no price".
    await expect(tool("ow_spot").run({ tickers: ["SPY"] })).rejects.toThrow(
      "OW_UW_API_KEY is unset",
    );
    // TradingView enabled but opencli absent — the mini's exact shape — falls
    // through to Unusual Whales rather than failing on the desktop app.
    await expect(
      tool("ow_spot", { OW_TV_ENABLED: "1", OPENCLI_BIN: "/nonexistent/opencli" }).run({
        tickers: ["SPY"],
      }),
    ).rejects.toThrow("OW_UW_API_KEY is unset");
  });

  it("ow_spot reads the spot from Unusual Whales when TradingView is not on this machine", async () => {
    // Frozen from the live endpoint on 2026-09-02, SPY: every price is a
    // STRING and `market_time` names the session the close came from.
    const body = {
      data: {
        close: "761.21",
        high: "761.85",
        low: "759.29",
        open: "760.86",
        volume: 329841,
        market_time: "premarket",
        tape_time: "2026-09-02T11:52:58Z",
        prev_close: "761.78",
      },
    };
    const json = await tool("ow_spot", { OW_UW_API_KEY: "k" }).run(
      { tickers: ["SPY"] },
      { fetchImpl: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch },
    );
    expect(JSON.parse(json).quotes).toEqual([
      { ticker: "SPY", source: "unusualwhales", last: 761.21, marketTime: "premarket" },
    ]);
  });

  it("ow_spot prices more tickers than its concurrency ceiling, in the order asked", async () => {
    // Eight names spans two batches of six, which is where an unordered
    // Promise.all would show: the returned list must still line up with the
    // list the role asked for, or a strike gets read against a neighbour's
    // price.
    const tickers = ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "TLT", "GLD"];
    const priced = await tool("ow_spot", { OW_UW_API_KEY: "k" }).run(
      { tickers },
      {
        fetchImpl: (async (url: URL) => {
          const symbol = url.pathname.split("/").filter(Boolean)[2] ?? "";
          return new Response(JSON.stringify({ data: { close: String(100 + tickers.indexOf(symbol)) } }));
        }) as unknown as typeof fetch,
      },
    );
    expect(JSON.parse(priced).quotes.map((q: { ticker: string }) => q.ticker)).toEqual(tickers);
    expect(JSON.parse(priced).quotes.map((q: { last: number }) => q.last)).toEqual(
      tickers.map((_, at) => 100 + at),
    );
  });

  it("tells an over-long ow_spot call to batch, instead of a bare Zod path", async () => {
    // The 2026-09-03 premarket run: gex-reporter sent 63 tickers, read
    // `too_big` off `tickers`, and re-sent the same 63 — one wasted model turn
    // per phase. The refusal has to say what to do next, in the refusal.
    const tickers = [
      "SPY", "QQQ", "IWM", "DIA", "TLT", "GLD", "SLV", "XLF", "XLE", "XLK",
      "XLV", "XLI", "XLP", "XLU", "XLY", "XLB", "XLC", "XLRE", "AAPL", "MSFT",
      "NVDA", "AMZN", "GOOGL", "META", "TSLA",
    ];
    expect(tickers).toHaveLength(25);
    await expect(tool("ow_spot").run({ tickers })).rejects.toThrow(/24/u);
    await expect(tool("ow_spot").run({ tickers })).rejects.toThrow(/split/u);
  });

  it("ow_uw_chain asks for the spot before the chain, and stops when there is none", async () => {
    // The spot is not decoration on a chain — it is what makes a strike mean
    // anything. So the ordering is load-bearing: TradingView is consulted
    // first, and a chain with no price to sit against is refused outright
    // rather than handed over as a list of unanchored numbers.
    await expect(
      tool("ow_uw_chain").run({ ticker: "SPY", minDte: 21, maxDte: 60 }),
    ).rejects.toThrow("OW_UW_API_KEY is unset");
    // A stock-state row with no close and no prev_close: the source answered,
    // it just has no price. The chain is refused rather than trimmed around
    // nothing — the failure mode that produced a 420 strike on a 707 underlying.
    await expect(
      tool("ow_uw_chain", { OW_UW_API_KEY: "k" }).run(
        { ticker: "SPY", minDte: 21, maxDte: 60 },
        {
          fetchImpl: (async () =>
            new Response(JSON.stringify({ data: {} }))) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow("no spot for SPY");
  });

  it("ow_uw_chain signs otmPct: positive out of the money on both rights", async () => {
    // SPY at 761.78 is the real spot of the 2026-09-02 run this repo's render
    // fixture comes from. The two contracts carry no NBBO here because the sign
    // of the distance is what is under test, and a quote nobody recorded would
    // be an invented price. The expiry is built from today so the DTE band
    // stays satisfied instead of expiring into a failing test.
    const expiry = new Date(Date.now() + 43 * 86_400_000);
    const yymmdd =
      String(expiry.getUTCFullYear() % 100).padStart(2, "0") +
      String(expiry.getUTCMonth() + 1).padStart(2, "0") +
      String(expiry.getUTCDate()).padStart(2, "0");
    const iso = `${String(expiry.getUTCFullYear())}-${String(expiry.getUTCMonth() + 1).padStart(2, "0")}-${String(expiry.getUTCDate()).padStart(2, "0")}`;
    const json = await tool("ow_uw_chain", { OW_UW_API_KEY: "k" }).run(
      { ticker: "SPY", minDte: 21, maxDte: 60 },
      {
        fetchImpl: (async (url: URL) => {
          if (url.pathname.endsWith("/stock-state"))
            return new Response(JSON.stringify({ data: { close: 761.78 } }));
          if (url.pathname.endsWith("/expiry-breakdown"))
            return new Response(
              JSON.stringify({ data: [{ expires: iso, open_interest: 100000, volume: 5000 }] }),
            );
          return new Response(
            JSON.stringify({
              data: [
                { option_symbol: `SPY${yymmdd}P00740000`, open_interest: 1000 },
                { option_symbol: `SPY${yymmdd}C00780000`, open_interest: 1000 },
              ],
            }),
          );
        }) as unknown as typeof fetch,
      },
    );
    const contracts = JSON.parse(json).expiries[0].contracts as Array<{
      right: string;
      strike: number;
      otmPct: number;
    }>;
    // (761.78 - 740) / 761.78 = +2.86%; (780 - 761.78) / 761.78 = +2.39%.
    // Both are OUT of the money, so both are positive — a put below spot and a
    // call above it, which is the pair a signed field has to get right.
    expect(contracts.find((c) => c.right === "P")!.otmPct).toBe(2.86);
    expect(contracts.find((c) => c.right === "C")!.otmPct).toBe(2.39);
  });

  it("ow_price_structure prices a debit spread's max loss as the debit, not the width", async () => {
    // The exact error that reached a reader on 09-02. Hand-computed, in the
    // convention of math.spec.ts: buy 555C @4.00 / sell 565C @1.50 is a 2.50
    // debit on a 10-wide spread, so max loss is 250 and max gain 750 — a model
    // that "knows" max loss = width writes 1000 and sizes the trade wrong.
    const json = await tool("ow_price_structure").run({
      spot: 560,
      legs: [
        { right: "call", action: "buy", strike: 555, expiry: "2026-09-30", mid: 4.0 },
        { right: "call", action: "sell", strike: 565, expiry: "2026-09-30", mid: 1.5 },
      ],
    });
    expect(JSON.parse(json)).toMatchObject({
      kind: "priced",
      net: -2.5,
      maxLoss: 250,
      maxGain: 750,
      breakevens: [557.5],
      width: 10,
      // The exits, multiplied out by the tool: half of the 750 max gain, and
      // for a DEBIT the stop is the debit paid (250), not twice a credit that
      // was never received. Same per-spread dollars as maxGain/maxLoss.
      exit: { takeProfit: 375, stop: 250 },
    });
  });

  it("ow_strike_check reads moneyness off the spot instead of asking a model", async () => {
    // A 180 put under a 183.60 spot was called in the money on 09-03. It is a
    // comparison; comparisons belong in code.
    const json = await tool("ow_strike_check", { OW_UW_API_KEY: "k" }).run(
      { ticker: "SPY", strikes: [{ strike: 740, right: "put" }, { strike: 780, right: "put" }] },
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ data: { close: 761.78 } }))) as unknown as typeof fetch,
      },
    );
    const rows = JSON.parse(json).rows as Array<{ moneyness: string; distPct: number }>;
    expect(rows[0]).toMatchObject({ moneyness: "OTM", distPct: -2.86 });
    expect(rows[1]).toMatchObject({ moneyness: "ITM", distPct: 2.39 });
  });

  it("ow_tv_watchlist refuses rather than returning an empty universe", async () => {
    await expect(tool("ow_tv_watchlist").run({})).rejects.toThrow("OW_UNIVERSE names no fallback");
    await expect(
      tool("ow_tv_watchlist", { OW_TV_ENABLED: "1" }).run({}),
    ).rejects.toThrow("OW_UNIVERSE names no fallback");
  });

  it("ow_tv_watchlist falls back to the operator's list, and says that is what it is", async () => {
    // Without this the universe step hands the designer an empty set and the
    // run proposes nothing while reporting "completed". The list is the
    // OPERATOR's; this tool never invents one.
    const json = await tool("ow_tv_watchlist", { OW_UNIVERSE: " spy ,qqq, spy,IWM " }).run({});
    const parsed = JSON.parse(json);
    expect(parsed.tickers).toEqual(["IWM", "QQQ", "SPY"]);
    expect(parsed.source).toContain("operator list");
    expect(parsed.note).toContain("not today's flagged watchlists");
  });

  it("ow_tv_watchlist falls back when opencli itself fails, naming the failure", async () => {
    // TradingView is a desktop GUI app: closed, mid-update or CDP port down are
    // all normal states, and none of them mean "the market is empty". Before
    // this the tool threw and took the whole run with it. OPENCLI_BIN points at
    // a path that does not exist, which is exactly what a closed app looks like
    // from here — an exec that fails.
    const json = await tool("ow_tv_watchlist", {
      OW_TV_ENABLED: "1",
      OPENCLI_BIN: "/nonexistent/opencli",
      OW_UNIVERSE: "SPY,QQQ",
    }).run({});
    const parsed = JSON.parse(json);
    expect(parsed.tickers).toEqual(["QQQ", "SPY"]);
    expect(parsed.source).toContain("operator list");
    // The reason travels with the fallback: a reader must be able to tell a
    // machine that never had TradingView from one whose app was shut.
    expect(parsed.note).toContain("/nonexistent/opencli");
  });

  it("ow_tv_watchlist keeps only optionable US listings out of a real watchlist", async () => {
    // The exact shape captured from the mini's own TradingView, 2026-09-02 —
    // section headers with no exchange at all, futures, forex, crypto, a Korean
    // listing and an index pseudo-ticker, mixed in with the real names. Before
    // the venue filter every one of these reached the designer as a candidate
    // instrument, "###BOND" and "ES1!" included.
    const script = join(tmp, "fake-opencli.sh");
    writeFileSync(
      script,
      "#!/bin/sh\ncat <<'JSON'\n" +
        JSON.stringify([
          {
            id: 122362817,
            name: "Everything",
            symbol_count: 9,
            symbols:
              "###Indices,SPCFD:SPX,CBOE:VIX,TVC:NDX,###Stocks,NASDAQ:AAPL," +
              "NYSE:GS,AMEX:SPY,CME_MINI:ES1!,FX:EURUSD,BITSTAMP:BTCUSD,KRX:000660",
          },
        ]) +
        "\nJSON\n",
      { mode: 0o755 },
    );
    const json = await tool("ow_tv_watchlist", {
      OW_TV_ENABLED: "1",
      OPENCLI_BIN: script,
    }).run({});
    const parsed = JSON.parse(json);
    expect(parsed.tickers).toEqual(["AAPL", "GS", "SPY"]);
    expect(parsed.source).toContain("TradingView");
    // The note must describe THIS payload. It used to describe ow_spot's quote
    // sources, in a payload that carries no quotes.
    expect(parsed.note).not.toContain("marketTime");
  });

  it("ow_ib_positions names the host it could not reach", async () => {
    // Port 1 on loopback: nothing listens there, so this is a connection
    // refusal rather than a timeout.
    const configured = { OW_IB_API_BASE: "http://127.0.0.1:1", OW_IB_API_KEY: "x" };
    await expect(tool("ow_ib_positions", configured).run({})).rejects.toThrow(
      "IB query api unreachable at 127.0.0.1:1",
    );
  });

  it("ow_ib_positions sends the key as X-API-Key and never as a bearer token", async () => {
    // The credential is what makes this tenant unable to place an order: it is
    // authorised for a fixed allow-list of read paths and refused on every
    // write path. Sent under the wrong header it would simply be unauthenticated,
    // which is a failure — but a silent one to write down.
    let seen: Headers | undefined;
    const configured = { OW_IB_API_BASE: "http://ib.invalid", OW_IB_API_KEY: "secret-key" };
    await tool("ow_ib_positions", configured).run(
      {},
      {
        fetchImpl: async (_url: unknown, init?: { headers?: HeadersInit }) => {
          seen = new Headers(init?.headers);
          return new Response(JSON.stringify({ last_sync: new Date().toISOString() }), {
            status: 200,
          });
        },
      } as never,
    );
    expect(seen?.get("x-api-key")).toBe("secret-key");
    expect(seen?.get("authorization")).toBeNull();
  });
});

describe("ow_argon_levels", () => {
  // Frozen from argon's live FastAPI on the mac mini, 2026-09-03 (verified via
  // `ssh macmini curl -s http://localhost:8400/api/regime/dealer?ticker=SPY`
  // and the sibling endpoints; this laptop has no local argon on :8400).
  const DEALER_SPY = {
    status: "ok",
    ticker: "SPY",
    spot: 768.86,
    net_gex: 280354.25139999995,
    closest_levels: [
      { label: "Call Wall", direction: "up", role: "resistance", strike: 770.0, distance_pct: 0.0014827146684701848, gamma: 75477.6864 },
      { label: "Gamma Flip", direction: "down", role: "flip", strike: 766.0, distance_pct: -0.0037197929401971926, gamma: 0 },
    ],
    odte_share_pct: 1.0,
  };
  const GEX_SPY = {
    data_date: "2026-09-03",
    spot: 768.8999,
    levels: {
      gex_flip: { strike: 770.0, gamma: 0.0 },
      max_magnet: { strike: 770.0, gamma: 399851.57 },
      second_magnet: { strike: 775.0, gamma: 286304.97 },
      max_accelerator: { strike: 760.0, gamma: -407341.53 },
      put_wall: { strike: 765.0, gamma: -282810.37 },
      call_wall: { strike: 770.0, gamma: 399851.57 },
    },
    expected_range: { low: 762.99, high: 774.81, iv_1d: 0.7685 },
    mq: null,
  };
  const MAGNETS_SPY = {
    ticker: "SPY",
    as_of: "2026-09-02",
    levels: {
      resistance: 759.57,
      support: 725.43,
      stretch: 780.6685200000001,
      down: 704.3314799999999,
      sma20: 768.976,
      last: 765.16,
      pivot_a: { index: 284, kind: "top", price: 759.57 },
      pivot_b: { index: 290, kind: "bottom", price: 725.43 },
    },
  };
  const TECHNICALS_SPY = {
    ticker: "SPY",
    available: true,
    captured_at: "2026-09-03T22:22:15.989000+08:00",
    spot: 768.72,
    spot_source: "xenon_ws",
  };

  function routedFetch(byPath: Record<string, unknown | "404">) {
    return (async (url: URL) => {
      const hit = byPath[url.pathname];
      if (hit === undefined) throw new Error(`unexpected path in test: ${url.pathname}`);
      if (hit === "404") return new Response("not found", { status: 404, statusText: "Not Found" });
      return new Response(JSON.stringify(hit), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("parses the frozen real argon response into compact per-ticker levels", async () => {
    const json = await tool("ow_argon_levels", { OW_ARGON_API_BASE: "http://argon.test" }).run(
      { tickers: ["SPY"] },
      {
        fetchImpl: routedFetch({
          "/api/regime/dealer": DEALER_SPY,
          "/api/regime/gex": GEX_SPY,
          "/api/stock/SPY/magnets": MAGNETS_SPY,
          "/api/stock/SPY/technicals/live": TECHNICALS_SPY,
        }),
      },
    );
    const parsed = JSON.parse(json);
    expect(parsed.source).toBe("argon");
    expect(parsed.levels).toHaveLength(1);
    const row = parsed.levels[0];
    expect(row.ticker).toBe("SPY");
    // The freshest read wins: technicals/live over the scan's own spot.
    expect(row.spot).toEqual({ value: 768.72, source: "technicals/live" });
    expect(row.technical).toEqual({
      support: 725.43,
      resistance: 759.57,
      pivot_a: 759.57,
      pivot_b: 725.43,
      sma20: 768.976,
    });
    expect(row.technicalAsOf).toBe("2026-09-02");
    expect(row.gamma).toEqual({
      gex_flip: 770.0,
      call_wall: 770.0,
      put_wall: 765.0,
      max_magnet: 770.0,
      // mq was null on this live scan — hvl is absent, never invented as 0.
    });
    expect(row.gamma.hvl).toBeUndefined();
    expect(row.gammaAsOf).toBe("2026-09-03");
    expect(row.closest_levels).toEqual([
      { label: "Call Wall", role: "resistance", strike: 770.0, distance_pct: 0.0014827146684701848 },
      { label: "Gamma Flip", role: "flip", strike: 766.0, distance_pct: -0.0037197929401971926 },
    ]);
    expect(row.expected_range).toEqual({ low: 762.99, high: 774.81 });
    expect(row.as_of).toBe("2026-09-03");
    expect(row.unavailable).toBeUndefined();
  });

  it("returns a partial row, never throws, when one sub-endpoint 404s", async () => {
    const json = await tool("ow_argon_levels", { OW_ARGON_API_BASE: "http://argon.test" }).run(
      { tickers: ["SPY"] },
      {
        fetchImpl: routedFetch({
          "/api/regime/dealer": DEALER_SPY,
          "/api/regime/gex": GEX_SPY,
          "/api/stock/SPY/magnets": "404",
          "/api/stock/SPY/technicals/live": TECHNICALS_SPY,
        }),
      },
    );
    const row = JSON.parse(json).levels[0];
    // The three live endpoints still answer — a downed magnets service
    // degrades this ticker's row, it does not blank it.
    expect(row.gamma.call_wall).toBe(770.0);
    expect(row.closest_levels).toBeDefined();
    expect(row.technical).toBeUndefined();
    expect(row.unavailable).toHaveLength(1);
    expect(row.unavailable[0]).toContain("404");
  });

  it("throws only when every sub-endpoint fails for every ticker", async () => {
    await expect(
      tool("ow_argon_levels", { OW_ARGON_API_BASE: "http://argon.test" }).run(
        { tickers: ["SPY"] },
        {
          fetchImpl: routedFetch({
            "/api/regime/dealer": "404",
            "/api/regime/gex": "404",
            "/api/stock/SPY/magnets": "404",
            "/api/stock/SPY/technicals/live": "404",
          }),
        },
      ),
    ).rejects.toThrow("ow_argon_levels: argon returned nothing usable for any of SPY");
  });
});

describe("ow_ib_preflight", () => {
  it("evaluates a proposal without touching the network and without writing a record", async () => {
    const out = JSON.parse(
      await tool("ow_ib_preflight").run({
        ticker: "AAPL",
        strategy: "put-credit-spread",
        legs: [
          { right: "P", expiry: "2026-10-16", strike: 320, action: "SELL", ratio: 1 },
          { right: "P", expiry: "2026-10-16", strike: 315, action: "BUY", ratio: 1 },
        ],
        rationale: "spot 325.13, last close as of 2026-09-02",
      }),
    ) as {
      contentHash: string;
      pass: boolean;
      unchecked: string[];
      gates: Record<string, { pass: boolean; state: string }>;
    };
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(out.gates.defined_risk.pass).toBe(true);
    // A defined-risk spread passes, and says which four sub-gates never ran.
    expect(out.pass).toBe(true);
    expect(out.unchecked).toHaveLength(4);
    expect(out).not.toHaveProperty("recordPath");
  });
});

describe("stale data", () => {
  const live = { OW_IB_API_BASE: "http://ib.invalid", OW_IB_API_KEY: "k" };
  const respond = (body: unknown) =>
    ({
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    }) as never;

  it("refuses an account snapshot older than the bound, naming its age", async () => {
    // The real failure: xenon serves /portfolio from a persisted table that
    // only POST /portfolio/sync refreshes — a write path this read-only key is
    // refused on — so it came back 35 days old with nothing flagging it, and a
    // role reasoned about today's buying power from it.
    const old = new Date(Date.now() - 35 * 86_400_000).toISOString();
    await expect(
      tool("ow_ib_positions", live).run({}, respond({ last_sync: old, bankroll: 1 })),
    ).rejects.toThrow(/840\.\d+h old, past the 24h bound/);
  });

  it("names the age but never the zoneless last_sync", async () => {
    // xenon writes last_sync without a zone. A role that copies it into a
    // coverage table either repeats an undateable instant or appends the `Z`
    // it thinks is right — and the as-of gate, which looks for the prose
    // stamp verbatim in the tool output, refused that invented `Z` and failed
    // the whole 2026-09-02 intraday run.
    const naive = "2026-07-29T20:27:18.543065";
    const message = await tool("ow_ib_positions", live)
      .run({}, respond({ last_sync: naive, bankroll: 1 }))
      .then(() => "resolved, which it must not")
      .catch((err: unknown) => (err as Error).message);
    expect(message).toMatch(/past the 24h bound/);
    expect(message).not.toContain("2026-07-29T20:27:18");
  });

  it("passes a fresh snapshot and staples its age to the payload", async () => {
    const fresh = new Date(Date.now() - 3_600_000).toISOString();
    const out = await tool("ow_ib_positions", live).run(
      {},
      respond({ last_sync: fresh, bankroll: 1 }),
    );
    expect(JSON.parse(out).snapshotAgeHours).toBeCloseTo(1, 1);
  });

  it("refuses a snapshot with no date at all", async () => {
    await expect(
      tool("ow_ib_positions", live).run({}, respond({ bankroll: 1 })),
    ).rejects.toThrow("undateable account snapshot");
  });
});

describe("symbolLiteral", () => {
  it("passes ordinary symbols through, upper-cased", () => {
    expect(symbolLiteral("spy", "t")).toBe("SPY");
    expect(symbolLiteral("BRK.B", "t")).toBe("BRK.B");
    expect(symbolLiteral("ES1!", "t")).toBe("ES1!");
  });

  it("refuses anything that could close a quote or a path", () => {
    // These reach a psql -c string and a URL path segment, and they arrive
    // from a model's tool call — the one input here that is nobody's contract.
    for (const bad of ["SPY'; DROP TABLE x --", "../../etc", "SPY OR 1=1", ""]) {
      expect(() => symbolLiteral(bad, "t")).toThrow("is not a symbol this tool will pass on");
    }
  });
});

describe("dteOf", () => {
  const now = new Date("2026-09-02T10:00:00Z");

  it("reads both the dashed and the compact spelling as the same day", () => {
    // Fixed-offset slicing of "2026-10-16" reads a month of "-1" and yields
    // NaN, which compares false against every DTE bound — so a whole chain
    // silently reports no expiries in band. That is what the first live UW call
    // did.
    expect(dteOf("2026-10-16", now)).toBe(44);
    expect(dteOf("20261016", now)).toBe(44);
  });
});

describe("thinAcross", () => {
  it("keeps both ends, so the wings survive the trim", () => {
    // The first trim kept the N contracts NEAREST spot, which collapsed a SPY
    // put chain to strikes 738-780 around a 761.78 spot. The designer then
    // wrote a 746/724 spread whose 724 leg was never in the chain it saw — an
    // unanchored strike, reintroduced by the trimming that was meant to make
    // the chain readable.
    const strikes = Array.from({ length: 100 }, (_, i) => 700 + i);
    const kept = thinAcross(strikes, 10);
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(kept[0]).toBe(700);
    expect(kept[kept.length - 1]).toBe(799);
  });

  it("passes a short list through untouched", () => {
    expect(thinAcross([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe("parseOcc", () => {
  // Unusual Whales returns no strike field at all: on a live
  // /api/stock/SPY/option-contracts?expiry=2026-10-16 response (2026-09-02,
  // 442 rows) the strike exists only inside option_symbol. Every strike this
  // tenant reads from UW is produced here, so a wrong split here is a wrong
  // strike in a proposal.
  it("splits a real OCC symbol from the right", () => {
    expect(parseOcc("SPY261016P00725000")).toEqual({
      root: "SPY",
      expiry: "2026-10-16",
      right: "P",
      strike: 725,
    });
  });

  it("handles a fractional strike and a longer root", () => {
    expect(parseOcc("NVDA261016C00217500")).toMatchObject({ root: "NVDA", strike: 217.5 });
  });

  it("returns undefined rather than a guess on anything else", () => {
    for (const bad of ["", "SPY", "SPY261016X00725000", "SPY2610161P00725000"]) {
      expect(parseOcc(bad)).toBeUndefined();
    }
  });
});

describe("tvLiveLevels", () => {
  // The overlay is an ADDITION to argon's daily path, so a broken TradingView
  // must cost the caller the intraday level and nothing else. It also must not
  // go quiet: an absent curve that reported nothing would let a regime read
  // quote an 8-day-old 10y as this morning's, which is the whole reason the
  // overlay exists.
  it("reports why it has no curve instead of throwing", async () => {
    for (const env of [
      {},
      { OW_TV_ENABLED: "1" },
      { OW_TV_ENABLED: "1", OPENCLI_BIN: "/nonexistent/opencli" },
    ]) {
      const result = await tvLiveLevels(env, "ow_macro_rates");
      expect(result).toHaveProperty("unavailable");
      expect((result as { unavailable: string }).unavailable).not.toBe("");
    }
  });
});

describe("staleSeries", () => {
  const rows = [
    { series_id: "DGS10", obs_date: "2026-08-25" },
    { series_id: "VIXCLS", obs_date: "2026-08-25" },
    { series_id: "BAMLH0A0HYM2", obs_date: "2026-08-25" },
    { series_id: "DTWEXBGS", obs_date: "2026-08-21" },
    { series_id: "T10YIE", obs_date: "2026-09-02" },
  ];
  const now = new Date("2026-09-02T10:00:00Z");

  it("names only the series TradingView cannot replace, oldest first", () => {
    // DGS10 and VIXCLS have live twins, so their daily age is not a caveat —
    // the report quotes the live level for both. Reporting them anyway would
    // train a reader to skip the list.
    expect(staleSeries(rows, now)).toEqual([
      { seriesId: "DTWEXBGS", latestObs: "2026-08-21", ageDays: 12 },
      { seriesId: "BAMLH0A0HYM2", latestObs: "2026-08-25", ageDays: 8 },
    ]);
  });

  it("says nothing when argon has caught up", () => {
    expect(staleSeries([{ series_id: "T10YIE", obs_date: "2026-09-02" }], now)).toEqual([]);
  });
});

describe("parseFredCsv", () => {
  // Shape captured live 2026-09-03 09:51 UTC from
  // fredgraph.csv?id=BAMLH0A0HYM2, with a `.` row appended: FRED dates every
  // calendar day and writes `.` where there is no observation, so the last
  // LINE is regularly not the last OBSERVATION.
  const csv = [
    "observation_date,BAMLH0A0HYM2",
    "2026-08-28,2.71",
    "2026-09-01,2.65",
    "2026-09-02,.",
    "",
  ].join("\n");

  it("takes the last row that carries a number, not the last row", () => {
    expect(parseFredCsv(csv)).toEqual({ value: 2.65, asOf: "2026-09-01" });
  });

  it("returns undefined rather than a NaN when nothing is observed", () => {
    expect(parseFredCsv("observation_date,ANFCI\n2026-09-02,.\n")).toBeUndefined();
    expect(parseFredCsv("observation_date,ANFCI\n")).toBeUndefined();
  });
});

describe("fredDirect", () => {
  // The laptop cannot reach fred.stlouisfed.org at all (SSL fails) while the
  // mini can. That difference must reach the report as a reason, never as a
  // number and never as silence — the whole point of the fresher point is that
  // it is honest about being absent.
  it("reports why it has no point instead of throwing or estimating", async () => {
    const result = await fredDirect(["BAMLH0A0HYM2", "ANFCI"], {
      fetchImpl: (async () => {
        throw new Error("unable to verify the first certificate");
      }) as unknown as typeof fetch,
    });
    expect(result.points).toEqual([]);
    expect(result.skipped.map((row) => row.series)).toEqual(["BAMLH0A0HYM2", "ANFCI"]);
    for (const row of result.skipped) expect(row.reason).toContain("certificate");
  });

  it("labels the point with FRED direct and its lag when the fetch lands", async () => {
    const result = await fredDirect(["BAMLH0A0HYM2"], {
      fetchImpl: (async () =>
        new Response("observation_date,BAMLH0A0HYM2\n2026-09-01,2.65\n")) as unknown as typeof fetch,
    });
    expect(result.skipped).toEqual([]);
    expect(result.points).toEqual([
      {
        series: "BAMLH0A0HYM2",
        value: 2.65,
        asOf: "2026-09-01",
        source: "FRED direct (fredgraph.csv), ~1-2 day lag",
      },
    ]);
  });
});
