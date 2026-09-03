/**
 * ow_uw_gex quotes Unusual Whales' levels back verbatim. The gex-levels
 * fixture is the real 2026-09-02 SPY response, captured live — not a shape,
 * the body — so a regression that reformats "764.77" into a number fails
 * here rather than in a trading email.
 *
 * gex-levels carries no net GEX/DEX total, so the tool also calls
 * /spot-exposures for that and must pick the row with the max `time` itself:
 * verified live 2026-09-03 that endpoint ignores `limit` and returns the
 * whole session, oldest first.
 */
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

/** The real 2026-09-02 SPY response, captured live. Not a shape, the body. */
const SPY_GEX = {
  date: "2026-09-02",
  time: "2026-09-02T17:31:16.000000Z",
  source: "vol",
  call_wall: "766",
  gamma_flip: "764.77",
  gamma_magnet: "766",
  nearby_flips: ["764.77", "765.16", "770.49", "758.3", "771.37"],
  put_wall: "764",
};

/**
 * Mock /spot-exposures rows, oldest first — the order UW actually returns
 * them in, `limit` ignored. Three rows so max-`time` selection is a real
 * comparison, not a one-element no-op.
 */
const SPY_SPOT_EXPOSURES = [
  {
    time: "2026-09-03T13:53:00.000000Z",
    ticker: "SPY",
    price: "764.10",
    gamma_per_one_percent_move_oi: "-17600000000.00",
    charm_per_one_percent_move_oi: "-655000000000.0",
    vanna_per_one_percent_move_oi: "560000000.00",
  },
  {
    time: "2026-09-03T13:54:03.000000Z",
    ticker: "SPY",
    price: "764.30",
    gamma_per_one_percent_move_oi: "-17700000000.00",
    charm_per_one_percent_move_oi: "-656000000000.0",
    vanna_per_one_percent_move_oi: "562000000.00",
  },
  {
    time: "2026-09-03T13:55:06.000000Z",
    ticker: "SPY",
    price: "764.55",
    gamma_per_one_percent_move_oi: "-17753186963.86",
    charm_per_one_percent_move_oi: "-656557390747.5",
    vanna_per_one_percent_move_oi: "563446443.17",
  },
];

/** Routes a mock fetch by path: gex-levels vs. spot-exposures vs. unknown. */
function routedFetch(opts: {
  gexLevels?: (url: URL) => Response;
  spotExposures?: (url: URL) => Response;
}) {
  return async (url: URL) => {
    if (url.pathname.includes("/gex-levels")) {
      return opts.gexLevels
        ? opts.gexLevels(url)
        : new Response(JSON.stringify(SPY_GEX), { status: 200 });
    }
    if (url.pathname.includes("/spot-exposures")) {
      return opts.spotExposures
        ? opts.spotExposures(url)
        : new Response(JSON.stringify({ data: SPY_SPOT_EXPOSURES }), {
            status: 200,
          });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };
}

function gexTool(
  env: Record<string, string | undefined> = { OW_UW_API_KEY: "k" },
) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find(
    (t) => t.name === "ow_uw_gex",
  );
  if (found === undefined) throw new Error("no tool ow_uw_gex");
  return found;
}

