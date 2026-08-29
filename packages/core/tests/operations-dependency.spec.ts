import { describe, expect, it } from "vitest";
import { DependencyGraph } from "../src/operations/dependency-graph.js";

const spec = (id: string) => ({
  version: 1 as const,
  id,
  kind: "service",
  mutationOwner: {
    owner: "none" as const,
    competingLabels: [],
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "fixture",
  },
});

describe("DependencyGraph", () => {
  it("orders dependencies before dependents", () => {
    const graph = DependencyGraph.from(
      [spec("api"), spec("runtime"), spec("db")],
      [
        { from: "api", to: "runtime" },
        { from: "api", to: "db" },
        { from: "db", to: "runtime" },
      ],
    );
    expect(graph.topological()).toEqual(["runtime", "db", "api"]);
  });

  it("breaks ties by id, so the order is stable across runs", () => {
    const graph = DependencyGraph.from(
      [spec("zeta"), spec("alpha"), spec("mid")],
      [
        { from: "zeta", to: "mid" },
        { from: "alpha", to: "mid" },
      ],
    );
    expect(graph.topological()).toEqual(["mid", "alpha", "zeta"]);
    for (let i = 0; i < 20; i += 1) {
      expect(graph.topological()).toEqual(["mid", "alpha", "zeta"]);
    }
  });

  it("rejects a cycle, naming the components in it", () => {
    expect(() =>
      DependencyGraph.from(
        [spec("a"), spec("b"), spec("c")],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "a" },
        ],
      ),
    ).toThrow(/cycle/i);
  });

  it("rejects an edge naming a component the graph does not hold", () => {
    expect(() =>
      DependencyGraph.from([spec("a")], [{ from: "a", to: "ghost" }]),
    ).toThrow(/ghost/);
  });

  it("rejects a duplicate component id", () => {
    expect(() => DependencyGraph.from([spec("a"), spec("a")], [])).toThrow(
      /duplicate/,
    );
  });

  it("reports transitive dependencies, nearest first", () => {
    const graph = DependencyGraph.from(
      [spec("api"), spec("db"), spec("runtime")],
      [
        { from: "api", to: "db" },
        { from: "db", to: "runtime" },
      ],
    );
    expect(graph.dependenciesOf("api")).toEqual(["db"]);
    expect(graph.transitiveDependenciesOf("api")).toEqual(["db", "runtime"]);
    expect(graph.transitiveDependenciesOf("runtime")).toEqual([]);
  });
});
