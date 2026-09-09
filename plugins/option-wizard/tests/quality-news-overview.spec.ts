/**
 * The news overview assembly (#113). No subprocess here: `buildNewsOverview`
 * takes its reader as an argument precisely so the ordering, the caps, the
 * venue fallback and the missing guard can be tested against frozen real rows.
 *
 * Every fixture is a real row captured from the mini on 2026-09-09.
 */
import { describe, expect, it } from "vitest";
import { SUMMARISE_OVER_BYTES } from "@helium/core";
import {
  NEWS_CAPS,
  buildNewsOverview,
  newsCapsFor,
} from "../quality/news-overview.js";

const MARKETS_TODAY = [
  {
    id: "tag:reuters.com,2026:newsml_L4N45100S:0",
    published: "2026-09-09T00:54:23.000Z",
    provider: "Reuters",
    title: "Gold subdued on inflation worries, rate hike expectations",
    urgency: 2,
    related_symbols: "TVC:GOLD,OANDA:XAUUSD",
    link: "https://www.tradingview.com/news/reuters.com,2026:newsml_L4N45100S:0-gold-subdued-on-inflation-worries-rate-hike-expectations/",
  },
  {
    id: "tag:reuters.com,2026:newsml_L6N45100J:0",
    published: "2026-09-09T00:18:25.000Z",
    provider: "Reuters",
    title:
      "Oil jumps $1 in early trade after Iran launches missiles at Jordan ",
    urgency: 2,
    related_symbols: "ICEEUR:BRN1!,NYMEX:CL1!",
    link: "https://www.tradingview.com/news/reuters.com,2026:newsml_L6N45100J:0-oil-jumps-1-in-early-trade-after-iran-launches-missiles-at-jordan/",
  },
];

const ECONOMIC = [
  {
    id: "DJN_DN20260908009792:0",
    published: "2026-09-09T01:00:00.000Z",
    provider: "Dow Jones Newswires",
    title:
      "Economic Data Doesn't Capture Our Sour Feelings About the Economy — WSJ",
    urgency: 2,
    related_symbols: "",
    link: "https://www.tradingview.com/news/DJN_DN20260908009792:0/",
  },
];

const NVDA = [
  {
    id: "gurufocus:d29c92119094b:0",
    published: "2026-09-08T21:25:13.000Z",
    provider: "GuruFocus",
    title: "Nvidia Falls as Its Firmus Bet Lands OpenAI",
    urgency: 2,
    related_symbols: "NASDAQ:NVDA",
    link: "https://www.gurufocus.com/news/9070840/nvidia-falls-as-its-firmus-bet-lands-openai",
  },
];

const SPY = [
  {
    id: "benzinga:6eb5598e0094b:0",
    published: "2026-09-08T22:17:21.000Z",
    provider: "Benzinga",
    title:
      "Trump Approval Rating Falls Lower, Stock Market Gains Can’t Offset Voter Opinion About Iran War",
    urgency: 2,
    related_symbols: "AMEX:SPY",
    link: "https://www.benzinga.com/news/politics/26/09/61675336/trump-approval-rating-falls-lower-stock-market-gains-cant-offset-voter-opinion-about-iran-war",
  },
];

/** The reader the tool would be: NVDA lists on NASDAQ, SPY on AMEX, and
 *  anything else answers `[]` the way a wrong venue does. */
function reader(state: { peak: number; live: number; asked: string[] }) {
  return async (args: {
    symbol?: string;
    section?: string;
    category?: string;
    limit: number;
  }): Promise<unknown> => {
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    state.asked.push(args.symbol ?? args.section ?? args.category ?? "?");
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.live -= 1;
    if (args.section === "markets_today") return { rows: MARKETS_TODAY };
    if (args.category === "economic") return { rows: ECONOMIC };
    if (args.symbol === "NASDAQ:NVDA") return { rows: NVDA };
    if (args.symbol === "AMEX:SPY") return { rows: SPY };
    return { rows: [] };
  };
}

const fresh = () => ({ peak: 0, live: 0, asked: [] as string[] });

