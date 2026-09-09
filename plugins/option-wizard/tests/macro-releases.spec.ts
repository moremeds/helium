/**
 * `ow_macro_releases` and its summariser (#107, the data layer for #106).
 *
 * THE FIXTURE is the real week 2026-09-07..2026-09-13 as argon's
 * `/api/macro/releases` carried it, as-of 2026-09-09: the three rows the
 * 2026-09-09 weekly example quoted off that payload (CPI, PPI, initial jobless
 * claims) plus the one release that had actually printed by then, August
 * unemployment. Frozen here with that as-of date; nothing in this file touches
 * the network.
 *
 * NOT VERIFIED LIVE: argon PR #428 is open and undeployed and its flag
 * `UW_SCAN_MACRO_RELEASE_CALENDAR_ENABLED` is off, so no machine served this
 * shape on 2026-09-09. The FIELD NAMES and their nullability were read out of
 * argon's own OpenAPI snapshot (`MacroReleaseRow`, branch
 * `feat/macro-release-calendar`), which is also why `actual` appears here both
 * as the number helium #107's written contract promised and as the decimal
 * string argon's schema actually serialises.
 */
import { describe, expect, it } from "vitest";
import { summariseMacroReleases } from "../quality/macro-releases.js";
import { buildTools } from "../tools/index.js";

const WEEK = {
  week_start: "2026-09-07",
  week_end: "2026-09-13",
  releases: [
    {
      event: "CPI (YoY)",
      type: "inflation",
      reported_period: "2026-08",
      scheduled_at: "2026-09-11T12:30:00Z",
      forecast: "3.4%",
      prior: "3.4%",
      series_id: null,
      actual: null,
      revision: false,
      published_at: null,
    },
    {
      event: "PPI (YoY)",
      type: "inflation",
      reported_period: "2026-08",
      scheduled_at: "2026-09-10T12:30:00Z",
      forecast: "5.3%",
      prior: "4.7%",
      series_id: null,
      actual: null,
      revision: false,
      published_at: null,
    },
    {
      event: "Initial Jobless Claims",
      type: "labor",
      reported_period: "2026-09-05",
      scheduled_at: "2026-09-10T12:30:00Z",
      forecast: "208K",
      prior: "206K",
      series_id: null,
      actual: null,
      revision: false,
      published_at: null,
    },
    {
      event: "Unemployment Rate",
      type: "labor",
      reported_period: "2026-08",
      scheduled_at: "2026-09-04T12:30:00Z",
      forecast: "4.3%",
      prior: "4.2%",
      series_id: "UNRATE",
      actual: 4.3,
      revision: false,
      published_at: "2026-09-04",
    },
  ],
};

const BASE = "http://argon.test";

function tool(env: Record<string, string | undefined> = { OW_ARGON_API_BASE: BASE }) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find(
    (t) => t.name === "ow_macro_releases",
  );
  if (found === undefined) throw new Error("no tool ow_macro_releases");
  return found;
}

const ctx = (serve: (url: URL) => Response) =>
  ({
    fetchImpl: async (input: URL | string) =>
      serve(input instanceof URL ? input : new URL(input)),
  }) as never;

