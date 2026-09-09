/**
 * `ow_premarket_movers` shells out to opencli. The subprocess is mocked — CI
 * has no opencli and no TradingView app — but every fixture below is a REAL
 * row captured on this laptop at 2026-09-09T13:25Z with
 *
 *   opencli tradingview screener \
 *     --tickers NASDAQ:META,NASDAQ:NVDA,NYSE:ORCL \
 *     --columns name,close,change,premarket_change,premarket_close,\
 *               premarket_volume,postmarket_change -f json
 *
 * digits included. What is asserted is what can actually break: the one call,
 * the venue expansion, the sort, the truncation, the two ways a name lands in
 * `missing`, and the fact that `ret` is TradingView's own double and is never
 * rounded on the way through.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { bin: string; argv: string[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  handler: (() => "[]") as (call: { argv: string[] }) => string,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn(
    (
      bin: string,
      argv: string[],
      _opts: unknown,
      cb: (e: unknown, r: unknown) => void,
    ) => {
      state.calls.push({ bin, argv });
      let out = "";
      let failure: unknown = null;
      try {
        out = state.handler({ argv });
      } catch (error: unknown) {
        failure = error;
      }
      setTimeout(() => {
        cb(failure, { stdout: out, stderr: "" });
      }, 0);
    },
  );
  return { ...actual, execFile };
});

const { buildTools } = await import("../tools/index.js");

/** Live, 2026-09-09T13:25Z. `postmarket_change` was null on all three: the
 *  probe was taken during the premarket session. */
const LIVE_ROWS: Record<string, Record<string, unknown>> = {
  "NASDAQ:META": {
    symbol: "NASDAQ:META",
    name: "META",
    close: 613.48,
    change: -0.5334241289297411,
    premarket_change: 5.794467627306518,
    premarket_close: 649.0279,
    premarket_volume: 1580739,
    postmarket_change: null,
  },
  "NASDAQ:NVDA": {
    symbol: "NASDAQ:NVDA",
    name: "NVDA",
    close: 225.73,
    change: -2.0098975516582844,
    premarket_change: -0.474,
    premarket_close: 224.66,
    premarket_volume: 1094949,
    postmarket_change: null,
  },
  "NYSE:ORCL": {
    symbol: "NYSE:ORCL",
    name: "ORCL",
    close: 162.52,
    change: 2.355460385438978,
    premarket_change: 0.521,
    premarket_close: 163.367,
    premarket_volume: 521376,
    postmarket_change: null,
  },
};

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

function moversTool(overrides: Record<string, unknown> = {}): {
  run: (args: Record<string, unknown>) => Promise<string>;
} {
  const found = buildTools({
    stateRoot: mkdtempSync(join(tmpdir(), "ow-premarket-movers-")),
    env: { OW_TV_ENABLED: "1", OPENCLI_BIN: "/usr/local/bin/opencli" },
    ...overrides,
  }).find((tool) => tool.name === "ow_premarket_movers");
  if (found === undefined) throw new Error("no tool ow_premarket_movers");
  return found;
}

interface Payload {
  asOf: string;
  session: string;
  rows: Array<{
    symbol: string;
    tvSymbol: string;
    ret: number;
    source: string;
  }>;
  missing: string[];
}

/** The screener answers ONLY the venue that actually lists the name — a wrong
 *  one is silent, which is why the expansion is safe to send in one call. */
beforeEach(() => {
  state.calls = [];
  state.handler = ({ argv }) =>
    JSON.stringify(
      (flag(argv, "--tickers") ?? "")
        .split(",")
        .map((symbol) => LIVE_ROWS[symbol])
        .filter((row) => row !== undefined),
    );
});

