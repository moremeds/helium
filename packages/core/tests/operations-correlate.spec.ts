import { describe, expect, it } from "vitest";
import { DependencyGraph } from "../src/operations/dependency-graph.js";
import { correlate } from "../src/operations/correlate.js";
import type { Observation } from "../src/operations/observation.js";

const now = new Date("2026-08-25T04:00:00.000Z");

const spec = (id: string) => ({ version: 1 as const, id, kind: "service" });

const graph = DependencyGraph.from(
  [spec("runtime"), spec("api-a"), spec("api-b")],
  [
    { from: "api-a", to: "runtime" },
    { from: "api-b", to: "runtime" },
  ],
);

const obs = (
  componentId: string,
  state: Observation["state"],
  overrides: Partial<Observation> = {},
): Observation => ({
  version: 1,
  id: `obs-${componentId}-${state}`,
  componentId,
  probeId: `${componentId}.probe.v1`,
  observedAt: "2026-08-25T03:59:00.000Z",
  expiresAt: "2026-08-25T04:04:00.000Z",
  state,
  dimension: "readiness",
  evidenceRefs: [`artifact://probe/${componentId}`],
  parserVersion: "probe/1",
  ...overrides,
});

describe("correlate", () => {
  it("groups symptoms under one root and inhibits the children", () => {
    const result = correlate(
      {
        graph,
        observations: [
          obs("runtime", "failed"),
          obs("api-a", "failed"),
          obs("api-b", "failed"),
        ],
        previous: [],
      },
      now,
    );

    expect(result.incidents).toEqual([
      expect.objectContaining({
        rootComponentId: "runtime",
        symptomComponentIds: ["api-a", "api-b"],
        state: "action-eligible",
      }),
    ]);
    expect(result.inhibitions).toEqual([
      expect.objectContaining({ child: "api-a", parent: "runtime" }),
      expect.objectContaining({ child: "api-b", parent: "runtime" }),
    ]);
  });

  it("preserves the inhibited children's observations as evidence", () => {
    // Inhibition suppresses a redundant incident, never the evidence: recovery
    // verification has to be able to see the children come back.
    const result = correlate(
      {
        graph,
        observations: [
          obs("runtime", "failed"),
          obs("api-a", "failed"),
          obs("api-b", "failed"),
        ],
        previous: [],
      },
      now,
    );
    expect(result.incidents[0].observationIds).toEqual([
      "obs-api-a-failed",
      "obs-api-b-failed",
      "obs-runtime-failed",
    ]);
  });

  it("opens one incident per independently failing component", () => {
    const result = correlate(
      {
        graph,
        observations: [obs("api-a", "failed"), obs("api-b", "failed")],
        previous: [],
      },
      now,
    );
    expect(result.incidents.map((i) => i.rootComponentId)).toEqual([
      "api-a",
      "api-b",
    ]);
    expect(result.inhibitions).toEqual([]);
  });

  it("opens nothing when everything is healthy", () => {
    const result = correlate(
      { graph, observations: [obs("runtime", "ok")], previous: [] },
      now,
    );
    expect(result.incidents).toEqual([]);
  });

  it("treats an expired probe as unknown and refuses to make it action-eligible", () => {
    const stale = obs("runtime", "failed", {
      observedAt: "2026-08-25T03:00:00.000Z",
      expiresAt: "2026-08-25T03:05:00.000Z",
    });
    const result = correlate(
      { graph, observations: [stale], previous: [] },
      now,
    );
    expect(result.incidents[0]).toMatchObject({
      rootComponentId: "runtime",
      failureClass: "unknown",
      state: "open",
    });
    expect(result.incidents[0].state).not.toBe("action-eligible");
  });

  it("refuses action eligibility when any contributing probe is stale", () => {
    // The root looks decisively failed, but one symptom's evidence expired.
    // Acting on a partly-stale picture is how a controller repairs the wrong
    // thing, so eligibility is withheld rather than assumed.
    const result = correlate(
      {
        graph,
        observations: [
          obs("runtime", "failed"),
          obs("api-a", "failed", {
            observedAt: "2026-08-25T03:00:00.000Z",
            expiresAt: "2026-08-25T03:05:00.000Z",
          }),
        ],
        previous: [],
      },
      now,
    );
    expect(result.incidents[0].state).toBe("open");
  });

  it("keeps a degraded root out of action eligibility", () => {
    const result = correlate(
      { graph, observations: [obs("runtime", "degraded")], previous: [] },
      now,
    );
    expect(result.incidents[0]).toMatchObject({
      failureClass: "degraded",
      state: "open",
    });
  });

  it("generates a dedupe key from component, dimension, failure class and root", () => {
    const [incident] = correlate(
      {
        graph,
        observations: [obs("runtime", "failed"), obs("api-a", "failed")],
        previous: [],
      },
      now,
    ).incidents;
    expect(incident.key).toBe("runtime|readiness|failed|runtime");
  });

  it("carries openedAt forward for an incident it has seen before", () => {
    const first = correlate(
      { graph, observations: [obs("runtime", "failed")], previous: [] },
      new Date("2026-08-25T03:59:30.000Z"),
    );
    const second = correlate(
      { graph, observations: [obs("runtime", "failed")], previous: first.incidents },
      now,
    );
    expect(second.incidents[0].openedAt).toBe(first.incidents[0].openedAt);
    expect(second.incidents[0].updatedAt).toBe(now.toISOString());
  });

  it("is deterministic: identical inputs give byte-identical output", () => {
    const input = {
      graph,
      observations: [
        obs("api-b", "failed"),
        obs("runtime", "failed"),
        obs("api-a", "failed"),
      ],
      previous: [],
    };
    const first = JSON.stringify(correlate(input, now));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(correlate(input, now))).toBe(first);
    }
  });

  it("performs no I/O and does not read the clock itself", () => {
    // The clock is an argument. A correlator that called Date.now() could not
    // be replayed, and replay is what the incident record is for.
    const input = { graph, observations: [obs("runtime", "failed")], previous: [] };
    const atOne = correlate(input, new Date("2026-08-25T04:00:00.000Z"));
    const atTwo = correlate(input, new Date("2026-08-25T04:00:01.000Z"));
    expect(atOne.incidents[0].updatedAt).toBe("2026-08-25T04:00:00.000Z");
    expect(atTwo.incidents[0].updatedAt).toBe("2026-08-25T04:00:01.000Z");
  });
});
