/**
 * Dependency-aware incident correlation: one root incident, not an alert
 * storm.
 *
 * Pure and total. It receives a graph, the current observations, the
 * previously projected incidents and an explicit clock, and it returns a
 * deterministic result. It performs no I/O and never reads the clock itself --
 * a correlator that called `Date.now()` could not be replayed, and replay is
 * the whole point of an incident record.
 *
 * Two rules do the real work:
 *
 *   - An expired observation is `unknown`, not its last known value. Staleness
 *     read as health is exactly the audited parser-drift failure.
 *   - An incident is `action-eligible` only when its root is decisively
 *     `failed` AND no contributing observation is stale. Acting on a partly
 *     stale picture is how a controller repairs the wrong thing.
 * @module @helium/core/operations/correlate
 */
import type { DependencyGraph } from "./dependency-graph.js";
import {
  incidentKey,
  type IncidentFailureClass,
  type Incident,
  type Inhibition,
} from "./incident.js";
import { effectiveState, type Observation } from "./observation.js";

export interface CorrelateInput {
  graph: DependencyGraph;
  observations: Observation[];
  previous: Incident[];
}

export interface CorrelateResult {
  incidents: Incident[];
  inhibitions: Inhibition[];
}

/** `unknown` outranks nothing: absence of proof is weaker than a real fault. */
const SEVERITY: Readonly<Record<string, number>> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failed: 3,
};

interface Unhealthy {
  observation: Observation;
  state: IncidentFailureClass;
}

function scopedComponentKey(componentId: string, scopeId: string | undefined): string {
  return JSON.stringify([scopeId ?? null, componentId]);
}

export function correlate(
  input: CorrelateInput,
  now: Date,
): CorrelateResult {
  const { graph, observations, previous } = input;

  // 1. Resolve every reading against the clock, then keep the unhealthy ones.
  const unhealthy: Unhealthy[] = observations
    .map((observation) => ({
      observation,
      state: effectiveState(observation, now),
    }))
    .filter((o): o is Unhealthy => o.state !== "ok")
    .sort((a, b) =>
      a.observation.id < b.observation.id ? -1 : a.observation.id > b.observation.id ? 1 : 0,
    );

  const failingComponents = new Set(unhealthy.map((u) =>
    scopedComponentKey(u.observation.componentId, u.observation.scopeId)));

  // 2. A component whose transitive dependency is also failing is a SYMPTOM;
  //    its root is the furthest failing dependency, so a chain collapses to one
  //    incident rather than one per hop.
  const rootOf = new Map<string, string>();
  for (const item of unhealthy) {
    const componentId = item.observation.componentId;
    const scopeId = item.observation.scopeId;
    const componentKey = scopedComponentKey(componentId, scopeId);
    if (rootOf.has(componentKey)) continue;
    const failingDeps = graph
      .transitiveDependenciesOf(componentId)
      .filter((dep) => failingComponents.has(scopedComponentKey(dep, scopeId)));
    rootOf.set(componentKey, failingDeps.at(-1) ?? componentId);
  }

  const inhibitionsByPair = new Map<string, Inhibition>();
  for (const [componentKey, parent] of rootOf) {
    const parsed = JSON.parse(componentKey) as [string | null, string];
    const child = parsed[1];
    if (child === parent) continue;
    inhibitionsByPair.set(`${child}\u0000${parent}`, {
      child,
      parent,
      reason: "dependency-root-failing",
    });
  }
  const inhibitions = [...inhibitionsByPair.values()].sort((a, b) =>
    a.child.localeCompare(b.child) || a.parent.localeCompare(b.parent));

  // 3. One incident per root, keyed on the ROOT's own worst reading.
  const byRoot = new Map<string, Unhealthy[]>();
  for (const item of unhealthy) {
    const scopeId = item.observation.scopeId;
    const root = rootOf.get(scopedComponentKey(item.observation.componentId, scopeId));
    if (root === undefined) continue;
    const rootKey = scopedComponentKey(root, scopeId);
    const bucket = byRoot.get(rootKey) ?? [];
    bucket.push(item);
    byRoot.set(rootKey, bucket);
  }

  const previousByKey = new Map(previous.map((i) => [i.key, i]));
  const nowIso = now.toISOString();

  const incidents: Incident[] = [...byRoot.keys()]
    .sort()
    .map((rootKey) => {
      const [rawScopeId, root] = JSON.parse(rootKey) as [string | null, string];
      const scopeId = rawScopeId ?? undefined;
      const contributing = (byRoot.get(rootKey) ?? []).slice().sort((a, b) =>
        a.observation.id < b.observation.id ? -1 : 1,
      );
      const rootReadings = contributing.filter(
        (c) => c.observation.componentId === root,
      );
      // The root's own worst reading defines the incident's class and
      // dimension. A symptom's reading never renames the root cause.
      const worst = rootReadings
        .slice()
        .sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state])[0];

      const anyStale = contributing.some((c) => c.state === "unknown");
      const key = incidentKey({
        componentId: root,
        dimension: worst.observation.dimension,
        failureClass: worst.state,
        rootComponentId: root,
        ...(scopeId === undefined ? {} : { scopeId }),
      });
      const prior = previousByKey.get(key);

      return {
        key,
        ...(scopeId === undefined ? {} : { scopeId }),
        rootComponentId: root,
        symptomComponentIds: [
          ...new Set(
            contributing
              .map((c) => c.observation.componentId)
              .filter((id) => id !== root),
          ),
        ].sort(),
        dimension: worst.observation.dimension,
        failureClass: worst.state,
        // State progression past this point -- recovering, verifying,
        // recovered -- belongs to the action controller, which owns the
        // action's own lifecycle. Correlation only decides whether the
        // evidence supports acting at all.
        state:
          worst.state === "failed" && !anyStale ? "action-eligible" : "open",
        observationIds: contributing.map((c) => c.observation.id),
        openedAt: prior?.openedAt ?? nowIso,
        updatedAt: nowIso,
      } satisfies Incident;
    });

  return { incidents, inhibitions };
}