describe("buildNewsOverview", () => {
  it("assembles both feeds and the per-stock headlines, one read at a time", async () => {
    const state = fresh();
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA", "SPY"],
      read: reader(state),
      caps: NEWS_CAPS.weekly,
    });
    expect(overview.marketsToday.map((row) => row.title)).toEqual(
      MARKETS_TODAY.map((row) => row.title),
    );
    expect(overview.economic[0]?.link).toBe(ECONOMIC[0]!.link);
    expect(overview.stocks).toEqual([
      {
        symbol: "NVDA",
        tvSymbol: "NASDAQ:NVDA",
        headlines: [
          {
            id: NVDA[0]!.id,
            published: NVDA[0]!.published,
            provider: NVDA[0]!.provider,
            title: NVDA[0]!.title,
            link: NVDA[0]!.link,
          },
        ],
      },
      {
        symbol: "SPY",
        tvSymbol: "AMEX:SPY",
        headlines: [
          {
            id: SPY[0]!.id,
            published: SPY[0]!.published,
            provider: SPY[0]!.provider,
            title: SPY[0]!.title,
            link: SPY[0]!.link,
          },
        ],
      },
    ]);
    expect(overview.missing).toEqual([]);
    // The whole point of doing this in a loop rather than a Promise.all:
    // concurrent opencli web reads fail on the mini.
    expect(state.peak).toBe(1);
    // SPY was tried on NASDAQ first and fell through to AMEX.
    expect(state.asked).toEqual([
      "markets_today",
      "economic",
      "NASDAQ:NVDA",
      "NASDAQ:SPY",
      "AMEX:SPY",
    ]);
  });

  it("names every symbol that produced nothing instead of dropping it", async () => {
    const state = fresh();
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA", "ZZZZ"],
      read: reader(state),
      caps: NEWS_CAPS.weekly,
    });
    expect(overview.stocks.map((row) => row.symbol)).toEqual(["NVDA"]);
    expect(overview.missing).toHaveLength(1);
    expect(overview.missing[0]!.symbol).toBe("ZZZZ");
    expect(overview.missing[0]!.reason).toContain("NASDAQ, AMEX, NYSE:ZZZZ");
    // Three venues tried, then given up on — not a fourth guess.
    expect(state.asked.filter((ask) => ask.endsWith(":ZZZZ"))).toEqual([
      "NASDAQ:ZZZZ",
      "AMEX:ZZZZ",
      "NYSE:ZZZZ",
    ]);
  });

  it("stops after both feeds refuse the same way: the route is down, not the news", async () => {
    // A laptop with no TradingView, or an as-of replay. Twelve symbols x three
    // venues would be 36 subprocesses collecting 36 copies of one sentence.
    let reads = 0;
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA", "SPY"],
      caps: NEWS_CAPS.weekly,
      read: async () => {
        reads += 1;
        throw new Error('ow_tv_news: OW_TV_ENABLED is not "1"');
      },
    });
    expect(reads).toBe(2);
    expect(overview.marketsToday).toEqual([]);
    expect(overview.stocks).toEqual([]);
    expect(overview.missing).toEqual([]);
    expect(overview.notes.join(" ")).toContain("the news route is unavailable");
    expect(overview.notes.join(" ")).toContain("OW_TV_ENABLED");
  });

  it("records ONE symbol's failing read as that symbol's reason, not as quiet news", async () => {
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA"],
      caps: NEWS_CAPS.weekly,
      read: async (args) => {
        if (args.symbol === undefined) return { rows: MARKETS_TODAY };
        throw new Error("opencli tradingview news failed — CDP port closed");
      },
    });
    expect(overview.marketsToday).toHaveLength(2);
    expect(overview.missing).toEqual([
      {
        symbol: "NVDA",
        reason: "opencli tradingview news failed — CDP port closed",
      },
    ]);
  });

  it("caps the stock list and says how many it dropped", async () => {
    const state = fresh();
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      // Duplicates and case are normalised before the cap is applied, so the
      // cap counts distinct names.
      symbols: ["NVDA", "nvda", "SPY", "ZZZZ"],
      read: reader(state),
      caps: { ...NEWS_CAPS.weekly, stocks: 2 },
    });
    expect(overview.stocks.map((row) => row.symbol)).toEqual(["NVDA", "SPY"]);
    expect(overview.notes.join(" ")).toContain("asked 2 of 3 symbols");
    expect(state.asked).not.toContain("NASDAQ:ZZZZ");
  });

  it("keeps at most the declared number of rows per feed and per stock", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...NVDA[0]!,
      id: `row:${String(index)}`,
    }));
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA"],
      read: async () => ({ rows: many }),
      caps: NEWS_CAPS.weekly,
    });
    expect(overview.marketsToday).toHaveLength(NEWS_CAPS.weekly.global);
    expect(overview.economic).toHaveLength(NEWS_CAPS.weekly.global);
    expect(overview.stocks[0]!.headlines).toHaveLength(
      NEWS_CAPS.weekly.perStock,
    );
  });

  it("reads a refusal payload as no rows, never as a quiet news day", async () => {
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: ["NVDA"],
      caps: NEWS_CAPS.weekly,
      read: async () => ({
        unavailable: "as-of",
        asOf: "2026-09-02T12:45:00.000Z",
        reason: "the TradingView news route (no dated archive) has no history",
      }),
    });
    expect(overview.marketsToday).toEqual([]);
    // A refusal is not an empty news day. Both feeds refusing the same way is
    // the replay saying it has no news at all, so the twelve symbols are not
    // probed and no `missing` row claims "no story" about a real trading day.
    expect(overview.stocks).toEqual([]);
    expect(overview.missing).toEqual([]);
    expect(overview.notes.join(" ")).toContain("the news route is unavailable");
    expect(overview.notes.join(" ")).toContain("as-of");
  });

  it("a FULL block stays a small fraction of core's summariser ceiling", async () => {
    // The claim in the module header, measured rather than asserted in prose.
    // The frame carries this block beside everything else it already holds, so
    // the caps have to be small on purpose — a summarised frame is a frame
    // whose numbers are no longer verbatim.
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      caps: NEWS_CAPS.weekly,
      symbols: Array.from({ length: NEWS_CAPS.weekly.stocks }, (_, index) =>
        index === 0 ? "NVDA" : `SY${String(index)}`,
      ),
      read: async () => ({
        rows: Array.from({ length: 30 }, (_, index) => ({
          ...MARKETS_TODAY[0]!,
          id: `${MARKETS_TODAY[0]!.id}:${String(index)}`,
        })),
      }),
    });
    expect(overview.stocks).toHaveLength(NEWS_CAPS.weekly.stocks);
    const bytes = Buffer.byteLength(JSON.stringify(overview), "utf8");
    // 17 KB measured, against a 131 KB ceiling — and this is the WORST case:
    // every one of the 52 rows carries the longest real link in the fixtures.
    expect(bytes).toBeLessThan(SUMMARISE_OVER_BYTES / 4);
  });

  it("gives a daily run the same block at a smaller scale", async () => {
    // The daily author already knows the day's cause and wants the headline
    // that dates it; it also pays this cost four times a day. Same shape,
    // fewer rows — and an unnamed phase gets the CHEAPER caps, never the
    // larger ones.
    expect(newsCapsFor("premarket")).toEqual(NEWS_CAPS.daily);
    expect(newsCapsFor("intraday")).toEqual(NEWS_CAPS.daily);
    expect(newsCapsFor("close")).toEqual(NEWS_CAPS.daily);
    expect(newsCapsFor(undefined)).toEqual(NEWS_CAPS.daily);
    expect(newsCapsFor("weekly")).toEqual(NEWS_CAPS.weekly);

    const many = Array.from({ length: 30 }, (_, index) => ({
      ...NVDA[0]!,
      id: `row:${String(index)}`,
    }));
    const asked: number[] = [];
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: Array.from({ length: 20 }, (_, index) => `SY${String(index)}`),
      caps: newsCapsFor("premarket"),
      read: async (args) => {
        asked.push(args.limit);
        return { rows: many };
      },
    });
    expect(overview.marketsToday).toHaveLength(NEWS_CAPS.daily.global);
    expect(overview.economic).toHaveLength(NEWS_CAPS.daily.global);
    expect(overview.stocks).toHaveLength(NEWS_CAPS.daily.stocks);
    for (const stock of overview.stocks)
      expect(stock.headlines).toHaveLength(NEWS_CAPS.daily.perStock);
    expect(overview.notes.join(" ")).toContain("asked 8 of 20 symbols");
    // The cap is pushed DOWN to opencli too, not just applied after the fact:
    // a smaller `--limit` is a smaller fetch.
    expect(asked.slice(0, 2)).toEqual([
      NEWS_CAPS.daily.global,
      NEWS_CAPS.daily.global,
    ]);
    expect(asked.slice(2)).toEqual(
      asked.slice(2).map(() => NEWS_CAPS.daily.perStock),
    );
    // Strictly smaller than weekly on every axis — "daily 就是规模小一些".
    expect(NEWS_CAPS.daily.global).toBeLessThan(NEWS_CAPS.weekly.global);
    expect(NEWS_CAPS.daily.perStock).toBeLessThan(NEWS_CAPS.weekly.perStock);
    expect(NEWS_CAPS.daily.stocks).toBeLessThan(NEWS_CAPS.weekly.stocks);
  });

  it("drops a row with no link: a citation nobody can open is not a citation", async () => {
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T02:00:00.000Z",
      symbols: [],
      caps: NEWS_CAPS.weekly,
      read: async () => ({
        rows: [{ ...MARKETS_TODAY[0], link: "" }, MARKETS_TODAY[1]],
      }),
    });
    expect(overview.marketsToday.map((row) => row.id)).toEqual([
      MARKETS_TODAY[1]!.id,
    ]);
  });
});
