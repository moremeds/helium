/**
 * The macro tools, each against the REAL response captured live on
 * 2026-09-03 and frozen here. Nothing in this file reaches the network: the
 * HTTP tools get a `fetchImpl`, and the two subprocess tools (psql, opencli)
 * get a tiny shell script on disk that prints the captured payload.
 *
 * Captures: uw-economic-calendar.json, uw-nvda-iv-term-structure.json,
 * uw-news-headlines.json, x-NickTimiraos.json, plus one live
 * `SELECT * FROM uw_scan.rates_policy_path` and the TradingView quotes for
 * TVC:GOLD / NYMEX:CL1!.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTools } from "../tools/index.js";

function tool(name: string, env: Record<string, string | undefined>) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

/** A stand-in binary that prints `payload` and exits 0. */
function fakeBin(payload: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ow-macro-"));
  const path = join(dir, "fake");
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`);
  chmodSync(path, 0o755);
  return path;
}

const UW = { OW_UW_API_KEY: "k" };
const json = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200 });

describe("ow_uw_calendar", () => {
  // Real rows from GET /api/market/economic-calendar, 2026-09-03. The window
  // in the capture runs 2026-09-01 to 2026-09-04, so the clock is frozen at
  // 2026-09-03 to make "the next 7 days" mean what it meant that morning.
  const DATA = [
    {
      type: "report",
      time: "2026-09-04T12:30:00Z",
      prev: "4.1%",
      event: "Unemployment Rate",
      forecast: "4.1%",
      reported_period: "August",
    },
    {
      type: "report",
      time: "2026-09-03T19:00:00Z",
      prev: null,
      event:
        "Federal Reserve Bank of Cleveland President Beth Hammack and Federal Reserve Bank of Chicago President Austan Goolsbee special remarks at 'Connecting Communities' online event",
      forecast: null,
      reported_period: null,
    },
    {
      type: "report",
      time: "2026-09-01T14:00:00Z",
      prev: "48.7",
      event: "ISM Manufacturing PMI",
      forecast: "49",
      reported_period: "August",
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the next 7 days in time order, dropping what already happened", async () => {
    const out = JSON.parse(
      await tool("ow_uw_calendar", UW).run({}, { fetchImpl: json({ data: DATA }) } as never),
    ) as { asOf: string; rows: Array<Record<string, unknown>> };
    // The 09-01 ISM print is behind us; a past release is not a scheduled event.
    expect(out.rows.map((r) => r.time)).toEqual([
      "2026-09-03T19:00:00Z",
      "2026-09-04T12:30:00Z",
    ]);
    expect(out.rows[1]).toEqual({
      time: "2026-09-04T12:30:00Z",
      type: "report",
      event: "Unemployment Rate",
      forecast: "4.1%",
      prev: "4.1%",
    });
    // A speech has no forecast and no previous print; those are null, never dropped.
    expect(out.rows[0]?.forecast).toBeNull();
    expect(out.asOf).toBe("2026-09-03T08:00:00.000Z");
  });
});

describe("ow_uw_iv_term", () => {
  // Real NVDA rows, 2026-09-02 snapshot. Every number arrives as a string.
  const DATA = [
    {
      date: "2026-09-02",
      ticker: "NVDA",
      volatility: "5.31814694819328",
      expiry: "2026-09-02",
      implied_move: "0.837335367373918",
      dte: 0,
      implied_move_perc: "0.003731775294373148",
    },
    {
      date: "2026-09-02",
      ticker: "NVDA",
      volatility: "0.3628218596291205",
      expiry: "2026-09-04",
      implied_move: "4.126980897592819",
      dte: 2,
      implied_move_perc: "0.01839527924044047",
    },
  ];

  it("drops the 0 DTE row and returns numbers, not strings", async () => {
    const out = JSON.parse(
      await tool("ow_uw_iv_term", UW).run({ tickers: ["NVDA"] }, {
        fetchImpl: json({ data: DATA }),
      } as never),
    ) as { rows: Array<Record<string, unknown>> };
    // 5.31 is 531% vol — the arithmetic of an expiring contract, not a level.
    expect(out.rows).toEqual([
      {
        ticker: "NVDA",
        date: "2026-09-02",
        expiry: "2026-09-04",
        dte: 2,
        volatility: 0.3628218596291205,
        implied_move_perc: 0.01839527924044047,
      },
    ]);
  });

  it("refuses more than three tickers instead of firing four round trips", async () => {
    await expect(
      tool("ow_uw_iv_term", UW).run({ tickers: ["NVDA", "AMD", "AVGO", "MU"] }, {
        fetchImpl: json({ data: [] }),
      } as never),
    ).rejects.toThrow(/1 to 3 symbols/u);
  });
});

describe("ow_uw_headlines", () => {
  // Real rows from GET /api/news/headlines, 2026-09-03. Note there is no url
  // field anywhere in the capture — the assertion below is what keeps one
  // from being invented later.
  const DATA = [
    {
      meta: {},
      source: "Tradex",
      created_at: "2026-09-03T07:46:12Z",
      tags: [],
      tickers: [],
      headline: "ITALIAN COMPOSITE PMI ACTUAL 53.6 (FORECAST 53.1, PREVIOUS 52.5) $MACRO",
      is_major: true,
      sentiment: "neutral",
    },
  ];

  it("returns the citable fields only, with no url", async () => {
    let seen: URL | undefined;
    const out = JSON.parse(
      await tool("ow_uw_headlines", UW).run(
        { limit: 25, ticker: "spy" },
        {
          fetchImpl: async (url: URL) => {
            seen = url;
            return new Response(JSON.stringify({ data: DATA }), { status: 200 });
          },
        } as never,
      ),
    ) as { rows: Array<Record<string, unknown>> };
    expect(out.rows).toEqual([
      {
        created_at: "2026-09-03T07:46:12Z",
        headline: "ITALIAN COMPOSITE PMI ACTUAL 53.6 (FORECAST 53.1, PREVIOUS 52.5) $MACRO",
        tickers: [],
        sentiment: "neutral",
      },
    ]);
    expect(out.rows[0]).not.toHaveProperty("url");
    // 25 rows is the hard cap: the kept fields come to ~7.4 KB, under core's
    // summariser cut. major_only defaults on.
    expect(seen?.searchParams.get("limit")).toBe("25");
    expect(seen?.searchParams.get("major_only")).toBe("true");
    expect(seen?.searchParams.get("ticker")).toBe("SPY");
  });

  it("refuses a limit past the 25 that fit under the summariser cut", async () => {
    await expect(
      tool("ow_uw_headlines", UW).run({ limit: 40 }, { fetchImpl: json({ data: DATA }) } as never),
    ).rejects.toThrow(/25/u);
  });
});

describe("ow_argon_policy_path", () => {
  // One real row of uw_scan.rates_policy_path, snapshot 2026-09-02.
  const ROW = {
    snapshot_date: "2026-09-02",
    meeting_date: "2026-09-16",
    payload: {
      label: "9/16",
      source: "Frenzy Capital Fed Watch",
      stance: "HIKE",
      status: "ok",
      probability: 60.0,
      implied_rate: "3.78",
      meeting_date: "2026-09-16",
      target_range: "3.75-4.00%",
      probabilities: {
        Hold: "0.4",
        "Cut 25 bp": "0.0",
        "Cut 50 bp": "0.0",
        "Hike 25 bp": "0.6",
        "Hike 50 bp": "0.0",
      },
    },
  };

  it("names the futures source and the snapshot date alongside the meetings", async () => {
    const env = {
      OW_ARGON_PG_URL: "postgres://frozen/fixture",
      OW_PSQL_BIN: fakeBin(JSON.stringify([ROW])),
    };
    const out = JSON.parse(await tool("ow_argon_policy_path", env).run({})) as {
      source: string;
      snapshotDate: string;
      meetings: Array<typeof ROW>;
    };
    expect(out.source).toBe("frenzy_capital fed-funds futures via argon");
    expect(out.snapshotDate).toBe("2026-09-02");
    expect(out.meetings[0]?.payload.probabilities["Hike 25 bp"]).toBe("0.6");
    expect(out.meetings[0]?.payload.target_range).toBe("3.75-4.00%");
  });

  it("throws rather than returning an empty path", async () => {
    const env = {
      OW_ARGON_PG_URL: "postgres://frozen/fixture",
      OW_PSQL_BIN: fakeBin("[]"),
    };
    await expect(tool("ow_argon_policy_path", env).run({})).rejects.toThrow(/no fed-funds path/u);
  });
});

describe("ow_x_posts", () => {
  // One real post from `opencli twitter tweets NickTimiraos -f json`,
  // 2026-09-03. likes/retweets/views are in the capture and must not survive.
  const POST = {
    id: "2095151472157569206",
    author: "NickTimiraos",
    name: "Nick Timiraos",
    text: 'New York Fed President John Williams maintained his view that "the trend in inflation" is "moving slowly down".',
    likes: 286,
    retweets: 51,
    replies: 30,
    views: 65677,
    is_retweet: false,
    created_at: "Wed Sep 02 14:06:51 +0000 2026",
    url: "https://x.com/NickTimiraos/status/2095151472157569206",
    has_media: false,
  };

  it("returns author, time, link and text — and no engagement counts", async () => {
    const env = { OW_TV_ENABLED: "1", OPENCLI_BIN: fakeBin(JSON.stringify([POST])) };
    const out = JSON.parse(await tool("ow_x_posts", env).run({ handle: "NickTimiraos" })) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(out.rows).toEqual([
      {
        author: "NickTimiraos",
        created_at: "Wed Sep 02 14:06:51 +0000 2026",
        url: "https://x.com/NickTimiraos/status/2095151472157569206",
        text: POST.text,
      },
    ]);
  });

  it("refuses a handle that is not on the allow-list", async () => {
    // @gregip resolved to an unrelated Polish account on 2026-09-03; a
    // near-miss handle answers confidently with the wrong person.
    const env = { OW_TV_ENABLED: "1", OPENCLI_BIN: fakeBin("[]") };
    await expect(tool("ow_x_posts", env).run({ handle: "gregip" })).rejects.toThrow(
      /handle must be one of .*NickTimiraos/su,
    );
  });
});

describe("ow_tv_commodities", () => {
  it("returns the close and the percent change per symbol", async () => {
    // Real TVC:GOLD quote shape, 2026-09-03. The fake bin answers every
    // symbol with it, so the assertion is on the shape and the symbol list.
    const quote = JSON.stringify([
      {
        symbol: "TVC:GOLD",
        description: "GOLD (US$/OZ)",
        close: 4436.88,
        change: 1.108301838206395,
        change_abs: 48.63500000000022,
        currency: "USD",
        time: "2026-09-03T08:30:26Z",
      },
    ]);
    const env = { OW_TV_ENABLED: "1", OPENCLI_BIN: fakeBin(quote) };
    const out = JSON.parse(await tool("ow_tv_commodities", env).run({})) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(out.rows.map((r) => r.symbol)).toEqual([
      "TVC:GOLD",
      "TVC:SILVER",
      "NYMEX:CL1!",
      "NYMEX:BZ1!",
      "COMEX:HG1!",
      "NYMEX:NG1!",
    ]);
    expect(out.rows[0]).toEqual({
      label: "gold",
      symbol: "TVC:GOLD",
      close: 4436.88,
      change_pct: 1.108301838206395,
    });
  });

  it("says so when the machine has no browser bridge", async () => {
    await expect(tool("ow_tv_commodities", {}).run({})).rejects.toThrow(/OW_TV_ENABLED/u);
  });
});
