import { describe, expect, it } from "vitest";
import { extractFields, hashFields } from "./sensor.js";

describe("extractFields", () => {
  it("resolves dot-paths, array indices and missing paths", () => {
    const body = {
      regime: { state: "tightening", confidence: 0.72 },
      direction: "up",
      legs: [{ tenor: "2y" }, { tenor: "10y" }],
    };
    expect(
      extractFields(body, ["regime.state", "legs.1.tenor", "missing.path"]),
    ).toEqual({
      "regime.state": "tightening",
      "legs.1.tenor": "10y",
      "missing.path": null,
    });
  });

  it("returns null for every path when the body is not an object", () => {
    expect(extractFields("boom", ["a.b"])).toEqual({ "a.b": null });
  });
});

describe("hashFields", () => {
  it("is a 12-char hex digest independent of key insertion order", () => {
    const a = hashFields({ "regime.state": "tightening", direction: "up" });
    const b = hashFields({ direction: "up", "regime.state": "tightening" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when any watched value changes", () => {
    expect(hashFields({ a: 1 })).not.toBe(hashFields({ a: 2 }));
  });
});
