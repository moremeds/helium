/**
 * The property that matters: with nothing configured, every tool THROWS and
 * names what is missing. A tool that returned a plausible empty shape here
 * would put an invented number in a trading email.
 */
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
} from "../tools/index.js";

const EMPTY_ENV: Record<string, string | undefined> = {};

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
        quantity: 1,
        limitPrice: -1.35,
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
    ).rejects.toThrow(/840\.\d+h old .*past the 24h bound/);
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
