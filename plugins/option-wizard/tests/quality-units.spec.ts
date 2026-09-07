/**
 * One example per unit, from the 2026-09-06 acceptance run's own output.
 *
 * Every number below was printed by that run as a raw float:
 * `+2.9089` four-week excess, `2.3634%` implied move,
 * `118.7479 → +0.3896 index pts`, `1.3037037037037023` as a channel score.
 * The table in `quality/units.ts` is what stopped that.
 */
import { describe, expect, it } from "vitest";
import { fmt, fmtSigned, roundTo, unitFromToken } from "../quality/units.js";

describe("the printed precision of a number, by its unit", () => {
  it("percent: one decimal (the rotation table's four-week excess)", () => {
    expect(fmtSigned(2.9089, "pct")).toBe("+2.9");
    expect(fmtSigned(-1.782, "pct")).toBe("-1.8");
    expect(fmt(2.3634, "pct")).toBe("2.4");
  });

  it("index points: one decimal (DTWEXBGS, quoted to one)", () => {
    expect(fmt(118.7479, "indexPts")).toBe("118.7");
    expect(fmtSigned(0.3896, "indexPts")).toBe("+0.4");
  });

  it("basis points: none (a half basis point is not quoted)", () => {
    expect(fmtSigned(-2.0, "bp")).toBe("-2");
    expect(fmtSigned(4.65, "bp")).toBe("+5");
  });

  it("VIX points: two (VIXCLS 14.32 against 15.20)", () => {
    expect(fmtSigned(-0.88, "pts")).toBe("-0.88");
  });

  it("prices: two (SPY 769.55)", () => {
    expect(fmt(769.55, "price")).toBe("769.55");
    expect(fmtSigned(8.01, "price")).toBe("+8.01");
  });

  it("IV rank: none (a rank out of a hundred)", () => {
    expect(fmt(45.06, "ivRank")).toBe("45");
    expect(fmt(0, "ivRank")).toBe("0");
  });

  it("a rounded -0.0 prints as +0.0, because it did not fall", () => {
    expect(fmtSigned(-0.004, "pct")).toBe("+0.0");
  });

  it("reads the unit off the token the extractor already wrote", () => {
    expect(unitFromToken("bp")).toBe("bp");
    expect(unitFromToken("pts")).toBe("pts");
    expect(unitFromToken("%")).toBe("pct");
    expect(unitFromToken("pp")).toBe("pp");
    expect(unitFromToken("index")).toBe("indexPts");
    expect(unitFromToken("USD")).toBe("usd");
    expect(unitFromToken(undefined)).toBe("price");
  });

  it("rounds a payload FIELD to the same precision it would print at", () => {
    expect(roundTo(3.4072, "pct")).toBe(3.4);
    expect(roundTo(1.3037037037037023, "pct")).toBe(1.3);
  });

  it("says em dash rather than NaN", () => {
    expect(fmt(Number.NaN, "pct")).toBe("—");
    expect(fmtSigned(Number.POSITIVE_INFINITY, "bp")).toBe("—");
  });
});
