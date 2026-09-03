/**
 * ow_uw_earnings quotes Unusual Whales' company-info row back. The fixtures
 * are the real 2026-09-03 responses to GET /api/stock/{ticker}/info, captured
 * live and trimmed to the fields the tool reads — SNOW because it carries a
 * real `announce_time`, SMH because an ETF answers with a null date and must
 * come back as a row saying so rather than as a missing entry or an invented
 * date.
 */
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

/** Real responses, as-of 2026-09-03. */
const INFO = {
  SNOW: {
    symbol: "SNOW",
    issue_type: "Common Stock",
    next_earnings_date: "2026-09-02",
    announce_time: "postmarket",
  },
  NVDA: {
    symbol: "NVDA",
    issue_type: "Common Stock",
    next_earnings_date: "2026-11-18",
    announce_time: "unknown",
  },
  SMH: {
    symbol: "SMH",
    issue_type: "ETF",
    next_earnings_date: null,
    announce_time: null,
  },
} as const;

function earningsTool(
  env: Record<string, string | undefined> = { OW_UW_API_KEY: "k" },
) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find(
    (t) => t.name === "ow_uw_earnings",
  );
  if (found === undefined) throw new Error("no tool ow_uw_earnings");
  return found;
}

const fetchImpl = async (url: URL) => {
  const ticker = url.pathname.split("/")[3] as keyof typeof INFO;
  return new Response(JSON.stringify({ data: INFO[ticker] }), { status: 200 });
};

describe("ow_uw_earnings", () => {
  it("returns the next earnings date, and the report time only when UW knows it", async () => {
    const out = JSON.parse(
      await earningsTool().run({ tickers: ["SNOW", "NVDA"] }, {
        fetchImpl,
      } as never),
    ) as { asOf: string; rows: unknown[]; missing: unknown[] };
    expect(out.rows).toEqual([
      {
        ticker: "SNOW",
        nextEarningsDate: "2026-09-02",
        daysToEarnings: expect.any(Number),
        reportTime: "postmarket",
      },
      // "unknown" is UW's own word for "no time of day"; it is not a report time.
      {
        ticker: "NVDA",
        nextEarningsDate: "2026-11-18",
        daysToEarnings: expect.any(Number),
      },
    ]);
    expect(out.missing).toEqual([]);
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // Subtracted by the tool, not by a model: an off-by-one on an earnings
    // date is a position held through a print.
    const now = new Date();
    const days = Math.round(
      (Date.UTC(2026, 10, 18) -
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
        86_400_000,
    );
    expect((out.rows[1] as { daysToEarnings: number }).daysToEarnings).toBe(days);
  });

  it("answers an ETF with a null date, not a missing entry and not an invented date", async () => {
    // An ETF should never be asked about in the first place; if one slips
    // through it is an answer ("no earnings"), so it must not land in
    // `missing`, which the caller reads as "nobody told me".
    const out = JSON.parse(
      await earningsTool().run({ tickers: ["SMH", "NVDA"] }, {
        fetchImpl,
      } as never),
    ) as { rows: unknown[]; missing: unknown[] };
    expect(out.rows).toEqual([
      { ticker: "SMH", issueType: "ETF", nextEarningsDate: null },
      {
        ticker: "NVDA",
        nextEarningsDate: "2026-11-18",
        daysToEarnings: expect.any(Number),
      },
    ]);
    expect(out.missing).toEqual([]);
  });

  it("throws when no ticker answered at all", async () => {
    await expect(
      earningsTool().run({ tickers: ["NVDA"] }, {
        fetchImpl: async () =>
          new Response("", { status: 500, statusText: "Server Error" }),
      } as never),
    ).rejects.toThrow(/no ticker answered — NVDA: .*500/su);
  });
});
