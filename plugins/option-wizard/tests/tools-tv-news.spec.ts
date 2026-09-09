/**
 * `ow_tv_news` shells out to opencli. The subprocess is mocked — CI has no
 * opencli and no TradingView app — but every fixture below is a REAL row
 * captured from the mini on 2026-09-09 (`opencli tradingview news …`), ids,
 * timestamps, titles and links included. What is asserted here is the part
 * that can actually break: the argv, the verbatim passthrough, the venue
 * fallback, and the two ways this tool must refuse rather than answer.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { bin: string; argv: string[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Highest number of subprocesses alive at once. Must never exceed 1. */
  peak: 0,
  live: 0,
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
      state.live += 1;
      state.peak = Math.max(state.peak, state.live);
      let out = "";
      let failure: unknown = null;
      try {
        out = state.handler({ argv });
      } catch (error: unknown) {
        failure = error;
      }
      // Resolve on the next turn of the loop: a caller that fired two calls
      // without awaiting would then have both alive at once, and `peak` sees it.
      setTimeout(() => {
        state.live -= 1;
        cb(failure, { stdout: out, stderr: "" });
      }, 0);
    },
  );
  return { ...actual, execFile };
});

const { buildTools } = await import("../tools/index.js");

/** Live, 2026-09-09: `opencli tradingview news --symbol NASDAQ:NVDA --limit 3 -f json`. */
const NVDA_ROWS = [
  {
    id: "gurufocus:d29c92119094b:0",
    published: "2026-09-08T21:25:13.000Z",
    provider: "GuruFocus",
    title: "Nvidia Falls as Its Firmus Bet Lands OpenAI",
    urgency: 2,
    related_symbols: "NASDAQ:NVDA",
    link: "https://www.gurufocus.com/news/9070840/nvidia-falls-as-its-firmus-bet-lands-openai",
  },
  {
    id: "DJN_DN20260908007494:0",
    published: "2026-09-08T19:47:00.000Z",
    provider: "Dow Jones Newswires",
    title: "3 ETFs Ready for the High-Yield Dividend Stress Test — Barrons.com",
    urgency: 2,
    related_symbols: "NYSE:ABBV,NYSE:BAC,NASDAQ:AVGO,NYSE:KO,NYSE:XOM,NYSE:GS",
    link: "https://www.tradingview.com/news/DJN_DN20260908007494:0/",
  },
  {
    id: "zacks:b3c2a4f71094b:0",
    published: "2026-09-08T19:10:00.000Z",
    provider: "Zacks",
    title: "Why Today's AI Boom Differs From the Internet Bubble",
    urgency: 2,
    related_symbols: "NASDAQ:NVDA,NASDAQ:GOOG,NASDAQ:AMD",
    link: "https://www.zacks.com/commentary/2986639/why-today-s-ai-boom-differs-from-the-internet-bubble?cid=CS-TRADINGVIEW-FT-investment_ideas-2986639",
  },
];

/** Live, 2026-09-09: `--symbol AMEX:SPY`. `NYSE Arca:SPY` and `NYSE:NVDA`
 *  both answered `[]` in the same probe — the venue fallback exists for this. */
const SPY_ROWS = [
  {
    id: "benzinga:6eb5598e0094b:0",
    published: "2026-09-08T22:17:21.000Z",
    provider: "Benzinga",
    title:
      "Trump Approval Rating Falls Lower, Stock Market Gains Can’t Offset Voter Opinion About Iran War",
    urgency: 2,
    related_symbols: "AMEX:SPY",
    link: "https://www.benzinga.com/news/politics/26/09/61675336/trump-approval-rating-falls-lower-stock-market-gains-cant-offset-voter-opinion-about-iran-war?utm_source=tradingview&utm_campaign=partner_feed&utm_medium=referral",
  },
];

/** Live, 2026-09-09: `--id gurufocus:d29c92119094b:0`. The detail shape swaps
 *  `urgency`/`related_symbols` for `body`/`tags`. */
const STORY = {
  id: "gurufocus:d29c92119094b:0",
  published: "2026-09-08T21:25:13.000Z",
  provider: "gurufocus",
  title: "Nvidia Falls as Its Firmus Bet Lands OpenAI",
  body: "Nvidia-backed Firmus secured a multiyear agreement to provide OpenAI with computing capacity from two Malaysian data centers.",
  tags: "GuruFocus, Strategy, business, and products, US stocks",
  link: "https://www.gurufocus.com/news/9070840/nvidia-falls-as-its-firmus-bet-lands-openai",
};

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

function newsTool(overrides: Record<string, unknown> = {}): {
  run: (args: Record<string, unknown>) => Promise<string>;
} {
  const found = buildTools({
    stateRoot: mkdtempSync(join(tmpdir(), "ow-tv-news-")),
    env: { OW_TV_ENABLED: "1", OPENCLI_BIN: "/usr/local/bin/opencli" },
    ...overrides,
  }).find((tool) => tool.name === "ow_tv_news");
  if (found === undefined) throw new Error("no tool ow_tv_news");
  return found;
}