describe("ow_premarket_movers", () => {
  it("sorts by absolute move and carries TradingView's own percent verbatim", async () => {
    const out = JSON.parse(
      await moversTool().run({
        symbols: "NASDAQ:NVDA,NYSE:ORCL,NASDAQ:META",
      }),
    ) as Payload;
    expect(out.rows.map((row) => row.symbol)).toEqual([
      "NASDAQ:META",
      "NYSE:ORCL",
      "NASDAQ:NVDA",
    ]);
    // NOT 5.79, not "5.8%". The renderer formats; this file carries.
    expect(out.rows[0]?.ret).toBe(5.794467627306518);
    expect(out.rows[0]?.source).toBe("tradingview:screener");
    expect(out.session).toBe("premarket");
    expect(out.missing).toEqual([]);
    // ORCL is ranked above NVDA on |0.521| > |0.474| even though its move is
    // the smaller NUMBER only if the sign is ignored — which is the point.
    expect(out.rows[1]?.ret).toBe(0.521);
    expect(out.rows[2]?.ret).toBe(-0.474);
  });

  it("makes exactly one screener call for the whole list", async () => {
    await moversTool().run({ symbols: "NASDAQ:META,NASDAQ:NVDA,NYSE:ORCL" });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.argv.slice(0, 2)).toEqual([
      "tradingview",
      "screener",
    ]);
    expect(flag(state.calls[0]?.argv ?? [], "--columns")).toContain(
      "premarket_change",
    );
  });

  it("truncates to `top`, largest first", async () => {
    const out = JSON.parse(
      await moversTool().run({
        symbols: "NASDAQ:NVDA,NYSE:ORCL,NASDAQ:META",
        top: 1,
      }),
    ) as Payload;
    expect(out.rows.map((row) => row.symbol)).toEqual(["NASDAQ:META"]);
    // A name that answered but did not make the cut is NOT missing: it was
    // measured, it just did not move enough.
    expect(out.missing).toEqual([]);
  });

  it("resolves a bare ticker across the US venues in the same one call", async () => {
    const out = JSON.parse(
      await moversTool().run({ symbols: "META,ORCL" }),
    ) as Payload;
    expect(state.calls).toHaveLength(1);
    expect(flag(state.calls[0]?.argv ?? [], "--tickers")).toBe(
      "NASDAQ:META,AMEX:META,NYSE:META,NASDAQ:ORCL,AMEX:ORCL,NYSE:ORCL",
    );
    // The ask is echoed back as it was written; `tvSymbol` names the venue
    // that answered, so a caller feeding these into the news pass does not
    // have to resolve it a second time.
    expect(out.rows.map((row) => [row.symbol, row.tvSymbol])).toEqual([
      ["META", "NASDAQ:META"],
      ["ORCL", "NYSE:ORCL"],
    ]);
  });

  it("puts a null change in `missing` rather than reading it as flat", async () => {
    state.handler = () =>
      JSON.stringify([{ ...LIVE_ROWS["NASDAQ:META"], premarket_change: null }]);
    const out = JSON.parse(
      await moversTool().run({ symbols: "NASDAQ:META" }),
    ) as Payload;
    expect(out.rows).toEqual([]);
    expect(out.missing).toEqual(["NASDAQ:META"]);
  });

  it("puts a symbol absent from the response in `missing`", async () => {
    // NYSE:META is a real venue and a wrong one, and the screener says so by
    // saying nothing at all.
    const out = JSON.parse(
      await moversTool().run({ symbols: "NYSE:META,NASDAQ:META" }),
    ) as Payload;
    expect(out.missing).toEqual(["NYSE:META"]);
    expect(out.rows.map((row) => row.symbol)).toEqual(["NASDAQ:META"]);
  });

  it("reads postmarket_change for the postmarket session", async () => {
    const out = JSON.parse(
      await moversTool().run({
        symbols: "NASDAQ:META,NASDAQ:NVDA,NYSE:ORCL",
        session: "postmarket",
      }),
    ) as Payload;
    expect(out.session).toBe("postmarket");
    // All three carried `postmarket_change: null` in the 13:25Z probe, which
    // is the honest answer for a premarket read: no rows, three names named.
    expect(out.rows).toEqual([]);
    expect(out.missing).toEqual(["NASDAQ:META", "NASDAQ:NVDA", "NYSE:ORCL"]);
  });

  it("refuses rather than answering on a machine with no TradingView route", async () => {
    await expect(
      moversTool({ env: { OPENCLI_BIN: "/usr/local/bin/opencli" } }).run({
        symbols: "NASDAQ:META",
      }),
    ).rejects.toThrow(/OW_TV_ENABLED/u);
    await expect(
      moversTool({ env: { OW_TV_ENABLED: "1" } }).run({
        symbols: "NASDAQ:META",
      }),
    ).rejects.toThrow(/OPENCLI_BIN/u);
    expect(state.calls).toHaveLength(0);
  });
});
