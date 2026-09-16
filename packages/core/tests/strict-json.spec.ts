import { expect, it } from "vitest";
import { canonicalJson, parseStrictJson } from "../src/strict-json.js";

it("has one identity across key order and escaped keys, rejecting lossy JSON", () => {
  expect(canonicalJson(parseStrictJson('{"b":[1,{"z":"a:b"}],"a":2}')))
    .toBe('{"a":2,"b":[1,{"z":"a:b"}]}');
  expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow("Duplicate");
  expect(() => parseStrictJson('{"nested":{"x":1,"x":2}}')).toThrow("Duplicate");
  expect(() => parseStrictJson('{"x":1e999}')).toThrow();
  expect(() => parseStrictJson('{"__proto__":{}}')).toThrow();
  for (const value of [undefined, NaN, Infinity, new Date(), [undefined], Array(1)])
    expect(() => canonicalJson(value)).toThrow();
  expect(() => canonicalJson({ get x() { throw new Error("getter ran"); } }))
    .toThrow("accessors");
});
