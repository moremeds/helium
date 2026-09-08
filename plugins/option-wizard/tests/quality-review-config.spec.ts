/**
 * `extensions.review` is the whole declarative surface of the review
 * framework, so these tests run against the SHIPPED `tenant.yaml` block rather
 * than a hand-written literal: a declaration that only the tests can parse is
 * not a declaration.
 *
 * The row count is asserted as `coverage.length + sectors.length +
 * themes.length` and never as a constant — adding a theme must be a yaml edit
 * and nothing else, which is the coupling `extensions:` exists to avoid.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import {
  coverageRowCount,
  parseReviewConfig,
  themeRowIds,
} from "../quality/review-config.js";
import { buildTools } from "../tools/index.js";

const TENANT = join(__dirname, "..", "tenant.yaml");
const spec = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT);
const shipped = spec.extensions as Record<string, unknown>;

/** A structural clone, so one test's deletion never reaches another's. */
function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(shipped)) as Record<string, unknown>;
}

function review(block: Record<string, unknown>): Record<string, unknown> {
  return block.review as Record<string, unknown>;
}

describe("parseReviewConfig over the shipped tenant.yaml block", () => {
  const config = parseReviewConfig(shipped);

  it("parses the shipped declaration", () => {
    expect(config.windows).toEqual([5, 10, 21]);
    expect(config.sectors[0]).toBe("Computer/GPU");
    expect(config.verdicts).toContain("untested");
    expect(config.caps.weekly.rowWords).toBe(15);
    expect(config.caps.daily.rowWords).toBe(10);
    expect(config.focus?.weekly).toBe(15);
    expect(config.focus?.daily).toBe(5);
    expect(config.focus?.weights.earnings).toBe(10);
    expect(config.focus?.windows.assignmentRisk).toBe(5);
    expect(config.rotation?.benchmark).toBe("SPY");
    expect(config.rotation?.sectorEtfs).toHaveLength(11);
  });

  it("carries the theme register verbatim", () => {
    expect(config.themes[0]?.instruments).toEqual(["DBA", "MOS", "NTR", "DE"]);
    expect(config.themes[0]?.entered).toBe("2026-09-06");
    expect(config.themes[0]?.killExcess).toEqual({ pct: -10, sessions: 60 });
    expect(themeRowIds(config.themes)).toEqual(["theme:el-nino-ag-2026"]);
  });

  it("counts the coverage rows from the declaration, never from a constant", () => {
    expect(coverageRowCount(config)).toBe(
      config.coverage.length + config.sectors.length + config.themes.length,
    );
    // 12 declared macro rows + 10 sector chains + 1 theme, as shipped.
    expect(coverageRowCount(config)).toBe(23);
  });
});

describe("parseReviewConfig refuses a declaration it cannot settle", () => {
  it("refuses a theme with no kill condition, naming the theme", () => {
    const block = clone();
    delete (review(block).themes as Record<string, unknown>[])[0]!.kill;
    expect(() => parseReviewConfig(block)).toThrow(
      /el-nino-ag-2026: kill is required/u,
    );
  });

  it("refuses a theme with no evidence, naming evidence", () => {
    const block = clone();
    delete (review(block).themes as Record<string, unknown>[])[0]!.evidence;
    expect(() => parseReviewConfig(block)).toThrow(/evidence/u);
  });

  it("refuses two themes with the same id", () => {
    const block = clone();
    const themes = review(block).themes as Record<string, unknown>[];
    themes.push(JSON.parse(JSON.stringify(themes[0])));
    expect(() => parseReviewConfig(block)).toThrow(/duplicate/u);
  });

  it("refuses a re-ordered tieBreak — a configurable tie-break is a configurable answer", () => {
    const block = clone();
    (review(block).focus as Record<string, unknown>).tieBreak = [
      "ticker",
      "score",
      "daysToNearestEvent",
    ];
    expect(() => parseReviewConfig(block)).toThrow(/tieBreak/u);
  });

  it("refuses a calendar pin whose day is not yyyy-mm-dd", () => {
    const block = clone();
    (review(block).focus as Record<string, unknown>).calendarPins = [
      {
        ticker: "MARKET",
        day: "2026-9-8",
        kind: "corporate",
        label: "S&P quarterly rebalance effective",
      },
    ];
    expect(() => parseReviewConfig(block)).toThrow(/day must be yyyy-mm-dd/u);
  });

  it("refuses a calendar pin whose kind is not a focus kind", () => {
    const block = clone();
    (review(block).focus as Record<string, unknown>).calendarPins = [
      {
        ticker: "MARKET",
        day: "2026-09-18",
        kind: "vibes",
        label: "S&P quarterly rebalance effective",
      },
    ];
    expect(() => parseReviewConfig(block)).toThrow(/kind must be one of/u);
  });

  it("refuses an extensions block with no review at all", () => {
    expect(() => parseReviewConfig({})).toThrow(/extensions\.review/u);
  });
});

