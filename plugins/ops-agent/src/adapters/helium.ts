/** Read-only observations of Helium's own liveness and safety planes. */
import type { Observation } from "@helium/core";
import { ageState, makeObservation, type AdapterContext } from "./shared.js";

interface TimedHeartbeat {
  at?: string;
  maxAgeMs: number;
}

export interface HeliumSnapshot extends AdapterContext {
  processRunning: boolean;
  globalHeartbeat: TimedHeartbeat;
  expectedTenantManifestRef: string;
  expectedTenants: readonly string[];
  tenantHeartbeats: Readonly<Record<string, string>>;
  tenantMaxAgeMs: number;
  tenantMaxAgeMsByTenant?: Readonly<Record<string, number>>;
  collectorHeartbeat: TimedHeartbeat;
  deadMan: TimedHeartbeat & { armed: boolean };
}

export function adaptHelium(snapshot: HeliumSnapshot): Observation[] {
  const observations: Observation[] = [
    makeObservation(snapshot, {
      componentId: "helium",
      probeId: "helium.process.v1",
      state: snapshot.processRunning ? "ok" : "failed",
      dimension: "liveness",
      value: { running: snapshot.processRunning },
    }),
    makeObservation(snapshot, {
      componentId: "helium",
      probeId: "helium.global-heartbeat.v1",
      state: ageState(snapshot.globalHeartbeat.at, snapshot.observedAt, {
        failedAfterMs: snapshot.globalHeartbeat.maxAgeMs,
      }),
      dimension: "freshness",
      value: { at: snapshot.globalHeartbeat.at },
    }),
  ];

  for (const tenant of snapshot.expectedTenants) {
    const at = snapshot.tenantHeartbeats[tenant];
    observations.push(
      makeObservation(snapshot, {
        componentId: "helium",
        probeId: `helium.tenant.${tenant}.v1`,
        state:
          at === undefined
            ? "failed"
            : ageState(at, snapshot.observedAt, {
                failedAfterMs:
                  snapshot.tenantMaxAgeMsByTenant?.[tenant] ?? snapshot.tenantMaxAgeMs,
              }),
        dimension: "freshness",
        value: { tenant, at, manifestRef: snapshot.expectedTenantManifestRef },
      }),
    );
  }

  observations.push(
    makeObservation(snapshot, {
      componentId: "helium",
      probeId: "helium.collector-freshness.v1",
      state: ageState(snapshot.collectorHeartbeat.at, snapshot.observedAt, {
        failedAfterMs: snapshot.collectorHeartbeat.maxAgeMs,
      }),
      dimension: "freshness",
      value: { at: snapshot.collectorHeartbeat.at },
    }),
    makeObservation(snapshot, {
      componentId: "helium",
      probeId: "helium.dead-man.v1",
      state: snapshot.deadMan.armed
        ? ageState(snapshot.deadMan.at, snapshot.observedAt, {
            failedAfterMs: snapshot.deadMan.maxAgeMs,
          })
        : "failed",
      dimension: "controller",
      value: { armed: snapshot.deadMan.armed, at: snapshot.deadMan.at },
    }),
  );
  return observations;
}
