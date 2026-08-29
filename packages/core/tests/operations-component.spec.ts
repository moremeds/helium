import { describe, expect, it } from "vitest";
import {
  ComponentSpecSchema,
  DependencyEdgeSchema,
} from "../src/operations/component.js";

const component = {
  version: 1,
  id: "fixture-service",
  kind: "service",
};

describe("ComponentSpecSchema", () => {
  it("parses a component", () => {
    expect(ComponentSpecSchema.parse(component).id).toBe("fixture-service");
  });

  // Open-ended by design: a closed enum means every new component kind needs a
  // core edit, which is exactly what acceptance criterion 14 forbids.
  it("admits a component kind core has never heard of", () => {
    expect(
      ComponentSpecSchema.parse({ ...component, kind: "future-component-kind" })
        .kind,
    ).toBe("future-component-kind");
  });

  it("rejects any provider or model key", () => {
    expect(() =>
      ComponentSpecSchema.parse({ ...component, model: "forbidden" }),
    ).toThrow();
  });

  it("bounds the opaque identifier and kind", () => {
    expect(() => ComponentSpecSchema.parse({ ...component, id: "" })).toThrow();
    expect(() =>
      ComponentSpecSchema.parse({ ...component, kind: "k".repeat(200) }),
    ).toThrow();
  });
});

describe("DependencyEdgeSchema", () => {
  it("parses an edge from dependent to dependency", () => {
    const edge = DependencyEdgeSchema.parse({ from: "api", to: "runtime" });
    expect(edge).toEqual({ from: "api", to: "runtime" });
  });

  it("rejects a self edge", () => {
    expect(() => DependencyEdgeSchema.parse({ from: "api", to: "api" })).toThrow(
      /self/,
    );
  });

  // A cycle spans more than one edge, so no single edge can detect it. Graph
  // validation owns that, and a closed component enum would not help either.
  it("accepts each edge of a two-node cycle in isolation", () => {
    expect(() => DependencyEdgeSchema.parse({ from: "a", to: "b" })).not.toThrow();
    expect(() => DependencyEdgeSchema.parse({ from: "b", to: "a" })).not.toThrow();
  });
});
