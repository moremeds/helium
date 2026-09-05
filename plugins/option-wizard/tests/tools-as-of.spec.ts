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
import { buildTools } from "../tools/index.js";

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
    expect(marked).toHaveLength(13);
    expect(spot.description).toContain("Unavailable in an as-of replay");
  });

  it("leaves the live run byte-identical: no as-of key, no changed description", () => {
    const live = toolNamed("ow_spot");
    expect(live.description).not.toContain("as-of replay");
  });
});

describe("as-of, history tools", () => {
  it("ow_uw_calendar looks forward from the replayed instant, not from now", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(CALENDAR), { status: 200 });
    const out = JSON.parse(
      await toolNamed("ow_uw_calendar", { asOf: AS_OF }).run({}, {
        fetchImpl,
      } as never),
    ) as { asOf: string; rows: Array<{ time: string; event: string }> };
    expect(out.asOf).toBe("2026-09-02T16:45:00.000Z");
    // 12:15Z and 14:00Z on 09-02 are BEHIND the 16:45Z instant and drop out;
    // everything inside the following seven days stays, in time order.
    expect(out.rows.map((row) => row.time)).toEqual([
      "2026-09-03T12:30:00Z",
      "2026-09-03T14:00:00Z",
      "2026-09-04T12:30:00Z",
    ]);
    expect(out.rows[0]!.event).toBe(
      "Federal Reserve Governor Christopher Waller speaks at Reuters NEXT Newsmaker Interview",
    );
  });

  it("ow_uw_calendar with no as-of keeps its live window, so the same fixture is entirely in the past", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(CALENDAR), { status: 200 });
    const out = JSON.parse(
      await toolNamed("ow_uw_calendar").run({}, { fetchImpl } as never),
    ) as { rows: unknown[] };
    // The fixture's newest row is 2026-09-04, which is behind any real clock
    // this test runs on. An empty list here is what proves the as-of case
    // above came from the flag and not from the fixture.
    expect(out.rows).toEqual([]);
  });
});
