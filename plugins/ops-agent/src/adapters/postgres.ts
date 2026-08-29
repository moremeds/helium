/** Read-only PostgreSQL health and durability observations. */
import type { Observation, ObservationState } from "@helium/core";
import { ageState, makeObservation, type AdapterContext } from "./shared.js";

const readOnly = (query: string): string =>
  `BEGIN READ ONLY; SET LOCAL statement_timeout = '2s'; ${query}; COMMIT;`;

export const POSTGRES_READ_PROBES = {
  isReady: ["pg_isready", "--quiet"],
  sql: {
    selectOne: readOnly("SELECT 1"),
    connectionPressure: readOnly("SELECT count(*) AS used FROM pg_stat_activity"),
    locks: readOnly("SELECT count(*) AS blocked FROM pg_locks WHERE NOT granted"),
    databaseGrowth: readOnly("SELECT sum(pg_database_size(datname)) AS bytes FROM pg_database"),
  },
} as const;

export type BackupIntegrityTier = "unchecked" | "header" | "gzip-tested" | "failed";

export interface PostgresSnapshot extends AdapterContext {
  isReady: boolean;
  selectOne: { ok: boolean; latencyMs: number; failedAfterMs: number };
  connections: { used: number; max: number; degradedRatio: number; failedRatio: number };
  locks: { blockedCount: number; oldestMs: number; failedAfterMs: number };
  database: { bytes: number; deltaBytes: number; intervalMs: number };
  backup: {
    createdAt?: string;
    maxAgeMs: number;
    metadataValid: boolean;
    integrityTier: BackupIntegrityTier;
  };
  launchOwnership: { expectedOwner: string; actualOwner?: string };
}

function connectionState(snapshot: PostgresSnapshot["connections"]): ObservationState {
  if (snapshot.max <= 0) return "unknown";
  const ratio = snapshot.used / snapshot.max;
  if (ratio >= snapshot.failedRatio) return "failed";
  return ratio >= snapshot.degradedRatio ? "degraded" : "ok";
}

function backupState(snapshot: PostgresSnapshot): ObservationState {
  const freshness = ageState(snapshot.backup.createdAt, snapshot.observedAt, {
    failedAfterMs: snapshot.backup.maxAgeMs,
  });
  if (!snapshot.backup.metadataValid || snapshot.backup.integrityTier === "failed") return "failed";
  if (freshness !== "ok") return freshness;
  return snapshot.backup.integrityTier === "unchecked" ? "degraded" : "ok";
}

export function adaptPostgres(snapshot: PostgresSnapshot): Observation[] {
  const locksState =
    snapshot.locks.blockedCount === 0
      ? "ok"
      : snapshot.locks.oldestMs >= snapshot.locks.failedAfterMs
        ? "failed"
        : "degraded";
  const ownershipState =
    snapshot.launchOwnership.actualOwner === undefined
      ? "unknown"
      : snapshot.launchOwnership.actualOwner === snapshot.launchOwnership.expectedOwner
        ? "ok"
        : "failed";
  return [
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.pg-isready.v1",
      state: snapshot.isReady ? "ok" : "failed",
      dimension: "readiness",
      value: { ready: snapshot.isReady },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.select-one.v1",
      state: snapshot.selectOne.ok && snapshot.selectOne.latencyMs <= snapshot.selectOne.failedAfterMs ? "ok" : "failed",
      dimension: "readiness",
      value: { ...snapshot.selectOne },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.connection-pressure.v1",
      state: connectionState(snapshot.connections),
      dimension: "capacity",
      value: { ...snapshot.connections },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.locks.v1",
      state: locksState,
      dimension: "contention",
      value: { ...snapshot.locks },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.database-growth.v1",
      state: snapshot.database.intervalMs > 0 ? "ok" : "unknown",
      dimension: "capacity",
      value: { ...snapshot.database },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.backup.v1",
      state: backupState(snapshot),
      dimension: "durability",
      value: { ...snapshot.backup },
    }),
    makeObservation(snapshot, {
      componentId: "postgres",
      probeId: "postgres.launch-ownership.v1",
      state: ownershipState,
      dimension: "controller",
      value: { ...snapshot.launchOwnership },
    }),
  ];
}
