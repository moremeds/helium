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
