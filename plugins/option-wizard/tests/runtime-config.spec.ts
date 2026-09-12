import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import {
  OW_RUNTIME_DEFAULT,
  parseRuntimeConfig,
  parseRuntimeConfigJson,
  supportsSnapshotReplay,
  type OptionWizardRuntimeConfig,
  type RuntimeNewsPerStock,
} from "../runtime/index.js";
import { NEWS_CAPS } from "../quality/news-overview.js";
import { buildTools } from "../tools/index.js";

const TENANT = join(__dirname, "..", "tenant.yaml");
const extensions = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT)
  .extensions;

function config(perStock: RuntimeNewsPerStock): OptionWizardRuntimeConfig {
  return {
    ...OW_RUNTIME_DEFAULT,
    config: { news: { ...OW_RUNTIME_DEFAULT.config.news, perStock } },
  };
}

describe("option-wizard runtime config", () => {
  it("accepts only the registered full payload", () => {
    expect(supportsSnapshotReplay).toBe(true);
    expect(parseRuntimeConfig(config(1)).config.news.perStock).toBe(1);
    expect(parseRuntimeConfig(config(2)).config.news.perStock).toBe(2);
    expect(parseRuntimeConfig(config(3)).config.news.perStock).toBe(3);

    for (const perStock of [0, 4, true, "3"]) {
      expect(() =>
        parseRuntimeConfig({
          ...config(2),
          config: { news: { global: 4, perStock, stocks: 5 } },
        }),
      ).toThrow(/perStock/u);
    }
    expect(() => parseRuntimeConfig({ ...config(2), cmd: "date" })).toThrow(
      /cmd is unknown/u,
    );
    expect(() =>
      parseRuntimeConfig({
        ...config(2),
        config: { news: { global: 8, perStock: 2, stocks: 5 } },
      }),
    ).toThrow(/global is protected/u);
    expect(() => parseRuntimeConfig({ ...config(2), phase: "close" })).toThrow(
      /phase/u,
    );
  });

  it("rejects duplicate and prototype keys in raw JSON", () => {
    expect(() =>
      parseRuntimeConfigJson(
        '{"schemaVersion":"ow-runtime-v1","tenant":"option-wizard","phase":"close","phase":"premarket","config":{"news":{"global":4,"perStock":2,"stocks":5}}}',
      ),
    ).toThrow(/duplicate/iu);
    expect(() =>
      parseRuntimeConfigJson(
        '{"schemaVersion":"ow-runtime-v1","tenant":"option-wizard","phase":"premarket","config":{"news":{"global":4,"perStock":2,"stocks":5,"__proto__":{}}}}',
      ),
    ).toThrow(/__proto__|forbidden/u);
  });

  it("rejects inherited input fields", () => {
    const polluted = Object.create({ phase: "premarket" }) as Record<
      string,
      unknown
    >;
    Object.assign(polluted, config(2));
    expect(() => parseRuntimeConfig(polluted)).toThrow(/plain (?:JSON data|object)/u);
  });
});

