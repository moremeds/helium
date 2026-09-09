/**
 * The coverage-selection pre-pass (#107 item 2).
 *
 * Every number below is a REAL adjusted close read from apex on the mini on
 * 2026-09-08 (`GET /v1/equity/{sym}/bars?timeframe=1d&price_mode=adjusted`,
 * adjustment_revision 40) for the 2026-08-31..2026-09-04 week, and the window
 * returns are apex's own published check values for that week: SOXX +0.0221,
 * SPY +0.0011, QQQ +0.0035, MU +0.0898, SNDK +0.1717.
 */
import { describe, expect, it } from "vitest";

import {
  COVERAGE_CANDIDATE_LIMIT,
  rankCoverageCandidates,
  reportedWeek,
  type StockWeekPayload,
} from "../quality/coverage-candidates.js";

/** apex's 2026-08-31..2026-09-04 week, SPY +0.0011 as the benchmark. */
const W37: StockWeekPayload = {
  start: "2026-08-31",
  end: "2026-09-04",
  source: "apex-bars-fallback",
  benchmarks: {
    SPY: { window_return: 0.0011 },
    QQQ: { window_return: 0.0035 },
  },
  results: [
    // 1484.98 -> 1740.00
    {
      symbol: "SNDK",
      window_return: 0.1717,
      excess_vs_spy: 0.1706,
      excess_vs_qqq: 0.1682,
    },
    // 932.86 -> 1016.59
    {
      symbol: "MU",
      window_return: 0.0898,
      excess_vs_spy: 0.0887,
      excess_vs_qqq: 0.0863,
    },
    // 508.62 -> 519.86
    {
      symbol: "SOXX",
      window_return: 0.0221,
      excess_vs_spy: 0.021,
      excess_vs_qqq: 0.0186,
    },
    {
      symbol: "SPY",
      window_return: 0.0011,
      excess_vs_spy: 0,
      excess_vs_qqq: -0.0024,
    },
    {
      symbol: "QQQ",
      window_return: 0.0035,
      excess_vs_spy: 0.0024,
      excess_vs_qqq: 0,
    },
  ],
  missing: [],
};

describe("rankCoverageCandidates", () => {
  it("ranks by the size of the excess over SPY, in both directions", () => {
    const ranked = rankCoverageCandidates({ payload: W37, events: [] });
    expect(ranked.stocks.map((row) => row.symbol)).toEqual([
      "SNDK",
      "MU",
      "SOXX",
      "QQQ",
      "SPY",
    ]);
    expect(ranked.stocks[0]).toMatchObject({
      rank: 1,
      symbol: "SNDK",
      window_return: 0.1717,
      excess_vs_spy: 0.1706,
      rankedOn: "excess_vs_spy",
    });
  });

  it("ranks a name that fell as hard as one that rose", () => {
    // MU's real +0.0898 mirrored: the sign must not decide the order.
    const ranked = rankCoverageCandidates({
      payload: {
        ...W37,
        results: [
          {
            symbol: "SOXX",
            window_return: 0.0221,
            excess_vs_spy: 0.021,
            excess_vs_qqq: 0.0186,
          },
          {
            symbol: "MU",
            window_return: -0.0876,
            excess_vs_spy: -0.0887,
            excess_vs_qqq: -0.0911,
          },
        ],
      },
      events: [],
    });
    expect(ranked.stocks.map((row) => row.symbol)).toEqual(["MU", "SOXX"]);
  });

  it("keeps a missing symbol missing and never prices it at zero", () => {
    const ranked = rankCoverageCandidates({
      payload: {
        ...W37,
        missing: [
          {
            symbol: "SMH",
            reason: "no close before 2026-08-31 to measure the week from",
          },
        ],
      },
      events: [],
    });
    expect(ranked.missing).toEqual([
      {
        symbol: "SMH",
        reason: "no close before 2026-08-31 to measure the week from",
      },
    ]);
    expect(ranked.stocks.some((row) => row.symbol === "SMH")).toBe(false);
    expect(ranked.notes.join(" ")).toContain("SMH");
  });

  it("falls back to the window return when the benchmark is null, and leaves a valueless row unranked", () => {
    const ranked = rankCoverageCandidates({
      payload: {
        ...W37,
        benchmarks: { SPY: { window_return: null } },
        results: [
          {
            symbol: "SOXX",
            window_return: 0.0221,
            excess_vs_spy: null,
            excess_vs_qqq: null,
          },
          {
            symbol: "SNDK",
            window_return: null,
            excess_vs_spy: null,
            excess_vs_qqq: null,
          },
        ],
      },
      events: [],
    });
    expect(ranked.stocks).toHaveLength(1);
    expect(ranked.stocks[0]).toMatchObject({
      symbol: "SOXX",
      window_return: 0.0221,
      excess_vs_spy: null,
      rankedOn: "window_return",
    });
    expect(ranked.notes.join(" ")).toContain("SNDK");
    expect(ranked.notes.join(" ")).toContain("not zeroed");
  });

  it("carries at most the fixed limit and says how many it dropped", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      symbol: `T${String(index)}`,
      window_return: 0.0221,
      excess_vs_spy: 0.021 - index / 10_000,
      excess_vs_qqq: null,
    }));
    const ranked = rankCoverageCandidates({
      payload: { ...W37, results: many },
      events: [],
    });
    expect(ranked.stocks).toHaveLength(COVERAGE_CANDIDATE_LIMIT);
    expect(ranked.notes.join(" ")).toContain(
      `ranked ${String(COVERAGE_CANDIDATE_LIMIT)} of 12`,
    );
  });

  it("breaks a tie on the symbol so the order cannot move between runs", () => {
    const tied = rankCoverageCandidates({
      payload: {
        ...W37,
        results: [
          {
            symbol: "SOXX",
            window_return: 0.0221,
            excess_vs_spy: 0.021,
            excess_vs_qqq: null,
          },
          {
            symbol: "IGV",
            window_return: 0.0221,
            excess_vs_spy: 0.021,
            excess_vs_qqq: null,
          },
        ],
      },
      events: [],
    });
    expect(tied.stocks.map((row) => row.symbol)).toEqual(["IGV", "SOXX"]);
  });

  it("reports an empty payload as empty rather than as a flat week", () => {
    const ranked = rankCoverageCandidates({ payload: {}, events: [] });
    expect(ranked.stocks).toEqual([]);
    expect(ranked.notes).toContain("ow_stock_week returned no rows");
  });

  it("passes the week's dated events through untouched", () => {
    const events = [
      { time: "2026-09-10", type: "macro", event: "CPI (Aug)", prev: "2.9%" },
    ];
    const ranked = rankCoverageCandidates({ payload: W37, events });
    expect(ranked.events).toEqual(events);
  });
});

describe("reportedWeek", () => {
  it("gives the Monday-to-Friday of the week that closed", () => {
    // The 2026-09-06 weekly reports on 2026-08-31..2026-09-04.
    expect(reportedWeek("2026-09-06")).toEqual({
      start: "2026-08-31",
      end: "2026-09-04",
    });
    expect(reportedWeek("2026-09-05")).toEqual({
      start: "2026-08-31",
      end: "2026-09-04",
    });
    // A weekly that slips to Monday still reports the week that closed.
    expect(reportedWeek("2026-09-07")).toEqual({
      start: "2026-08-31",
      end: "2026-09-04",
    });
  });

  it("returns empty strings for a day it cannot parse", () => {
    expect(reportedWeek("last week")).toEqual({ start: "", end: "" });
  });
});
