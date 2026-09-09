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
  NEWS_FETCH_LIMIT,
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

/**
 * The 2026-09-09 premarket miss, as rows. Every field below is verbatim from
 * the mini at 13:44Z: the first four are `opencli tradingview news --section
 * markets_today --limit 25`, in that order and at those timestamps, and they
 * are exactly the four rows the 13:07Z run kept when the block was "the four
 * most recent". The fifth is `--symbol NASDAQ:META`'s 11:44:22Z Benzinga row,
 * the story the note should have carried — META was moving on it. The sixth
 * is the fifth row of that day's tape re-filed under a second id and the
 * other provider suffix the same wire story reaches the tape under; a
 * recency slice keeps both and spends two of its four slots on one story.
 */
const PREMARKET_0909 = [
  {
    id: "DJN_DN20260909005187:0",
    published: "2026-09-09T13:00:00.000Z",
    provider: "Dow Jones Newswires",
    title:
      "Saputo's U.S. Manufacturing Footprint Could Buffer Impact of New Tariff Escalation — Market Talk",
    urgency: 2,
    related_symbols: "TSX:SAP",
    link: "https://www.tradingview.com/news/DJN_DN20260909005187:0/",
  },
  {
    id: "tag:reuters.com,2026:newsml_L4N451101:0",
    published: "2026-09-09T12:49:35.000Z",
    provider: "Reuters",
    title: "Wall St set for lower open as oil hovers near $100",
    urgency: 2,
    related_symbols:
      "ICEEUR:BRN1!,CME_MINI:NQ1!,NASDAQ:INTC,NASDAQ:ARM,NASDAQ:NVDA,NYSE:DOW",
    link: "https://www.tradingview.com/news/reuters.com,2026:newsml_L4N451101:0-wall-st-set-for-lower-open-as-oil-hovers-near-100/",
  },
  {
    id: "DJN_DN20260909005027:0",
    published: "2026-09-09T12:47:00.000Z",
    provider: "Dow Jones Newswires",
    title:
      "Fortum's Google Power Deal Could be Boost For European Data Center Buildout — Market Talk",
    urgency: 2,
    related_symbols: "OMXHEX:FORTUM,NASDAQ:GOOG",
    link: "https://www.tradingview.com/news/DJN_DN20260909005027:0/",
  },
  {
    id: "tag:reuters.com,2026:newsml_L4N45113N:0",
    published: "2026-09-09T12:45:31.000Z",
    provider: "Reuters",
    title: "Baltic index inches higher on strong vessel rates across segments",
    urgency: 2,
    related_symbols: "INDEX:BDI",
    link: "https://www.tradingview.com/news/reuters.com,2026:newsml_L4N45113N:0-baltic-index-inches-higher-on-strong-vessel-rates-across-segments/",
  },
  {
    id: "benzinga:7ddd72f28094b:0",
    published: "2026-09-09T11:44:22.000Z",
    provider: "Benzinga",
    title: "Meta Trending After Unveiling Muse, Its First Personal AI Agent",
    urgency: 2,
    related_symbols: "NASDAQ:META",
    link: "https://www.benzinga.com/trading-ideas/movers/26/09/61682010/meta-trending-after-unveiling-muse-its-first-personal-ai-agent?utm_source=tradingview&utm_campaign=partner_feed&utm_medium=referral",
  },
  {
    id: "DJN_DN20260909005027:1",
    published: "2026-09-09T12:52:00.000Z",
    provider: "Dow Jones Newswires",
    title:
      "Fortum's Google Power Deal Could be Boost For European Data Center Buildout — WSJ",
    urgency: 2,
    related_symbols: "OMXHEX:FORTUM,NASDAQ:GOOG",
    link: "https://www.tradingview.com/news/DJN_DN20260909005027:1/",
  },
];

const MUSE = PREMARKET_0909[4]!;
const FORTUM = PREMARKET_0909[2]!;

/** The block, built over one global feed of `rows`. `economic` answers empty,
 *  which is the ordinary case for a premarket minute. */