describe("the register is optional and the count follows the declaration", () => {
  it("accepts themes: [] and drops the theme rows with it", () => {
    const block = clone();
    review(block).themes = [];
    const config = parseReviewConfig(block);
    expect(config.themes).toEqual([]);
    expect(themeRowIds([])).toEqual([]);
    expect(coverageRowCount(config)).toBe(
      config.coverage.length + config.sectors.length,
    );
    expect(coverageRowCount(config)).toBe(22);
  });

  it("accepts an absent focus and rotation block", () => {
    const block = clone();
    delete review(block).focus;
    delete review(block).rotation;
    const config = parseReviewConfig(block);
    expect(config.focus).toBeUndefined();
    expect(config.rotation).toBeUndefined();
  });
});

describe("buildTools refuses the tenant rather than rendering an unsettleable row", () => {
  it("throws the loader's own message, unchanged, to the host", () => {
    const block = clone();
    delete (review(block).themes as Record<string, unknown>[])[0]!.kill;
    expect(() =>
      buildTools({ stateRoot: "/tmp/none", env: {}, extensions: block }),
    ).toThrow(/el-nino-ag-2026: kill is required/u);
  });

  it("builds normally against the shipped block", () => {
    const tools = buildTools({
      stateRoot: "/tmp/none",
      env: {},
      extensions: shipped,
    });
    expect(tools.length).toBeGreaterThan(0);
  });
});

// TODO-verified-shape. Unskip when a live response has been recorded.
it.skip("admits an index add/remove, rebalance or spin-off — BLOCKED: no source", () => {
  // §G.2 wants index add/remove, rebalance and spin rows. Read 2026-09-06:
  // ow_uw_calendar is the US ECONOMIC calendar (verified 2026-09-03,
  // GET /api/market/economic-calendar -> {data:[{type,time,event,forecast,
  // prev,reported_period}]}) and carries none of them; ow_uw_earnings is a
  // per-ticker /info read (next_earnings_date, announce_time) and carries
  // none either; massive.com's Stocks endpoints cover SPLITS and DIVIDENDS
  // only (Task 6). UW's get_market_events was NOT verified against a live
  // response by this plan, so no shape is written here rather than guessed
  // (AGENTS.md: a tool's comment records the live shape it was verified
  // against). Until then these three enter ONLY as an operator-dated
  // `focus.calendarPins` row.
});

// TODO-verified-shape. Unskip when a live response has been recorded.
it.skip("admits a lockup expiry or a secondary offering — BLOCKED: no source (§I.2)", () => {});

describe("the daily total-words cap budgets for the coverage table", () => {
  /**
   * `dailyModelWords` was 300, written before the coverage table existed, and
   * the 2026-09-04 close measured 483 against it — of which `.s3`, the model's
   * per-row clauses, was 241 on its own. Every PER-FIELD cap was respected;
   * the total simply did not budget for the rows.
   */
  const review = parseReviewConfig(shipped);
  const MEASURED_S3 = 241;

  it("covers the prose caps plus the measured coverage-row share", () => {
    expect(review.caps.dailyModelWords).toBeGreaterThanOrEqual(
      review.caps.daily.review + review.caps.daily.outlook + MEASURED_S3,
    );
  });

  it("gives selected weekly topics more room while keeping daily shorter", () => {
    expect(review.caps.weekly.review).toBeGreaterThan(review.caps.daily.review);
    expect(review.caps.weekly.outlook).toBeGreaterThan(review.caps.daily.outlook);
    expect(review.caps.weeklyModelWords).toBeGreaterThan(review.caps.dailyModelWords);
  });
});
