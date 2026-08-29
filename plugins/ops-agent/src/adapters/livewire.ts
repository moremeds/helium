/** Read-only transformation of Livewire probe artifacts. */
import type { Observation } from "@helium/core";
import { ageState, makeObservation, type AdapterContext } from "./shared.js";

export interface LivewireSnapshot extends AdapterContext {
  status: {
    found: boolean;
    state?: "ok" | "degraded" | "failed" | "unknown";
    coverageAt?: string;
    intradayCoverage?: number;
  };
  sourceLogs: { dailyAt?: string; intradayAt?: string };
  parquet: { valid?: boolean; error?: string };
  ibAvailable?: boolean;
  expectedCoverageAt: string;
  freshness: { degradedAfterMs: number; failedAfterMs: number };
}

export function adaptLivewire(snapshot: LivewireSnapshot): Observation[] {
  const status = makeObservation(snapshot, {
    componentId: "livewire",
    probeId: "livewire.status-parser.v1",
    state: snapshot.status.found ? (snapshot.status.state ?? "ok") : "unknown",
    dimension: "freshness",
    value: {
      found: snapshot.status.found,
      taskFailed: false,
      coverageAt: snapshot.status.coverageAt,
      intradayCoverage: snapshot.status.intradayCoverage,
    },
  });

  const integrity = makeObservation(snapshot, {
    componentId: "livewire",
    probeId: "livewire.parquet-integrity.v1",
    state:
      snapshot.parquet.valid === undefined
        ? "unknown"
        : snapshot.parquet.valid
          ? "ok"
          : "failed",
    dimension: "integrity",
    value: {
      valid: snapshot.parquet.valid,
      error: snapshot.parquet.error,
      genericRestartAddressesFailure:
        snapshot.parquet.valid === undefined ? false : snapshot.parquet.valid,
    },
  });

  const dependency = makeObservation(snapshot, {
    componentId: "livewire",
    probeId: "livewire.ib-dependency.v1",
    state:
      snapshot.ibAvailable === undefined
        ? "unknown"
        : snapshot.ibAvailable
          ? "ok"
          : "degraded",
    dimension: "dependency",
    value: {
      dependency: "ib",
      available: snapshot.ibAvailable,
      genericRestartAddressesFailure: snapshot.ibAvailable === true,
    },
  });

  const rawLogTimes = [snapshot.sourceLogs.dailyAt, snapshot.sourceLogs.intradayAt]
    .filter((value): value is string => value !== undefined)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const coverageAt = snapshot.status.found
    ? snapshot.status.coverageAt
    : rawLogTimes[0];
  const freshnessState = ageState(coverageAt, snapshot.expectedCoverageAt, snapshot.freshness);
  const freshness = makeObservation(snapshot, {
    componentId: "livewire",
    probeId: "livewire.coverage-freshness.v1",
    state: freshnessState,
    dimension: "freshness",
    value: {
      coverageAt,
      expectedCoverageAt: snapshot.expectedCoverageAt,
      source: snapshot.status.found ? "status" : "raw-log",
    },
  });

  return [status, integrity, dependency, freshness];
}