async function overviewOf(
  rows: readonly unknown[],
  options: { universe?: string[]; global?: number } = {},
) {
  return buildNewsOverview({
    asOf: "2026-09-09T13:07:00.000Z",
    symbols: [],
    universe: options.universe ?? ["META"],
    caps: { ...NEWS_CAPS.daily, global: options.global ?? 4 },
    read: async (args) =>
      args.section === "markets_today" ? { rows: [...rows] } : { rows: [] },
  });
}

describe("the global feeds are deduped and importance-ordered (#113 item 2)", () => {
  it("keeps the Muse row a four-row recency window dropped, and drops the duplicated story", async () => {
    // The miss, as a test. At 13:07Z on 2026-09-09 the block was the four most
    // recent rows, so the 11:44:22Z Meta/Muse story had scrolled out while META
    // was moving on it. The window is unchanged — the same feed, the same one
    // call — and nothing is dropped for being old (rule 4). What changed is the
    // order: a row whose related symbols name the tracked universe outranks a
    // row about the Baltic dry index.
    const overview = await overviewOf(PREMARKET_0909);

    expect(overview.marketsToday.map((row) => row.id)).toEqual([
      MUSE.id,
      PREMARKET_0909[0]!.id, // Saputo, 13:00:00Z
      PREMARKET_0909[1]!.id, // Wall St set for lower open, 12:49:35Z
      FORTUM.id, // 12:47:00Z — the EARLIER of the two Fortum filings
    ]);
    // The story survived; the second filing of it did not.
    expect(overview.marketsToday.map((row) => row.id)).not.toContain(
      "DJN_DN20260909005027:1",
    );
    expect(overview.selection.marketsToday).toEqual({
      fetched: 6,
      kept: 4,
      dropped: { duplicate: 1, unlinked: 0, capped: 1 },
    });
    // The counts account for every row the feed returned, so a page can say
    // "4 of 6, one duplicate story" instead of implying a quiet tape.
    const counts = overview.selection.marketsToday;
    expect(
      counts.kept +
        counts.dropped.duplicate +
        counts.dropped.unlinked +
        counts.dropped.capped,
    ).toBe(counts.fetched);
  });

  it("gives the same answer whatever order the feed listed the rows in", async () => {
    // A total order, not a stable-sort accident: the feed's own order is an
    // input the result must not depend on, or a replay of a frozen recording
    // stops reproducing the run it recorded.
    const forward = await overviewOf(PREMARKET_0909);
    const reversed = await overviewOf([...PREMARKET_0909].reverse());
    const rotated = await overviewOf([
      ...PREMARKET_0909.slice(3),
      ...PREMARKET_0909.slice(0, 3),
    ]);
    expect(reversed.marketsToday).toEqual(forward.marketsToday);
    expect(rotated.marketsToday).toEqual(forward.marketsToday);
    expect(reversed.selection).toEqual(forward.selection);
    expect(rotated.selection).toEqual(forward.selection);
  });

  it("keeps the EARLIEST filing of a story, whichever provider suffix it wore", async () => {
    // " — Market Talk" and " — WSJ" are the same wire story reaching the tape
    // twice. Which copy survives cannot depend on which arrived first in the
    // list, so it is the earlier timestamp that wins: 12:47:00Z, not 12:52:00Z.
    const kept = (await overviewOf(PREMARKET_0909, { global: 8 })).marketsToday;
    const fortum = kept.filter((row) => row.title.startsWith("Fortum's"));
    expect(fortum).toHaveLength(1);
    expect(fortum[0]!.published).toBe("2026-09-09T12:47:00.000Z");
    expect(fortum[0]!.title).toContain("— Market Talk");
  });

  it("puts a more urgent row first, ahead of universe breadth and recency", async () => {
    // TradingView's `urgency` is LOWER-is-more-urgent. Every row in the
    // 2026-09-09 capture carried urgency 2, so there is no real urgency-1 row
    // to freeze: the field — a feed control code, not a market value — is
    // varied on the real Baltic row to exercise the key. Without the key that
    // row sorts last of the six (no universe symbol, oldest of the four).
    const flash = { ...PREMARKET_0909[3]!, urgency: 1 };
    const overview = await overviewOf([
      ...PREMARKET_0909.slice(0, 3),
      flash,
      ...PREMARKET_0909.slice(4),
    ]);
    expect(overview.marketsToday[0]!.id).toBe(flash.id);
    expect(overview.marketsToday[1]!.id).toBe(MUSE.id);
  });

  it("ranks with no universe rather than refusing to rank", async () => {
    // A caller that passes no universe still gets dedupe, urgency and
    // recency — and this is what the universe key is WORTH: with it, Muse is
    // first; without it, Muse falls back to its 11:44:22Z timestamp and the
    // Baltic dry index takes the last slot again. The duplicate is still gone
    // either way.
    const overview = await overviewOf(PREMARKET_0909, { universe: [] });
    expect(overview.marketsToday.map((row) => row.published)).toEqual([
      "2026-09-09T13:00:00.000Z",
      "2026-09-09T12:49:35.000Z",
      "2026-09-09T12:47:00.000Z",
      "2026-09-09T12:45:31.000Z",
    ]);
    expect(overview.marketsToday.map((row) => row.id)).not.toContain(MUSE.id);
    expect(overview.selection.marketsToday.dropped.duplicate).toBe(1);
  });

  it("counts a link-less row as dropped rather than as a story that never existed", async () => {
    const overview = await overviewOf([
      { ...PREMARKET_0909[0]!, link: "" },
      MUSE,
    ]);
    expect(overview.marketsToday.map((row) => row.id)).toEqual([MUSE.id]);
    expect(overview.selection.marketsToday).toEqual({
      fetched: 2,
      kept: 1,
      dropped: { duplicate: 0, unlinked: 1, capped: 0 },
    });
  });

  it("reports no selection at all when the feed never answered", async () => {
    const overview = await buildNewsOverview({
      asOf: "2026-09-09T13:07:00.000Z",
      symbols: [],
      caps: NEWS_CAPS.daily,
      read: async () => {
        throw new Error('ow_tv_news: OW_TV_ENABLED is not "1"');
      },
    });
    expect(overview.selection.marketsToday).toEqual({
      fetched: 0,
      kept: 0,
      dropped: { duplicate: 0, unlinked: 0, capped: 0 },
    });
    expect(overview.selection.economic).toEqual(
      overview.selection.marketsToday,
    );
  });
});

