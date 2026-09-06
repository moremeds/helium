/**
 * The One Thing and review document schemas, and the per-field budgets.
 *
 * Every cap here is a declared number, not market data. The one real figure is
 * SPY's 2026-09-03 close, used so the sample document reads like the thing it
 * models rather than like a lorem paragraph.
 */
import { describe, expect, it } from "vitest";
import {
  ONE_THING_BUDGET,
  PERSISTENCE_BUDGET,
  REVIEW_BUDGET,
  measureOneThing,
  measureReview,
  trim,
} from "../render/budget.js";
import { parseOneThingDoc } from "../render/one-thing.js";
import { parseReviewDoc } from "../render/review.js";

const doc = (over: Record<string, unknown> = {}) => ({
  headline: "Duration led the tape into the meeting",
  oneThing:
    "The 10Y fell 0.8 bp to 4.772 %. It is the largest normalised move of the session. Dealers hedging a short gamma book buy into strength. Anyone short duration into the print pays for it.",
  changeMyMind: {
    text: "a 10Y above 4.85 kills the duration read",
    series: "DGS10",
    threshold: ">4.85",
    horizon: "5 sessions",
  },
  checks: [
    { series: "DGS10", level: "4.772", text: "10Y holds under 4.80" },
    { series: "DGS2", level: "4.34", text: "front end does not lead" },
    { series: "VIXCLS", level: "14.32", text: "vol stays bid" },
  ],
  everythingElse: ["Gold +1.89 % to 4,471.34", "DXY 98.977, down 0.599"],
  rationales: [{ id: "SPY-2026-09-03-2", text: "SPY closed 773.17" }],
  ...over,
});

describe("parseOneThingDoc", () => {
  it("parses all six fields with no problems", () => {
    const parsed = parseOneThingDoc(doc());
    expect(parsed.problems).toEqual([]);
    expect(parsed.doc?.checks.length).toBe(3);
    expect(parsed.doc?.changeMyMind?.horizon).toBe("5 sessions");
    expect(parsed.doc?.everythingElse.length).toBe(2);
    expect(parsed.doc?.rationales[0]?.id).toBe("SPY-2026-09-03-2");
  });

  it("drops an incomplete invalidation whole and names the missing field", () => {
    const parsed = parseOneThingDoc(
      doc({
        changeMyMind: {
          text: "a 10Y above 4.85 kills it",
          series: "DGS10",
          threshold: ">4.85",
        },
      }),
    );
    expect(parsed.doc?.changeMyMind).toBeUndefined();
    expect(parsed.problems).toContain("changeMyMind: missing horizon");
    // The rest still parses.
    expect(parsed.doc?.checks.length).toBe(3);
  });

  it("keeps two checks and says two of three", () => {
    const parsed = parseOneThingDoc(doc({ checks: doc().checks.slice(0, 2) }));
    expect(parsed.doc?.checks.length).toBe(2);
    expect(parsed.problems).toContain("checks: 2 of 3");
  });

  it("returns null for something that is not a document", () => {
    expect(parseOneThingDoc("nope").doc).toBeNull();
  });
});

describe("measureOneThing", () => {
  const long = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it("flags a 260-word lead item against 180", () => {
    const { overages } = measureOneThing(doc({ oneThing: long(260) }));
    expect(overages).toContainEqual({
      what: "oneThing",
      words: 260,
      limit: ONE_THING_BUDGET.oneThingWords,
      firstSentenceOver: true,
    });
  });

  it("halves the lead item under the persistence mode", () => {
    const { overages } = measureOneThing(
      doc({ oneThing: long(120) }),
      "persistence",
    );
    expect(overages.find((row) => row.what === "oneThing")?.limit).toBe(
      PERSISTENCE_BUDGET.oneThingWords,
    );
  });

  it("counts the checks and the else lines", () => {
    const measured = measureOneThing(
      doc({
        everythingElse: Array.from(
          { length: 7 },
          (_, i) => `line ${String(i)}`,
        ),
      }),
    );
    expect(measured.checkCount).toBe(3);
    expect(measured.elseCount).toBe(7);
  });
});

describe("trim", () => {
  it("cuts a four-beat paragraph at the last full stop and appends nothing", () => {
    const cut = trim(doc().oneThing, 24);
    expect(cut.cut).toBe("sentence");
    expect(cut.text.endsWith("…")).toBe(false);
    expect(cut.text.endsWith("session.")).toBe(true);
  });
});

describe("parseReviewDoc", () => {
  const review = (over: Record<string, unknown> = {}) => ({
    review: "The duration call held; the front-end call did not.",
    outlook: "Duration continues unless the 10Y takes out 4.85.",
    catalysts: "9/16 FOMC.",
    coverage: [
      {
        id: "rates.long",
        token: "continue",
        p: 0.65,
        why: "the long end led again",
        observable: "DGS10 next print",
      },
    ],
    focus: [{ ticker: "NVDA", why: "earnings 2026-11-18" }],
    themes: [
      { id: "el-nino-ag-2026", leadership: "mixed", why: "DBA led, DE lagged" },
    ],
    ...over,
  });

  it("parses the seven fields it owns", () => {
    const parsed = parseReviewDoc(review());
    expect(parsed.problems).toEqual([]);
    expect(parsed.doc?.coverage[0]?.scorable).toBe(true);
    expect(parsed.doc?.focus[0]?.ticker).toBe("NVDA");
    expect(parsed.doc?.themes[0]?.leadership).toBe("mixed");
  });

  it("keeps a row with an unusable probability but never scores it", () => {
    const parsed = parseReviewDoc(
      review({
        coverage: [{ ...review().coverage[0], p: 0.99 }],
      }),
    );
    expect(parsed.doc?.coverage.length).toBe(1);
    expect(parsed.doc?.coverage[0]?.scorable).toBe(false);
    expect(parsed.doc?.coverage[0]?.p).toBeUndefined();
    expect(parsed.problems.join(" ")).toContain("mints no commitment");
  });

  it("refuses a token and a leadership word it does not know", () => {
    const parsed = parseReviewDoc(
      review({
        coverage: [{ ...review().coverage[0], token: "moon" }],
        themes: [{ id: "el-nino-ag-2026", leadership: "great", why: "x" }],
      }),
    );
    expect(parsed.doc?.coverage).toEqual([]);
    expect(parsed.doc?.themes).toEqual([]);
    expect(parsed.problems.length).toBe(2);
  });
});

describe("measureReview", () => {
  const long = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it("flags the same prose at 300 weekly and 120 daily", () => {
    const body = { review: long(380) };
    expect(measureReview(body, REVIEW_BUDGET.weekly).overages[0]?.limit).toBe(
      300,
    );
    expect(measureReview(body, REVIEW_BUDGET.daily).overages[0]?.limit).toBe(
      120,
    );
  });

  it("flags an over-long row, focus and theme clause", () => {
    const measured = measureReview(
      {
        coverage: [{ id: "rates.long", why: long(22), observable: "ok" }],
        focus: [{ ticker: "NVDA", why: long(24) }],
        themes: [{ id: "el-nino-ag-2026", why: long(30) }],
      },
      REVIEW_BUDGET.weekly,
    );
    expect(measured.rowCount).toBe(1);
    expect(measured.focusCount).toBe(1);
    const what = measured.overages.map((row) => row.what);
    expect(what.some((row) => row.startsWith("rowWords"))).toBe(true);
    expect(what.some((row) => row.startsWith("focusWords"))).toBe(true);
    expect(what.some((row) => row.startsWith("themeWords"))).toBe(true);
  });
});
