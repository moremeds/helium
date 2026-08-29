import { describe, expect, it } from "vitest";
import {
  ComponentSpecSchema,
  DependencyEdgeSchema,
} from "../src/operations/component.js";

const component = {
  version: 1,
  id: "fixture-service",
  kind: "service",
  mutationOwner: {
    owner: "none" as const,
    competingLabels: [],
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "fixture",
  },
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

  // A component with no recorded owner is a component nobody has decided
  // about, and defaulting that to "we may mutate it" is the crash-matrix cell
  // that produces a genuine duplicate production mutation.
  it("refuses a component that declares no mutation owner", () => {
    const { mutationOwner: _drop, ...without } = component;
    expect(() => ComponentSpecSchema.parse(without)).toThrow();
  });

  it("refuses an owner outside the closed set", () => {
    expect(() =>
      ComponentSpecSchema.parse({
        ...component,
        mutationOwner: { ...component.mutationOwner, owner: "maybe" },
      }),
    ).toThrow();
  });

  it("keeps competing controller labels as opaque strings", () => {
    const parsed = ComponentSpecSchema.parse({
      ...component,
      mutationOwner: {
        ...component.mutationOwner,
        owner: "external" as const,
        externalOwnerLabel: "some.host.job",
        competingLabels: ["some.host.job", "another.host.job"],
      },
    });
    expect(parsed.mutationOwner.competingLabels).toHaveLength(2);
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
