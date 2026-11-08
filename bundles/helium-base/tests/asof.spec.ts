import { describe, expect, it } from "vitest";
import { clampDates, setAsOf } from "../src/asof.js";
import { withAsOf } from "../src/asof.js";

describe("as-of", () => {
  it("clamps every date after as-of, at any depth, and leaves the rest", () => {
    const args = { date: "2099-12-31", from: "2026-01-02", at: "2026-11-10T09:30:00Z", list: ["2027-01-01", "x"], n: 3 };
    expect(clampDates(args, "2026-11-09")).toEqual({
      date: "2026-11-09",
      from: "2026-01-02",
      at: "2026-11-09",
      list: ["2026-11-09", "x"],
      n: 3,
    });
  });

  it("injects the run's as-of into a wrapped tool", async () => {
    setAsOf("2026-11-06");
    const seen: unknown[] = [];
    const exec = withAsOf(async (a: { date: string }, asOf: string) => (seen.push(a.date, asOf), "ok"));
    await exec({ date: "2030-01-01" }, undefined);
    expect(seen).toEqual(["2026-11-06", "2026-11-06"]);
  });

  it("rejects a malformed as-of", () => {
    expect(() => setAsOf("11/06/2026")).toThrow(/yyyy-mm-dd/);
  });
});