describe("ow_uw_gex", () => {
  it("returns UW's levels verbatim, as strings, with the as-of time", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: URL) => {
      calls.push(url.toString());
      return routedFetch({})(url);
    };
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY"] }, { fetchImpl } as never),
    ) as { levels: unknown[]; unavailable: unknown[] };
    expect(calls[0]).toBe(
      "https://api.unusualwhales.com/api/stock/SPY/gex-levels?source=vol",
    );
    expect(out.levels[0]).toEqual({
      ticker: "SPY",
      date: "2026-09-02",
      asOf: "2026-09-02T17:31:16.000000Z",
      source: "vol",
      callWall: "766",
      putWall: "764",
      gammaFlip: "764.77",
      gammaMagnet: "766",
      nearbyFlips: ["764.77", "765.16", "770.49", "758.3", "771.37"],
      spotGamma: {
        time: "2026-09-03T13:55:06.000000Z",
        price: "764.55",
        gammaPer1PctOi: "-17753186963.86",
        charmPer1PctOi: "-656557390747.5",
        vannaPer1PctOi: "563446443.17",
      },
    });
    expect(out.unavailable).toEqual([]);
  });

  it("picks the row with the max `time` when spot-exposures ignores `limit` and returns rows oldest-first", async () => {
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY"] }, {
        fetchImpl: routedFetch({}),
      } as never),
    ) as {
      levels: Array<{ spotGamma: { time: string; gammaPer1PctOi: string } }>;
    };
    expect(out.levels[0].spotGamma.time).toBe("2026-09-03T13:55:06.000000Z");
    expect(out.levels[0].spotGamma.gammaPer1PctOi).toBe("-17753186963.86");
  });

  it("a failing spot-exposures call leaves the levels row intact and adds an unavailable reason", async () => {
    const fetchImpl = routedFetch({
      spotExposures: () =>
        new Response("", { status: 503, statusText: "Service Unavailable" }),
    });
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY"] }, { fetchImpl } as never),
    ) as {
      levels: Array<{ ticker: string; gammaFlip: string; spotGamma?: unknown }>;
      unavailable: Array<{ ticker: string; reason: string }>;
    };
    expect(out.levels[0].gammaFlip).toBe("764.77");
    expect(out.levels[0].spotGamma).toBeUndefined();
    expect(out.unavailable).toEqual([
      { ticker: "SPY", reason: expect.stringContaining("spotGamma") },
    ]);
    expect(out.unavailable[0].reason).toContain("503");
  });

  it("unwraps a `data` envelope the same way", async () => {
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY"] }, {
        fetchImpl: routedFetch({
          gexLevels: () =>
            new Response(JSON.stringify({ data: SPY_GEX }), { status: 200 }),
        }),
      } as never),
    ) as { levels: Array<{ gammaFlip: string }> };
    expect(out.levels[0].gammaFlip).toBe("764.77");
  });

  it("names the ticker that failed and still returns the one that worked", async () => {
    const fetchImpl = async (url: URL) =>
      url.pathname.includes("/QQQ/")
        ? new Response("", { status: 502, statusText: "Bad Gateway" })
        : routedFetch({})(url);
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY", "QQQ"] }, { fetchImpl } as never),
    ) as {
      levels: Array<{ ticker: string }>;
      unavailable: Array<{ ticker: string; reason: string }>;
    };
    expect(out.levels.map((row) => row.ticker)).toEqual(["SPY"]);
    expect(out.unavailable[0].ticker).toBe("QQQ");
    expect(out.unavailable[0].reason).toContain("502");
  });

  it("throws rather than returning an empty level set", async () => {
    await expect(
      gexTool().run({ tickers: ["SPY", "QQQ"] }, {
        fetchImpl: async () =>
          new Response("", { status: 500, statusText: "Server Error" }),
      } as never),
    ).rejects.toThrow(/no ticker returned levels — SPY: .*500.*QQQ: .*500/su);
  });

  it("throws when OW_UW_API_KEY is unset rather than answering without one", async () => {
    await expect(gexTool({}).run({ tickers: ["SPY"] })).rejects.toThrow(
      /OW_UW_API_KEY is unset/u,
    );
  });

  it("defaults to SPY and QQQ", async () => {
    const calls: string[] = [];
    await gexTool().run({}, {
      fetchImpl: async (url: URL) => {
        calls.push(url.pathname);
        return routedFetch({})(url);
      },
    } as never);
    expect(calls).toEqual([
      "/api/stock/SPY/gex-levels",
      "/api/stock/SPY/spot-exposures",
      "/api/stock/QQQ/gex-levels",
      "/api/stock/QQQ/spot-exposures",
    ]);
  });
});