/**
 * META's own symbol feed on 2026-09-09, as of 12:13Z — `opencli tradingview
 * news --symbol NASDAQ:META`, captured from helium-b4's live run that
 * morning, newest first. All three rows carry urgency 2, which is why
 * urgency cannot be the key that separates them.
 *
 * The two Dow Jones rows are what a two-row cap on the provider's order kept;
 * the Benzinga row — the only one of the three tagged META and nothing else —
 * is what fell below it, on a morning META was moving on exactly that story.
 * Their `link` values follow the TradingView DJN news route the other
 * captured DJN rows in this file use (`/news/<id>/`); the Benzinga row's link
 * is verbatim.
 */
const META_FEED_0909 = [
  {
    id: "DJN_DN20260909002948:0",
    published: "2026-09-09T12:13:00.000Z",
    provider: "Dow Jones Newswires",
    title:
      "Google Has a Cool $15 Billion Fix to the AI Energy Problem — Barrons.com",
    urgency: 2,
    related_symbols: "NASDAQ:GOOG,NASDAQ:AMZN,NASDAQ:META,NASDAQ:MSFT",
    link: "https://www.tradingview.com/news/DJN_DN20260909002948:0/",
  },
  {
    id: "DJN_DN20260909004165:0",
    published: "2026-09-09T12:13:00.000Z",
    provider: "Dow Jones Newswires",
    title: "Investors See Lessons in Hugging Face's Pivot — WSJ",
    urgency: 2,
    related_symbols: "NASDAQ:ANTHROPIC,NASDAQ:META",
    link: "https://www.tradingview.com/news/DJN_DN20260909004165:0-investors-see-lessons-in-hugging-face-s-pivot-wsj/",
  },
  MUSE,
];

