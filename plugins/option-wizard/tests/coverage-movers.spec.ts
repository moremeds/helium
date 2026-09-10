/**
 * #113 item 1, Loop 4: the ranked candidate table takes the union of the
 * ranked names and the overnight movers.
 *
 * EVERY NUMBER BELOW IS A RECORDED ONE.
 *
 * - The ranked rows are the real `coverageCandidates.stocks` of the
 *   2026-09-06 weekly run, week 2026-08-31..2026-09-04, read out of
 *   `docs/evidence/flash-samples/2026-09-06-weekly-v2/steps.json` — fractions,
 *   full precision.
 * - The mover rows are the real `opencli tradingview screener` probe of
 *   2026-09-09T13:25Z that `tests/premarket-movers.spec.ts` also freezes —
 *   TradingView percents, full precision, with the venue that answered.
 *
 * The two datasets do not share a symbol, and no frozen recording yet pairs a
 * week return with an overnight move for the SAME name (the 09-04 premarket
 * sample carries no `ow_stock_week` call at all). So the "a name in both keeps
 * the ranked row" branch is exercised by merging twice rather than by inventing
 * a week return for META — see `docs/evidence/flash-loop4/README.md`.
 */
import { describe, expect, it } from "vitest";

import {
  mergeMoverCandidates,
  type CandidateRow,
  type CoverageCandidates,
} from "../quality/coverage-candidates.js";
import type { PremarketMoversSummary } from "../quality/frame.js";

/** The 2026-09-06 weekly run's own ranked table, verbatim. */
const RANKED: CandidateRow[] = [
  {
    id: "stock:SNDK",
    rank: 1,
    symbol: "SNDK",
    window_return: 0.17173295263235877,
    excess_vs_spy: 0.17064112186612745,
    excess_vs_qqq: 0.16820155389137903,
    rankedOn: "excess_vs_spy",
  },
  {
    id: "stock:FIG",
    rank: 2,
    symbol: "FIG",
    window_return: -0.16308119361554474,
    excess_vs_spy: -0.16417302438177606,
    excess_vs_qqq: -0.16661259235652448,
    rankedOn: "excess_vs_spy",
  },
  {
    id: "stock:DELL",
    rank: 3,
    symbol: "DELL",
    window_return: 0.14882517972996667,
    excess_vs_spy: 0.14773334896373536,
    excess_vs_qqq: 0.14529378098898693,
    rankedOn: "excess_vs_spy",
  },
  {
    id: "stock:CDNS",
    rank: 4,
    symbol: "CDNS",
    window_return: -0.14010399835482823,
    excess_vs_spy: -0.14119582912105955,
    excess_vs_qqq: -0.14363539709580797,
    rankedOn: "excess_vs_spy",
  },
  {
    id: "stock:SNPS",
    rank: 5,
    symbol: "SNPS",
    window_return: -0.11018729807279559,
    excess_vs_spy: -0.11127912883902691,
    excess_vs_qqq: -0.11371869681377533,
    rankedOn: "excess_vs_spy",
  },
];

function candidates(stocks: CandidateRow[] = RANKED): CoverageCandidates {
  return {
    window: { start: "2026-08-31", end: "2026-09-04" },
    source: "apex",
    stocks: stocks.map((row) => ({ ...row })),
    events: [],
    missing: [],
    notes: ["ranked 5 of 41 priced symbols"],
  };
}

/** `ow_premarket_movers`, 2026-09-09T13:25Z. Sorted by |ret| as the tool
 *  emits it: META 5.79, ORCL 0.52, NVDA −0.47. */
const MOVERS: PremarketMoversSummary = {
  asOf: "2026-09-09T13:25:00.000Z",
  session: "premarket",
  rows: [
    {
      symbol: "META",
      tvSymbol: "NASDAQ:META",
      ret: 5.794467627306518,
      source: "tradingview.premarket_change",
    },
    {
      symbol: "ORCL",
      tvSymbol: "NYSE:ORCL",
      ret: 0.521,
      source: "tradingview.premarket_change",
    },
    {
      symbol: "NVDA",
      tvSymbol: "NASDAQ:NVDA",
      ret: -0.474,
      source: "tradingview.premarket_change",
    },
  ],
  missing: [],
};

