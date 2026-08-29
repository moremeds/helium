/** Read-only transformation of Argon service and durability artifacts. */
import type { Observation, ObservationState } from "@helium/core";
import { ageState, makeObservation, type AdapterContext } from "./shared.js";

export interface ArgonSnapshot extends AdapterContext {
  api: { httpStatus: number; bodyOk?: boolean };
  database: { ready: boolean };
  worker: { heartbeatAt?: string; heartbeatAgeMs?: number; maxAgeMs: number };
  product: { freshAt?: string; maxAgeMs: number };
  backup: { createdAt?: string; maxAgeMs: number };
}

const bodyState = (value: boolean | undefined): ObservationState =>
  value === undefined ? "unknown" : value ? "ok" : "failed";

export function adaptArgon(snapshot: ArgonSnapshot): Observation[] {
  const at = snapshot.observedAt;
  const workerState = snapshot.worker.heartbeatAgeMs === undefined
    ? ageState(snapshot.worker.heartbeatAt, at, { failedAfterMs: snapshot.worker.maxAgeMs })
    : !Number.isFinite(snapshot.worker.heartbeatAgeMs) || snapshot.worker.heartbeatAgeMs < 0
      ? "unknown"
      : snapshot.worker.heartbeatAgeMs > snapshot.worker.maxAgeMs
        ? "failed"
        : "ok";
  return [
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.http-liveness.v1",
      state: snapshot.api.httpStatus >= 200 && snapshot.api.httpStatus < 500 ? "ok" : "failed",
      dimension: "liveness",
      value: { httpStatus: snapshot.api.httpStatus },
    }),
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.body-readiness.v1",
      state: bodyState(snapshot.api.bodyOk),
      dimension: "readiness",
      value: { ok: snapshot.api.bodyOk },
    }),
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.database-readiness.v1",
      state: snapshot.database.ready ? "ok" : "failed",
      dimension: "dependency",
      value: { ready: snapshot.database.ready },
    }),
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.worker-heartbeat.v1",
      state: workerState,
      dimension: "freshness",
      value: {
        heartbeatAt: snapshot.worker.heartbeatAt,
        heartbeatAgeMs: snapshot.worker.heartbeatAgeMs,
      },
    }),
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.product-freshness.v1",
      state: ageState(snapshot.product.freshAt, at, { failedAfterMs: snapshot.product.maxAgeMs }),
      dimension: "freshness",
      value: { freshAt: snapshot.product.freshAt },
    }),
    makeObservation(snapshot, {
      componentId: "argon",
      probeId: "argon.backup-freshness.v1",
      state: ageState(snapshot.backup.createdAt, at, { failedAfterMs: snapshot.backup.maxAgeMs }),
      dimension: "durability",
      value: { createdAt: snapshot.backup.createdAt },
    }),
  ];
}
