/**
 * Jaccard over cause-section titles. The model never computes it; this file
 * is the arithmetic, pinned on two real titles from the 2026-09-05 pit-v3
 * replay (docs/evidence/pit-replays/2026-09-05/pit-v3/).
 * @module dsh-plugin-tenant-option-wizard/tests/quality-similarity
 */
import { describe, expect, it } from "vitest";
import { jaccard, wordSet } from "../quality/similarity.js";

// option-wizard-2026-09-01-intraday.md, the edit step's first section title.
const TITLE_A =
  "A hawkish front end: futures put 64% on a September hike while the 10Y sits at 4.75%, its highest August close";
// option-wizard-2026-09-04-premarket.md, the edit step's first section title.
const TITLE_B =
  "August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give the labor market";

describe("wordSet", () => {
  it("drops the stopword list and strips edge punctuation", () => {
    expect([...wordSet(TITLE_A)].sort()).toEqual(
      [
        "10y",
        "4.75%",
        "64%",
        "august",
        "close",
        "end",
        "front",
        "futures",
        "hawkish",
        "highest",
        "hike",
        "its",
        "put",
        "september",
        "sits",
        "while",
      ].sort(),
    );
    expect(wordSet(TITLE_A).size).toBe(16);
  });

  it("keeps an internal hyphen and strips a leading plus and an em dash", () => {
    expect([...wordSet(TITLE_B)].sort()).toEqual(
      [
        "162k",
        "55k",
        "august",
        "back-revisions",
        "cut",
        "end",
        "front",
        "give",
        "has",
        "labor",
        "market",
        "no",
        "payrolls",
        "printed",
        "with",
      ].sort(),
    );
    expect(wordSet(TITLE_B).size).toBe(15);
  });
});

describe("jaccard", () => {
  it("is 3/28 on the two recorded pit-v3 cause titles", () => {
    // Intersection {august, front, end} = 3; union 16 + 15 - 3 = 28.
    const value = jaccard(wordSet(TITLE_A), wordSet(TITLE_B));
    expect(value).toBeCloseTo(3 / 28, 12);
    expect(value.toFixed(2)).toBe("0.11");
  });

  it("is 1 for a title compared with itself", () => {
    expect(jaccard(wordSet(TITLE_A), wordSet(TITLE_A))).toBe(1);
  });

  it("is 0 for two titles that share no word", () => {
    expect(jaccard(wordSet("Rates led"), wordSet("Payrolls printed"))).toBe(0);
  });

  it("is 0 when both titles are empty, never NaN", () => {
    // 0/0 is the case that would put NaN into the audit table.
    expect(jaccard(wordSet(""), wordSet("the a of to"))).toBe(0);
  });
});
