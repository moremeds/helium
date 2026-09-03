/**
 * ow_uw_gex quotes Unusual Whales' levels back verbatim. The fixture is the
 * real 2026-09-02 SPY response, captured live — not a shape, the body — so a
 * regression that reformats "764.77" into a number fails here rather than in
 * a trading email.
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

function gexTool(env: Record<string, string | undefined> = { OW_UW_API_KEY: "k" }) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find((t) => t.name === "ow_uw_gex");
  if (found === undefined) throw new Error("no tool ow_uw_gex");
  return found;
}

describe("ow_uw_gex", () => {
  it("returns UW's levels verbatim, as strings, with the as-of time", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(SPY_GEX), { status: 200 });
    };
    const out = JSON.parse(
      await gexTool().run({ tickers: ["SPY"] }, { fetchImpl } as never),
    ) as { levels: unknown[]; unavailable: unknown[] };
    expect(calls[0]).toBe("https://api.unusualwhales.com/api/stock/SPY/gex-levels?source=vol");
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
    });
    expect(out.unavailable).toEqual([]);
  });

  it("unwraps a `data` envelope the same way", async () => {
    const out = JSON.parse(
      await gexTool().run(
        { tickers: ["SPY"] },
        { fetchImpl: async () => new Response(JSON.stringify({ data: SPY_GEX }), { status: 200 }) } as never,
      ),
    ) as { levels: Array<{ gammaFlip: string }> };
    expect(out.levels[0].gammaFlip).toBe("764.77");
  });

  it("names the ticker that failed and still returns the one that worked", async () => {
    const fetchImpl = async (url: URL) =>
      url.pathname.includes("/QQQ/")
        ? new Response("", { status: 502, statusText: "Bad Gateway" })
        : new Response(JSON.stringify(SPY_GEX), { status: 200 });
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
      gexTool().run(
        { tickers: ["SPY", "QQQ"] },
        { fetchImpl: async () => new Response("", { status: 500, statusText: "Server Error" }) } as never,
      ),
    ).rejects.toThrow(/no ticker returned levels — SPY: .*500.*QQQ: .*500/su);
  });

  it("throws when OW_UW_API_KEY is unset rather than answering without one", async () => {
    await expect(gexTool({}).run({ tickers: ["SPY"] })).rejects.toThrow(/OW_UW_API_KEY is unset/u);
  });

  it("defaults to SPY and QQQ", async () => {
    const calls: string[] = [];
    await gexTool().run(
      {},
      {
        fetchImpl: async (url: URL) => {
          calls.push(url.pathname);
          return new Response(JSON.stringify(SPY_GEX), { status: 200 });
        },
      } as never,
    );
    expect(calls).toEqual(["/api/stock/SPY/gex-levels", "/api/stock/QQQ/gex-levels"]);
  });
});
