/**
 * Point-in-time replay: `buildTools({ asOf })`.
 *
 * Two properties are worth a test and the rest are not. A live-only tool must
 * refuse BEFORE it reaches the network — a tool that answered with today's
 * price under a past date is the failure this whole flag exists to prevent,
 * and it is invisible in the output. And a history tool must actually move its
 * window: a filter that silently does nothing looks exactly like a filter that
 * works, until a replay quotes next week's calendar at a past instant.
 */
import { describe, expect, it } from "vitest";
import { buildTools, dateCutSql, priorOpenDay } from "../tools/index.js";

const AS_OF = new Date("2026-09-02T16:45:00Z");

/**
 * The real GET /api/market/economic-calendar rows for 2026-09-02..2026-09-09,
 * captured 2026-09-05 through the Unusual Whales MCP `get_market_events` tool
 * (the same upstream calendar the endpoint serves), trimmed to the five fields
 * ow_uw_calendar reads plus `reported_period`, which it drops. Frozen: no
 * network at test time, and no invented event ever gets into an assertion.
 */
const CALENDAR = {
  data: [
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
      time: "2026-09-03T14:00:00Z",
      prev: "54.1",
      event: "ISM Report On Business Services PMI",
      forecast: "54.4",
      reported_period: "August",
    },
    {
      type: "fed-speaker",
      time: "2026-09-03T12:30:00Z",
      prev: null,
      event:
        "Federal Reserve Governor Christopher Waller speaks at Reuters NEXT Newsmaker Interview",
      forecast: null,
      reported_period: null,
    },
    {
      type: "report",
      time: "2026-09-02T14:00:00Z",
      prev: "-0.3%",
      event: "Factory Orders",
      forecast: "0.5%",
      reported_period: "July",
    },
    {
      type: "report",
      time: "2026-09-02T12:15:00Z",
      prev: "44000",
      event: "ADP National Employment Report",
      forecast: "45000",
      reported_period: "August",
    },
  ],
};

function toolNamed(
  name: string,
  cfg: Partial<Parameters<typeof buildTools>[0]> = {},
) {
  const found = buildTools({
    stateRoot: "/nonexistent",
    env: {
      OW_UW_API_KEY: "k",
      OW_TV_ENABLED: "1",
      OPENCLI_BIN: "/nonexistent",
    },
    ...cfg,
  }).find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("as-of, live-only tools", () => {
  it("ow_spot refuses without touching the network, and says so in its own description", async () => {
    const marked: Array<[string, string]> = [];
    const spot = toolNamed("ow_spot", {
      asOf: AS_OF,
      pit: {
        markUnavailable: (tool, reason) => marked.push([tool, reason]),
      },
    });
    const out = JSON.parse(
      await spot.run({ tickers: ["SPY"] }, {
        // Any call at all is the defect: a live source asked about a past
        // instant answers about now, and the answer is indistinguishable from
        // a real one downstream.
        fetchImpl: () => {
          throw new Error("ow_spot reached the network during an as-of replay");
        },
      } as never),
    ) as Record<string, unknown>;
    expect(out).toEqual({
      unavailable: "as-of",
      asOf: "2026-09-02T16:45:00.000Z",
      reason: "the live quote route has no history",
    });
    // Every live-only tool marks itself when the replay is built, not when it
    // is first called: a tool nobody called is still a source this replay did
    // not have, and a coverage count that only sees called tools reads a thin
    // replay as a complete one.
    expect(marked).toContainEqual([
      "ow_spot",
      "the live quote route has no history",
    ]);
    expect(marked).toHaveLength(14);
    expect(marked).toContainEqual([
      "ow_uw_calendar",
      "economic calendar has no history",
    ]);
    expect(spot.description).toContain("Unavailable in an as-of replay");
  });

  it("leaves the live run byte-identical: no as-of key, no changed description", () => {
    const live = toolNamed("ow_spot");
    expect(live.description).not.toContain("as-of replay");
  });
});

describe("as-of, history tools", () => {
  it("cuts a daily-keyed column STRICTLY before the as-of day", () => {
    // A record keyed to day D is written during or after D. `<=` handed an
    // 09-02 premarket replay that day's own DGS10, policy snapshot and IV
    // rank — numbers from hours it had not reached yet.
    expect(dateCutSql("r.market_date", "2026-09-02")).toBe(
      " AND r.market_date < DATE '2026-09-02'",
    );
    expect(dateCutSql("r.market_date", undefined)).toBe("");
  });

  it("walks back to the prior OPEN day, over a closed Monday and the weekend behind it", () => {
    // 2026-09-07 is Labor Day, a Monday; the session before it is Friday
    // 2026-09-04. Without the declared closure this returned the holiday
    // itself, and a premarket brief for Tuesday the 8th quoted a tide labelled
    // `prior` from a day on which nothing traded.
    const calendar = { weekdaysOnly: true, closed: ["2026-09-07"] };
    expect(priorOpenDay("2026-09-08", calendar)).toBe("2026-09-04");
    // Same walk with no calendar is weekends only — the old behaviour, kept so
    // a host that does not pass the block still gets a weekday.
    expect(priorOpenDay("2026-09-08")).toBe("2026-09-07");
    expect(priorOpenDay("2026-09-07")).toBe("2026-09-04");
    // An ordinary Tuesday is just the Monday before it.
    expect(priorOpenDay("2026-09-02", calendar)).toBe("2026-09-01");
  });

  it("ow_uw_calendar is refused in a replay rather than answered with the wrong week", async () => {
    const calendar = toolNamed("ow_uw_calendar", { asOf: AS_OF });
    const out = JSON.parse(
      await calendar.run({}, {
        fetchImpl: () => {
          throw new Error("ow_uw_calendar reached the network in a replay");
        },
      } as never),
    ) as Record<string, unknown>;
    expect(out).toEqual({
      unavailable: "as-of",
      asOf: "2026-09-02T16:45:00.000Z",
      reason: "economic calendar has no history",
    });
  });

  it("ow_uw_calendar still answers live, over the real forward window", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(CALENDAR), { status: 200 });
    const out = JSON.parse(
      await toolNamed("ow_uw_calendar").run({}, { fetchImpl } as never),
    ) as { rows: unknown[] };
    // Every row in the frozen fixture is behind any clock this test runs on,
    // so the live window is empty — which is what the endpoint's short
    // forward window means and why a replay cannot use it.
    expect(out.rows).toEqual([]);
  });
});