beforeEach(() => {
  state.calls = [];
  state.peak = 0;
  state.live = 0;
  state.handler = ({ argv }) => {
    if (flag(argv, "--id") !== undefined) return JSON.stringify([STORY]);
    const symbol = flag(argv, "--symbol");
    if (symbol === "NASDAQ:NVDA") return JSON.stringify(NVDA_ROWS);
    if (symbol === "AMEX:SPY") return JSON.stringify(SPY_ROWS);
    if (symbol !== undefined) return "[]";
    return JSON.stringify(NVDA_ROWS);
  };
});

describe("ow_tv_news", () => {
  it("returns every field of every row verbatim", async () => {
    const out = JSON.parse(
      await newsTool().run({ symbol: "NASDAQ:NVDA", limit: 3 }),
    ) as { tvSymbol: string; rows: unknown[] };
    expect(out.tvSymbol).toBe("NASDAQ:NVDA");
    // Not "the fields we kept": the whole row, including `urgency` and the
    // comma-separated `related_symbols` string, and above all `link` — the
    // reason this source was chosen over the URL-less UW feed.
    expect(out.rows).toEqual(NVDA_ROWS);
    expect(state.calls[0]?.argv).toEqual([
      "tradingview",
      "news",
      "--symbol",
      "NASDAQ:NVDA",
      "--limit",
      "3",
      "-f",
      "json",
    ]);
  });

  it("caps the rows at 25 and refuses a larger request", async () => {
    // The cap is the summariser budget, not a page size: a caller that asks
    // for more is refused rather than quietly served 25.
    await expect(newsTool().run({ limit: 40 })).rejects.toThrow();
    state.handler = () =>
      JSON.stringify(
        Array.from({ length: 40 }, (_, index) => ({
          ...NVDA_ROWS[0],
          id: `row:${String(index)}`,
        })),
      );
    const out = JSON.parse(await newsTool().run({ limit: 25 })) as {
      rows: unknown[];
    };
    expect(out.rows.length).toBe(25);
    expect(flag(state.calls.at(-1)!.argv, "--limit")).toBe("25");
  });

  it("resolves a bare ticker by trying US venues, one call at a time", async () => {
    const out = JSON.parse(await newsTool().run({ symbol: "spy" })) as {
      tvSymbol: string;
      rows: unknown[];
    };
    // NASDAQ:SPY answers `[]` — the same silence a wrong venue gives live.
    expect(state.calls.map((call) => flag(call.argv, "--symbol"))).toEqual([
      "NASDAQ:SPY",
      "AMEX:SPY",
    ]);
    expect(out.tvSymbol).toBe("AMEX:SPY");
    expect(out.rows).toEqual(SPY_ROWS);
    expect(state.peak).toBe(1);
  });

  it("says so when no venue answers, instead of returning a bare empty list", async () => {
    state.handler = () => "[]";
    const out = JSON.parse(await newsTool().run({ symbol: "ZZZZ" })) as {
      symbol: string;
      rows: unknown[];
      note: string;
    };
    expect(out.rows).toEqual([]);
    expect(out.note).toContain("ZZZZ");
    expect(out.note).toContain("empty list");
  });

  it("fetches one story by id", async () => {
    const out = JSON.parse(
      await newsTool().run({ id: "gurufocus:d29c92119094b:0" }),
    ) as { story: { body: string } };
    expect(out.story).toEqual(STORY);
    expect(flag(state.calls[0]!.argv, "--id")).toBe(
      "gurufocus:d29c92119094b:0",
    );
    expect(state.calls[0]!.argv).not.toContain("--limit");
  });

  it("refuses when the machine has no TradingView route", async () => {
    await expect(
      newsTool({ env: { OPENCLI_BIN: "/usr/local/bin/opencli" } }).run({}),
    ).rejects.toThrow(/OW_TV_ENABLED/u);
    await expect(
      newsTool({ env: { OW_TV_ENABLED: "1" } }).run({}),
    ).rejects.toThrow(/OPENCLI_BIN/u);
    expect(state.calls).toEqual([]);
  });

  it("reports unavailable in an as-of replay instead of returning today's news", async () => {
    // The route serves the CURRENT feed and takes no date. Today's headlines
    // under last Tuesday's dateline is the one answer worse than none.
    const marked: Array<[string, string]> = [];
    const out = JSON.parse(
      await newsTool({
        asOf: new Date("2026-09-02T12:45:00.000Z"),
        pit: {
          markUnavailable: (tool: string, reason: string) => {
            marked.push([tool, reason]);
          },
        },
      }).run({ symbol: "NASDAQ:NVDA" }),
    ) as { unavailable: string; asOf: string; reason: string };
    expect(out.unavailable).toBe("as-of");
    expect(out.asOf).toBe("2026-09-02T12:45:00.000Z");
    expect(out.reason).toContain("no dated archive");
    expect(marked.some(([tool]) => tool === "ow_tv_news")).toBe(true);
    expect(state.calls).toEqual([]);
  });
});
