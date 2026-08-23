import { describe, expect, it } from "vitest";
import { nowIso, parseDuration } from "../src/time.js";

describe("parseDuration", () => {
  it("converts second, minute and hour literals to milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("accepts millisecond and day literals", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("throws on junk", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
    expect(() => parseDuration("30")).toThrow(/invalid duration/);
    expect(() => parseDuration("-5m")).toThrow(/invalid duration/);
    expect(() => parseDuration("1.5h")).toThrow(/invalid duration/);
    expect(() => parseDuration("")).toThrow(/invalid duration/);
  });
});

describe("nowIso", () => {
  it("returns a UTC ISO-8601 timestamp", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
