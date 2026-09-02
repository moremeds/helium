/**
 * The property that matters: with nothing configured, every tool THROWS and
 * names what is missing. A tool that returned a plausible empty shape here
 * would put an invented number in a trading email.
 */
import { describe, expect, it } from "vitest";
import { VOCABULARY, buildTools } from "../tools/index.js";

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

  it("registers no tool with order semantics", () => {
    for (const name of VOCABULARY.keys()) {
      expect(name).not.toMatch(/order|place|submit|cancel|amend/u);
    }
  });
});

describe("absent environment", () => {
  it.each([
    ["ow_ib_positions", {}, "OW_IB_API_BASE is unset"],
    ["ow_ib_chain", { ticker: "AAPL", minDte: 21, maxDte: 60 }, "OW_IB_API_BASE is unset"],
    ["ow_ib_quote", { ticker: "AAPL", conIds: [265598] }, "OW_IB_API_BASE is unset"],
    ["ow_argon_watchlist", {}, "OW_ARGON_API_BASE is unset"],
    ["ow_uw_ticker_metrics", { tickers: ["AAPL"] }, "OW_UW_API_KEY is unset"],
    ["ow_uw_market_state", { sector: "Technology", etf: "XLK" }, "OW_UW_API_KEY is unset"],
    ["ow_macro_rates", { maturities: ["10year"] }, "OW_UW_API_KEY is unset"],
  ])("%s throws naming the missing key", async (name, args, message) => {
    await expect(tool(name).run(args as Record<string, unknown>)).rejects.toThrow(message);
  });

  it("ow_tv_watchlist refuses while disabled rather than returning an empty universe", async () => {
    await expect(tool("ow_tv_watchlist").run({})).rejects.toThrow("OW_TV_ENABLED");
    await expect(
      tool("ow_tv_watchlist", { OW_TV_ENABLED: "1" }).run({}),
    ).rejects.toThrow("OPENCLI_BIN is unset");
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
          return new Response("{}", { status: 200 });
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
    ) as { contentHash: string; pass: boolean; gates: Record<string, { pass: boolean }> };
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(out.gates.defined_risk.pass).toBe(true);
    expect(out.pass).toBe(false);
    expect(out).not.toHaveProperty("recordPath");
  });
});
