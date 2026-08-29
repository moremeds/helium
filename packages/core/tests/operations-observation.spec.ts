import { describe, expect, it } from "vitest";
import {
  OBSERVATION_STATES,
  ObservationSchema,
} from "../src/operations/observation.js";

const observation = {
  version: 1,
  id: "obs-1",
  componentId: "fixture-service",
  probeId: "fixture.http.v1",
  observedAt: "2026-08-25T00:00:00.000Z",
  expiresAt: "2026-08-25T00:01:00.000Z",
  state: "unknown",
  dimension: "readiness",
  evidenceRefs: ["artifact://probe/1"],
  parserVersion: "fixture-http/1",
};

describe("ObservationSchema", () => {
  it("parses a complete observation", () => {
    expect(ObservationSchema.parse(observation).state).toBe("unknown");
  });

  it("admits exactly four states", () => {
    expect([...OBSERVATION_STATES]).toEqual([
      "ok",
      "degraded",
      "failed",
      "unknown",
    ]);
    for (const state of OBSERVATION_STATES) {
      expect(ObservationSchema.parse({ ...observation, state }).state).toBe(state);
    }
  });

  it("rejects a state outside the enum, however plausible the tool vocabulary", () => {
    // `healthy` and `recovery_exhausted` are real vendor words from the audited
    // incidents. They belong in `value`, not in `state`: a probe reporting a
    // state no policy code handles is how an incident goes unrouted.
    for (const state of ["healthy", "recovery_exhausted", "OK", ""]) {
      expect(() => ObservationSchema.parse({ ...observation, state })).toThrow();
    }
  });

  it("rejects any provider or model key", () => {
    expect(() =>
      ObservationSchema.parse({ ...observation, model: "forbidden" }),
    ).toThrow();
    expect(() =>
      ObservationSchema.parse({ ...observation, provider: "forbidden" }),
    ).toThrow();
    // `source` was the loose key the raw incident samples carried.
    expect(() =>
      ObservationSchema.parse({ ...observation, source: "watchdog" }),
    ).toThrow();
  });

  it("requires a parser version, so a reparse of old evidence is detectable", () => {
    const { parserVersion: _drop, ...without } = observation;
    expect(() => ObservationSchema.parse(without)).toThrow();
  });

  it("requires expiresAt strictly after observedAt", () => {
    expect(() =>
      ObservationSchema.parse({
        ...observation,
        expiresAt: observation.observedAt,
      }),
    ).toThrow(/expiresAt/);
    expect(() =>
      ObservationSchema.parse({
        ...observation,
        expiresAt: "2026-08-24T23:59:00.000Z",
      }),
    ).toThrow(/expiresAt/);
  });

  it("rejects a timestamp that is not ISO-8601 UTC", () => {
    for (const bad of ["2026-08-25", "2026-08-25 00:00:00", "not-a-date"]) {
      expect(() =>
        ObservationSchema.parse({ ...observation, observedAt: bad }),
      ).toThrow();
    }
  });

  it("keeps raw tool vocabulary in value, where no policy code branches on it", () => {
    const parsed = ObservationSchema.parse({
      ...observation,
      state: "failed",
      value: { watchdogOutcome: "recovery_exhausted" },
    });
    expect(parsed.value).toEqual({ watchdogOutcome: "recovery_exhausted" });
  });

  it("bounds opaque identifiers", () => {
    expect(() =>
      ObservationSchema.parse({ ...observation, componentId: "x".repeat(200) }),
    ).toThrow();
    expect(() =>
      ObservationSchema.parse({ ...observation, componentId: "" }),
    ).toThrow();
  });
});