/** The block over one symbol's feed: both global feeds answer empty, META
 *  answers with `rows` on the first venue tried. */
async function metaHeadlines(rows: readonly unknown[], perStock = 2) {
  const overview = await buildNewsOverview({
    asOf: "2026-09-09T13:07:00.000Z",
    symbols: ["META"],
    universe: ["META"],
    caps: { ...NEWS_CAPS.daily, perStock },
    read: async (args) =>
      args.symbol === "NASDAQ:META" ? { rows: [...rows] } : { rows: [] },
  });
  return overview.stocks[0]!.headlines;
}

describe("a stock's own feed is ranked by specificity (#113 item 2)", () => {
  it("keeps the row that is about META over two AI stories that merely tag it", async () => {
    // The same miss as the global feeds had, one level down. Every row here
    // already names META — it came back from META's feed — so the count of
    // related symbols is a count of the OTHER names, and fewer of them means
    // more of the row is about this symbol. Under the provider's order the
    // 11:44:22Z Muse row was the third of three and a perStock of 2 dropped
    // it; ranked, it is first.
    const kept = await metaHeadlines(META_FEED_0909);
    expect(kept.map((row) => row.id)).toEqual([
      MUSE.id, // 1 name: META
      "DJN_DN20260909004165:0", // 2 names: ANTHROPIC, META
    ]);
    // 4 names — a general AI story, not a META story.
    expect(kept.map((row) => row.id)).not.toContain("DJN_DN20260909002948:0");
    // Ranking fields never reach the frame: a citation is id, time, provider,
    // title, link and nothing else.
    expect(Object.keys(kept[0]!).sort()).toEqual([
      "id",
      "link",
      "provider",
      "published",
      "title",
    ]);
  });

  it("gives the same answer whatever order the symbol feed listed the rows in", async () => {
    const forward = await metaHeadlines(META_FEED_0909, 3);
    const reversed = await metaHeadlines([...META_FEED_0909].reverse(), 3);
    const rotated = await metaHeadlines(
      [META_FEED_0909[1]!, META_FEED_0909[2]!, META_FEED_0909[0]!],
      3,
    );
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
    // The full order, once: specificity 1, 2, 4.
    expect(forward.map((row) => row.id)).toEqual([
      MUSE.id,
      "DJN_DN20260909004165:0",
      "DJN_DN20260909002948:0",
    ]);
  });

  it("spends a two-row cap on two stories, not on one story filed twice", async () => {
    // A per-stock cap of 2 is the tightest budget in the block, so the same
    // wire story under two provider suffixes is the one dedupe that matters
    // most. Both Fortum filings are 2 names; only the earlier survives.
    const kept = await metaHeadlines([
      FORTUM,
      PREMARKET_0909[5]!, // the same story, " — WSJ", 12:52:00Z
      MUSE,
    ]);
    expect(kept.map((row) => row.id)).toEqual([MUSE.id, FORTUM.id]);
  });
});

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
    // Distinct titles: the feeds dedupe by story now, so thirty copies of one
    // headline are one headline, which is the point of the block.
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...NVDA[0]!,
      id: `row:${String(index)}`,
      title: `${NVDA[0]!.title} (${String(index)})`,
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
          title: `${MARKETS_TODAY[0]!.title} (${String(index)})`,
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
      title: `${NVDA[0]!.title} (${String(index)})`,
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
    expect(overview.notes.join(" ")).toContain("asked 5 of 20 symbols");
    // EVERY feed is fetched deep whatever the phase's cap is — the same
    // number of calls, more rows to choose from — and the phase cap is
    // applied after dedupe and ranking. A symbol's feed is one opencli
    // subprocess whether it answers with 2 rows or 25, so asking shallow
    // there bought nothing but a provider-ordered window.
    expect(asked).toEqual(asked.map(() => NEWS_FETCH_LIMIT));
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