/**
 * Serving a live-only tool from a recording. Fourteen tools refuse a replayed
 * instant because their sources have no history (`AS_OF_BLIND`) — but a
 * recording of one of OUR OWN earlier runs IS history.
 */
describe("as-of tools with recordings", () => {
  it("refuses as before when the operator named no recording", async () => {
    const marked: string[] = [];
    const tool = toolNamed("ow_spot", {
      asOf: AS_OF,
      pit: { markUnavailable: (name) => marked.push(name) },
    });
    expect(
      JSON.parse(await tool.run({ tickers: ["SPY"] }, {} as never)).unavailable,
    ).toBe("as-of");
    expect(marked).toContain("ow_spot");
  });

  it("returns the recorded response, and marks nothing unavailable", async () => {
    const marked: string[] = [];
    const tool = toolNamed("ow_spot", {
      asOf: AS_OF,
      pit: { markUnavailable: (name) => marked.push(name) },
      recordings: {
        has: (name) => name === "ow_spot",
        lookup: (name, args) =>
          name === "ow_spot" &&
          JSON.stringify(args) === JSON.stringify({ tickers: ["SPY"] })
            ? '{"rows":[{"ticker":"SPY","close":661.02}]}'
            : undefined,
      },
    });
    expect(await tool.run({ tickers: ["SPY"] }, {} as never)).toBe(
      '{"rows":[{"ticker":"SPY","close":661.02}]}',
    );
    // `pit` is shared by every tool this build produced, and the other
    // thirteen live-only tools have no recording here, so they are marked as
    // they always were. The claim is about THIS tool.
    expect(marked).not.toContain("ow_spot");
  });

  it("falls back to the refusal, lazily, when the arguments do not match", async () => {
    const marked: string[] = [];
    const tool = toolNamed("ow_spot", {
      asOf: AS_OF,
      pit: { markUnavailable: (name) => marked.push(name) },
      recordings: { has: () => true, lookup: () => undefined },
    });
    // Nothing is marked until the tool is actually CALLED and misses.
    expect(marked).toEqual([]);
    expect(
      JSON.parse(await tool.run({ tickers: ["QQQ"] }, {} as never)).unavailable,
    ).toBe("as-of");
    expect(marked).toContain("ow_spot");
  });

  it("leaves a tool that is not live-only alone", () => {
    const tool = toolNamed("ow_macro_rates", {
      asOf: AS_OF,
      recordings: { has: () => true, lookup: () => "should not be used" },
    });
    expect(tool.description).not.toContain("Unavailable in an as-of replay");
  });
});