describe("mergeMoverCandidates", () => {
  it("alternates ranked and mover rows and stops at the daily cap of 5", () => {
    const merged = mergeMoverCandidates({
      candidates: candidates(),
      movers: MOVERS,
      limit: 5,
    });
    // THE POINT OF THE WHOLE CHANGE: META is in the table on 2026-09-09.
    // Under a magnitude merge in common units it would be 6th behind five
    // weekly excesses of 11 %–17 % and the Muse launch would be missed again.
    expect(merged.stocks.map((row) => row.symbol)).toEqual([
      "SNDK",
      "META",
      "FIG",
      "ORCL",
      "DELL",
    ]);
    expect(merged.stocks.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives a mover row a ledger id and names the block that backs it", () => {
    const meta = mergeMoverCandidates({
      candidates: candidates(),
      movers: MOVERS,
      limit: 5,
    }).stocks.find((row) => row.symbol === "META");
    expect(meta).toEqual({
      id: "stock:META",
      rank: 2,
      symbol: "META",
      window_return: null,
      excess_vs_spy: null,
      excess_vs_qqq: null,
      rankedOn: "overnight_ret",
      // COPIED, not rounded and not converted: TradingView's own double.
      overnight_ret: 5.794467627306518,
      tvSymbol: "NASDAQ:META",
    });
  });

  it("orders movers by |ret|, so a fall competes with a rise", () => {
    const merged = mergeMoverCandidates({
      candidates: candidates(),
      movers: MOVERS,
      limit: 8,
    });
    expect(
      merged.stocks
        .filter((row) => row.rankedOn === "overnight_ret")
        .map((row) => row.symbol),
    ).toEqual(["META", "ORCL", "NVDA"]);
  });

  it("orders the movers itself, whatever order the payload arrived in", () => {
    // A deterministic order cannot be inherited from the caller: two runs of
    // the same day must put the same names in the same slots. Same recorded
    // rows, reversed — no second market claim is made to prove it.
    const merged = mergeMoverCandidates({
      candidates: candidates([]),
      movers: { ...MOVERS, rows: [...MOVERS.rows].reverse() },
      limit: 5,
    });
    expect(merged.stocks.map((row) => row.symbol)).toEqual([
      "META",
      "ORCL",
      "NVDA",
    ]);
  });

  it("keeps the ranked row and adds the overnight number when a name is in both", () => {
    const once = mergeMoverCandidates({
      candidates: candidates(),
      movers: MOVERS,
      limit: 5,
    });
    const twice = mergeMoverCandidates({
      candidates: once,
      movers: MOVERS,
      limit: 5,
    });
    // META and ORCL are now IN the table AND in the movers payload. Neither
    // may appear twice, and neither may lose the row it already had. (The
    // table is not the same as `once`: NVDA, the mover that lost its slot the
    // first time, takes the one META and ORCL no longer need. A merge is a
    // per-run step, not an idempotent one.)
    expect(twice.stocks.map((row) => row.symbol)).toEqual([
      "SNDK",
      "NVDA",
      "META",
      "FIG",
      "ORCL",
    ]);
    for (const symbol of ["META", "ORCL"])
      expect(twice.stocks.filter((row) => row.symbol === symbol)).toHaveLength(
        1,
      );
    expect(
      twice.stocks.find((row) => row.symbol === "META"),
    ).toMatchObject({
      id: "stock:META",
      overnight_ret: 5.794467627306518,
      tvSymbol: "NASDAQ:META",
      rankedOn: "overnight_ret",
    });
    // The priced rows keep every number they arrived with.
    expect(twice.stocks.find((row) => row.symbol === "SNDK")).toMatchObject({
      window_return: 0.17173295263235877,
      excess_vs_spy: 0.17064112186612745,
      rankedOn: "excess_vs_spy",
    });
  });

  it("says in a note which names entered on a move alone", () => {
    const merged = mergeMoverCandidates({
      candidates: candidates(),
      movers: MOVERS,
      limit: 5,
    });
    expect(merged.notes.join("\n")).toContain(
      "premarketMovers admitted META, ORCL on overnight move alone",
    );
    expect(merged.notes.join("\n")).toContain(
      "2 ranked name(s) left the table to make room for movers",
    );
    // The ranking note it arrived with is never dropped.
    expect(merged.notes[0]).toBe("ranked 5 of 41 priced symbols");
  });

  it("returns the SAME object when there is nothing to merge", () => {
    const base = candidates();
    // Absent (close, weekly, or the tool did not answer), empty, and a
    // refusal payload all have to leave the table exactly as it was: the
    // frame's own note is what records the reason, and a second note would
    // change a frozen replay's output.
    expect(mergeMoverCandidates({ candidates: base, movers: undefined, limit: 5 })).toBe(base);
    expect(
      mergeMoverCandidates({
        candidates: base,
        movers: { ...MOVERS, rows: [] },
        limit: 5,
      }),
    ).toBe(base);
    expect(
      mergeMoverCandidates({
        candidates: base,
        movers: { unavailable: "as-of" } as unknown as PremarketMoversSummary,
        limit: 5,
      }),
    ).toBe(base);
  });

  it("ignores a mover row with no usable number", () => {
    const merged = mergeMoverCandidates({
      candidates: candidates([]),
      movers: {
        ...MOVERS,
        // A nameless row and a named row with no number — the two shapes a
        // screener answer degrades into. Neither carries a market claim.
        rows: [
          { ...MOVERS.rows[0]! },
          { symbol: "", tvSymbol: "", source: "tradingview" },
          { symbol: "NVDA", tvSymbol: "NASDAQ:NVDA", ret: null },
        ] as unknown as PremarketMoversSummary["rows"],
      },
      limit: 5,
    });
    expect(merged.stocks.map((row) => row.symbol)).toEqual(["META"]);
  });

  it("leaves a weekly-sized table alone — the weekly carries no movers block", () => {
    const base = candidates();
    expect(
      mergeMoverCandidates({ candidates: base, movers: undefined, limit: 8 }),
    ).toBe(base);
  });
});
