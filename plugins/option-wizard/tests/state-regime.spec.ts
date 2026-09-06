/**
 * The record one run hands the next. Six fields, all copied from a tool by the
 * model and none computed by it.
 * @module dsh-plugin-tenant-option-wizard/tests/state-regime
 */
import { describe, expect, it } from "vitest";
import { findStateBlock, parseRegimeState } from "../state/regime.js";

const GOOD = {
  cause: "August payrolls printed 162k",
  ust2y: 4.02,
  ust10y: 4.79,
  s2s10: 77,
  tide: "up",
  thesis: "The front end has no cut to give the labor market.",
};

describe("parseRegimeState", () => {
  it("accepts the recorded shape", () => {
    expect(parseRegimeState(GOOD)).toEqual(GOOD);
  });

  it("accepts a record whose optional numbers are missing", () => {
    // A day the rates tools were skipped still has a cause and a thesis, and
    // half a record beats none: the next run compares CAUSES first.
    expect(parseRegimeState({ cause: "x", tide: "flat", thesis: "y" })).toEqual({
      cause: "x",
      tide: "flat",
      thesis: "y",
    });
  });

  it("rejects a missing cause, a missing thesis and an unknown tide", () => {
    expect(parseRegimeState({ tide: "up", thesis: "y" })).toBe(null);
    expect(parseRegimeState({ cause: "x", tide: "up" })).toBe(null);
    expect(parseRegimeState({ cause: "x", tide: "sideways", thesis: "y" })).toBe(
      null,
    );
  });

  it("rejects a number that arrived as a string", () => {
    // "4.79" is what a model writes when it is re-typing rather than copying,
    // and it is the tell that the number was not read off a tool.
    expect(parseRegimeState({ ...GOOD, ust10y: "4.79" })).toBe(null);
  });

  it("rejects anything that is not an object", () => {
    expect(parseRegimeState(null)).toBe(null);
    expect(parseRegimeState([GOOD])).toBe(null);
    expect(parseRegimeState("cause")).toBe(null);
  });
});

describe("findStateBlock", () => {
  it("returns the block's body", () => {
    expect(
      findStateBlock('{"sections":[]}\n\n```regime-state\n{"cause":"x"}\n```'),
    ).toBe('{"cause":"x"}');
  });

  it("returns null when there is no such fence", () => {
    expect(findStateBlock('{"sections":[]}\n\n```json\n{"a":1}\n```')).toBe(
      null,
    );
  });
});

describe("the checks and the invalidation ride the same fence", () => {
  // Resolution 3 of the One Thing design (2026-09-06, binding): the checks
  // live inside the EXISTING regime-state record. No second state file, no
  // plural stateBlocks in core, no filesystem write in the renderer — so
  // findStateBlock and the fence name must both be untouched by that decision.
  const GOOD_RECORD = {
    cause: "the front end came in ahead of payrolls",
    tide: "up",
    thesis: "call-heavy tape into a coin-flip-plus hike",
  };
  const THREE = [
    { series: "VIXCLS", level: "15.2", text: "VIX holds under 16" },
    { series: "DGS10", level: "4.79", text: "10Y holds 4.77" },
    { series: "BAMLH0A0HYM2", level: "2.66", text: "HY OAS stays inside 2.70" },
  ];

  it("leaves findStateBlock exactly as it was", () => {
    expect(
      findStateBlock(
        '{"sections":[]}\n\n```regime-state\n{"cause":"x","checks":[]}\n```',
      ),
    ).toBe('{"cause":"x","checks":[]}');
  });

  it("round-trips both keys through parseRegimeState", () => {
    const value = {
      ...GOOD_RECORD,
      checks: THREE,
      invalidation: {
        series: "BAMLH0A0HYM2",
        threshold: ">2.80",
        horizon: "5 sessions",
      },
    };
    const parsed = parseRegimeState(value);
    expect(parsed).not.toBe(null);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
  });
});
