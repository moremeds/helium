import type { Observation, ObservationState } from "@helium/core";

export interface AdapterContext {
  observedAt: string;
  ttlMs: number;
  sourceVersion: string;
}

export function makeObservation(
  context: AdapterContext,
  fields: {
    componentId: string;
    probeId: string;
    state: ObservationState;
    dimension: string;
    value: Record<string, unknown>;
  },
): Observation {
  const observedAtMs = Date.parse(context.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("invalid observedAt");
  if (!Number.isInteger(context.ttlMs) || context.ttlMs <= 0) {
    throw new Error("ttlMs must be a positive integer");
  }
  return {
    version: 1,
    id: `obs-${fields.probeId.replace(/\.v\d+$/, "")}-${observedAtMs}`,
    componentId: fields.componentId,
    probeId: fields.probeId,
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + context.ttlMs).toISOString(),
    state: fields.state,
    dimension: fields.dimension,
    value: { ...fields.value, sourceVersion: context.sourceVersion },
    evidenceRefs: [`artifact://probe/${fields.probeId}/${observedAtMs}`],
    parserVersion: `${fields.probeId.replace(/\.v\d+$/, "")}/1`,
  };
}

export function ageState(
  timestamp: string | undefined,
  at: string,
  thresholds: { degradedAfterMs?: number; failedAfterMs: number },
): ObservationState {
  if (timestamp === undefined) return "unknown";
  const sampleMs = Date.parse(timestamp);
  const atMs = Date.parse(at);
  if (!Number.isFinite(sampleMs) || !Number.isFinite(atMs)) return "unknown";
  const ageMs = Math.max(0, atMs - sampleMs);
  if (ageMs > thresholds.failedAfterMs) return "failed";
  if (
    thresholds.degradedAfterMs !== undefined &&
    ageMs > thresholds.degradedAfterMs
  ) {
    return "degraded";
  }
  return "ok";
}

export function independentlyVerifiedState(
  reportedHealthy: boolean,
  independentlyVerified: boolean,
): ObservationState {
  if (!independentlyVerified) return "unknown";
  return reportedHealthy ? "ok" : "failed";
}
