/**
 * A validated component dependency graph.
 *
 * Edges point from dependent to dependency: `from` needs `to`. The graph is
 * built once and validated at construction, because a cycle or a dangling edge
 * discovered halfway through correlation would leave a half-built incident
 * picture -- and correlation runs on the recovery path.
 *
 * Every traversal here is ORDERED. Topological order breaks ties by id rather
 * than by insertion, so the same components and edges always yield the same
 * order: a correlator whose output depends on map iteration order cannot be
 * replayed, and replay is what the incident record exists for.
 * @module @helium/core/operations/dependency-graph
 */
import type { ComponentSpec, DependencyEdge } from "./component.js";

export class DependencyGraph {
  readonly #components: Map<string, ComponentSpec>;
  /** id -> its direct dependencies, sorted. */
  readonly #dependencies: Map<string, string[]>;
  /** id -> the components that directly depend on it, sorted. */
  readonly #dependents: Map<string, string[]>;

  private constructor(
    components: Map<string, ComponentSpec>,
    dependencies: Map<string, string[]>,
    dependents: Map<string, string[]>,
  ) {
    this.#components = components;
    this.#dependencies = dependencies;
    this.#dependents = dependents;
  }

  /**
   * @throws on a duplicate component, an edge naming an unknown component, or
   * any dependency cycle.
   */
  static from(
    components: ComponentSpec[],
    edges: DependencyEdge[],
  ): DependencyGraph {
    const byId = new Map<string, ComponentSpec>();
    for (const component of components) {
      if (byId.has(component.id)) {
        throw new Error(`duplicate component: ${component.id}`);
      }
      byId.set(component.id, component);
    }

    const dependencies = new Map<string, string[]>(
      [...byId.keys()].map((id) => [id, []]),
    );
    const dependents = new Map<string, string[]>(
      [...byId.keys()].map((id) => [id, []]),
    );
    for (const edge of edges) {
      for (const id of [edge.from, edge.to]) {
        if (!byId.has(id)) {
          throw new Error(`dependency edge names unknown component: ${id}`);
        }
      }
      dependencies.get(edge.from)?.push(edge.to);
      dependents.get(edge.to)?.push(edge.from);
    }
    for (const list of [...dependencies.values(), ...dependents.values()]) {
      list.sort();
    }

    const graph = new DependencyGraph(byId, dependencies, dependents);
    graph.#assertAcyclic();
    return graph;
  }

  /** Kahn's algorithm with a sorted ready set, so ties break by id. */
  topological(): string[] {
    const remaining = new Map(
      [...this.#dependencies].map(([id, deps]) => [id, deps.length]),
    );
    const order: string[] = [];
    for (;;) {
      const ready = [...remaining]
        .filter(([, count]) => count === 0)
        .map(([id]) => id)
        .sort();
      if (ready.length === 0) break;
      const next = ready[0];
      order.push(next);
      remaining.delete(next);
      for (const dependent of this.#dependents.get(next) ?? []) {
        const count = remaining.get(dependent);
        if (count !== undefined) remaining.set(dependent, count - 1);
      }
    }
    return order;
  }

  #assertAcyclic(): void {
    const order = this.topological();
    if (order.length !== this.#components.size) {
      const stuck = [...this.#components.keys()]
        .filter((id) => !order.includes(id))
        .sort();
      throw new Error(`dependency cycle among: ${stuck.join(", ")}`);
    }
  }

  has(id: string): boolean {
    return this.#components.has(id);
  }

  ids(): string[] {
    return [...this.#components.keys()].sort();
  }

  dependenciesOf(id: string): string[] {
    return [...(this.#dependencies.get(id) ?? [])];
  }

  dependentsOf(id: string): string[] {
    return [...(this.#dependents.get(id) ?? [])];
  }

  /** Every transitive dependency, breadth-first so nearest comes first. */
  transitiveDependenciesOf(id: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    let frontier = this.dependenciesOf(id);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const dep of frontier) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        out.push(dep);
        next.push(...this.dependenciesOf(dep));
      }
      frontier = [...new Set(next)].sort();
    }
    return out;
  }
}