describe("summariseMacroReleases", () => {
  it("keeps the whole week on the weekly phase", () => {
    const out = summariseMacroReleases(WEEK, {
      asOf: "2026-09-13",
      phase: "weekly",
    });
    expect(out.weekStart).toBe("2026-09-07");
    expect(out.weekEnd).toBe("2026-09-13");
    expect(out.scheduled.map((r) => r.event)).toEqual([
      "Initial Jobless Claims",
      "PPI (YoY)",
      "CPI (YoY)",
    ]);
    expect(out.printed.map((r) => r.event)).toEqual(["Unemployment Rate"]);
    expect(out.unavailable).toBeUndefined();
  });

  it("keeps only that session's releases as scheduled on a daily phase", () => {
    const out = summariseMacroReleases(WEEK, {
      asOf: "2026-09-11",
      phase: "premarket",
    });
    // Thursday's PPI and claims are behind the run; only Friday's CPI is ahead
    // of a Friday premarket, and CPI has not printed at 08:45 ET either.
    expect(out.scheduled.map((r) => r.event)).toEqual(["CPI (YoY)"]);
    expect(out.printed.map((r) => r.event)).toEqual(["Unemployment Rate"]);
  });

  it("never lists a release with no actual as printed", () => {
    for (const phase of ["weekly", "premarket", "intraday", "close"]) {
      const out = summariseMacroReleases(WEEK, {
        asOf: "2026-09-11",
        phase,
      });
      for (const row of out.printed) expect(row.actual).not.toBeNull();
      for (const row of out.scheduled) expect(row.actual).toBeNull();
      // No row is in both halves, and no row is invented.
      expect(out.printed.length + out.scheduled.length).toBeLessThanOrEqual(
        WEEK.releases.length,
      );
    }
  });

  it("holds a print back until its published_at is on or before the session", () => {
    // The same week read on the day the unemployment rate was still ahead: the
    // row exists in the payload, and quoting its actual would be quoting a
    // number that did not exist yet.
    const out = summariseMacroReleases(WEEK, {
      asOf: "2026-09-03",
      phase: "close",
    });
    expect(out.printed).toEqual([]);
  });

  it("carries forecast and prior as the source's own text", () => {
    const out = summariseMacroReleases(WEEK, {
      asOf: "2026-09-13",
      phase: "weekly",
    });
    const cpi = out.scheduled.find((r) => r.event === "CPI (YoY)");
    expect(cpi?.forecast).toBe("3.4%");
    expect(cpi?.prior).toBe("3.4%");
    expect(typeof cpi?.forecast).toBe("string");
    expect(typeof cpi?.prior).toBe("string");
  });

  it("carries a decimal-string actual verbatim, the way argon serialises it", () => {
    const wire = {
      ...WEEK,
      releases: WEEK.releases.map((row) =>
        row.series_id === "UNRATE" ? { ...row, actual: "4.3" } : row,
      ),
    };
    const out = summariseMacroReleases(wire, {
      asOf: "2026-09-13",
      phase: "weekly",
    });
    expect(out.printed[0]?.actual).toBe("4.3");
  });

  it("says the calendar is unread rather than reporting an empty week", () => {
    const out = summariseMacroReleases(
      { releases: [], unavailable: "ow_macro_releases: 404" },
      { asOf: "2026-09-11", phase: "premarket" },
    );
    expect(out.unavailable).toContain("404");
    expect(out.scheduled).toEqual([]);
    expect(out.printed).toEqual([]);
  });
});

describe("ow_macro_releases", () => {
  it("asks argon for the week it was given", async () => {
    let seen: URL | undefined;
    const out = JSON.parse(
      await tool().run(
        { week: "2026-09-09" },
        ctx((url) => {
          seen = url;
          return new Response(JSON.stringify(WEEK), { status: 200 });
        }),
      ),
    ) as { releases: unknown[]; week_start: string };
    expect(seen?.pathname).toBe("/api/macro/releases");
    expect(seen?.searchParams.get("week")).toBe("2026-09-09");
    expect(out.week_start).toBe("2026-09-07");
    expect(out.releases).toHaveLength(4);
  });

  it("returns an unavailable reason instead of throwing when the endpoint is absent", async () => {
    // An argon without PR #428 deployed — which is every argon on 2026-09-09.
    const out = JSON.parse(
      await tool().run(
        {},
        ctx(() => new Response("not found", { status: 404 })),
      ),
    ) as { releases: unknown[]; unavailable: string };
    expect(out.releases).toEqual([]);
    expect(out.unavailable).toContain("404");
    expect(summariseMacroReleases(out, { asOf: "2026-09-11" }).unavailable)
      .toContain("404");
  });

  it("names the missing key when argon is not configured", async () => {
    await expect(tool({}).run({})).rejects.toThrow(/OW_ARGON_API_BASE is unset/u);
  });
});