// Three real rows captured from TradingView's NASDAQ:META feed on 2026-09-09.
// They are citation strings only; the test derives no market number from them.
const META_ROWS = [
  {
    id: "DJN_DN20260909002948:0",
    published: "2026-09-09T12:13:00.000Z",
    provider: "Dow Jones Newswires",
    title: "Google Has a Cool $15 Billion Fix to the AI Energy Problem — Barrons.com",
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
  {
    id: "benzinga:7ddd72f28094b:0",
    published: "2026-09-09T11:44:22.000Z",
    provider: "Benzinga",
    title: "Meta Trending After Unveiling Muse, Its First Personal AI Agent",
    urgency: 2,
    related_symbols: "NASDAQ:META",
    link: "https://www.benzinga.com/trading-ideas/movers/26/09/61682010/meta-trending-after-unveiling-muse-its-first-personal-ai-agent?utm_source=tradingview&utm_campaign=partner_feed&utm_medium=referral",
  },
];

function frozenRecordings(rows: readonly unknown[]) {
  return {
    has: () => true,
    lookup: (tool: string, args: Record<string, unknown>): string | undefined => {
      if (tool === "ow_session_frame")
        throw new Error("snapshot-pipeline must rebuild the frame");
      if (tool === "ow_argon_watchlist")
        return JSON.stringify({ chains: [], ofInterest: ["META"], ivRank: {} });
      if (tool === "ow_tv_news")
        return JSON.stringify({
          rows: args.symbol === "NASDAQ:META" ? [...rows] : [],
        });
      if (tool === "ow_event_day" || tool === "ow_premarket_movers")
        return "null";
      return "{}";
    },
  };
}

async function frozenFrame(
  phase: string,
  rows: readonly unknown[],
  runtimeConfig?: OptionWizardRuntimeConfig,
) {
  const tool = buildTools({
    stateRoot: mkdtempSync(join(tmpdir(), "ow-runtime-frame-")),
    env: {},
    phase,
    asOf: new Date("2026-09-09T13:07:00.000Z"),
    replayMode: "snapshot-pipeline",
    recordings: frozenRecordings(rows),
    extensions: {
      ...extensions,
      ...(runtimeConfig === undefined ? {} : { runtimeConfig }),
    },
  }).find((entry) => entry.name === "ow_session_frame");
  if (tool === undefined) throw new Error("ow_session_frame was not built");
  return JSON.parse(await tool.run({})) as {
    coverage: Array<{ layer: string; asOf?: string }>;
    newsOverview: { asOf: string; stocks: Array<{ headlines: unknown[] }> };
  };
}

async function frozenNews(
  phase: string,
  rows: readonly unknown[],
  runtimeConfig?: OptionWizardRuntimeConfig,
) {
  return (await frozenFrame(phase, rows, runtimeConfig)).newsOverview;
}

describe("premarket runtime news wiring", () => {
  it("changes the rebuilt frozen frame only when a third row exists", async () => {
    const [two, three, absent] = await Promise.all([
      frozenNews("premarket", META_ROWS, config(2)),
      frozenNews("premarket", META_ROWS, config(3)),
      frozenNews("premarket", META_ROWS),
    ]);
    expect(two.stocks[0]?.headlines).toHaveLength(2);
    expect(three.stocks[0]?.headlines).toHaveLength(3);
    expect(two.asOf).toBe("2026-09-09T13:07:00.000Z");
    expect(three.asOf).toBe(two.asOf);
    expect(absent.stocks).toEqual(two.stocks);
    expect(NEWS_CAPS.daily.perStock).toBe(2);

    const [onlyTwo, askedForThree] = await Promise.all([
      frozenNews("premarket", META_ROWS.slice(0, 2), config(2)),
      frozenNews("premarket", META_ROWS.slice(0, 2), config(3)),
    ]);
    expect(askedForThree.stocks).toEqual(onlyTwo.stocks);
  });

  it("uses the frozen clock for generated frame timestamps", async () => {
    const frame = await frozenFrame("premarket", META_ROWS, config(2));
    expect(frame.newsOverview.asOf).toBe("2026-09-09T13:07:00.000Z");
    expect(frame.coverage.find((row) => row.layer === "earnings")?.asOf).toBe(
      "2026-09-09T13:07:00.000Z",
    );
  });

  it("keeps every other phase on its legacy caps and ignores runtime payloads", async () => {
    const malformed = { cmd: "ignored outside premarket" } as never;
    const [intraday, close, weekly, unknown] = await Promise.all([
      frozenNews("intraday", META_ROWS, malformed),
      frozenNews("close", META_ROWS, config(3)),
      frozenNews("weekly", META_ROWS, config(1)),
      frozenNews("future-phase", META_ROWS, config(3)),
    ]);
    expect(intraday.stocks[0]?.headlines).toHaveLength(2);
    expect(close.stocks[0]?.headlines).toHaveLength(2);
    expect(weekly.stocks[0]?.headlines).toHaveLength(3);
    expect(unknown.stocks[0]?.headlines).toHaveLength(2);
  });

  it("fails a replayed source closed when its exact input is absent", async () => {
    expect(() =>
      buildTools({
        stateRoot: mkdtempSync(join(tmpdir(), "ow-runtime-unfrozen-")),
        env: {},
        phase: "premarket",
        replayMode: "snapshot-pipeline",
        extensions,
      }),
    ).toThrow(/requires frozen recordings/u);
    expect(() =>
      buildTools({
        stateRoot: mkdtempSync(join(tmpdir(), "ow-runtime-unclocked-")),
        env: {},
        phase: "premarket",
        replayMode: "snapshot-pipeline",
        recordings: { has: () => false, lookup: () => undefined },
        extensions,
      }),
    ).toThrow(/requires a frozen clock/u);
    const built = buildTools({
      stateRoot: mkdtempSync(join(tmpdir(), "ow-runtime-missing-")),
      env: {},
      phase: "premarket",
      asOf: new Date("2026-09-09T13:07:00.000Z"),
      replayMode: "snapshot-pipeline",
      recordings: { has: () => false, lookup: () => undefined },
      extensions,
    });
    await expect(
      built.find((entry) => entry.name === "ow_tv_news")!.run({}),
    ).rejects.toThrow(/live fallback disabled/u);
  });
});
