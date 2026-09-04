/**
 * ISO-week arithmetic, checked on the four days where it is easy to get wrong.
 * Every expectation below is the ISO-8601 answer for a real calendar date, not
 * a value read back off the implementation.
 * @module dsh-plugin-tenant-option-wizard/tests/week
 */
import { describe, expect, it } from "vitest";
import { isoWeekOf } from "../render/week.js";

describe("isoWeekOf", () => {
  it("names the week of the recorded 2026-09-03 run", () => {
    expect(isoWeekOf("2026-09-03")).toBe("2026-W36");
  });

  it("keeps 2026-12-31 in ISO 2026, where its Thursday puts it", () => {
    // 2026-12-31 IS a Thursday, so the ISO year is its own calendar year and
    // the week is the 53rd. The plan's text said 2027-W01; the arithmetic says
    // otherwise, and the arithmetic is what argon routes on.
    expect(isoWeekOf("2026-12-31")).toBe("2026-W53");
  });

  it("keeps 2027-01-01 in the PREVIOUS ISO year", () => {
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
  });

  it("starts ISO 2027 on the Monday of 2027-01-04", () => {
    expect(isoWeekOf("2027-01-04")).toBe("2027-W01");
  });

  it("returns an empty key rather than a wrong one for a malformed date", () => {
    expect(isoWeekOf("not-a-date")).toBe("");
  });
});
