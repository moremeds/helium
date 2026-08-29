/** Read-only transformation of Apex and independently probed dependencies. */
import type { Observation } from "@helium/core";
import {
  independentlyVerifiedState,
  makeObservation,
  type AdapterContext,
} from "./shared.js";

export interface ApexSnapshot extends AdapterContext {
  api: { httpStatus: number; bodyOk: boolean };
  postgres: { reportedHealthy: boolean; independentlyVerified: boolean };
  livewire: {
    reportedRevisionMatches: boolean;
    reportedRecencyHealthy: boolean;
    independentlyVerified: boolean;
  };
  mount: { reportedAvailable: boolean; independentlyVerified: boolean };
}

export function adaptApex(snapshot: ApexSnapshot): Observation[] {
  const apiHealthy =
    snapshot.api.httpStatus >= 200 &&
    snapshot.api.httpStatus < 300 &&
    snapshot.api.bodyOk;
  return [
    makeObservation(snapshot, {
      componentId: "apex",
      probeId: "apex.http-health.v1",
      state: apiHealthy ? "ok" : "failed",
      dimension: "readiness",
      value: { ...snapshot.api },
    }),
    makeObservation(snapshot, {
      componentId: "apex",
      probeId: "apex.postgres-dependency.v1",
      state: independentlyVerifiedState(
        snapshot.postgres.reportedHealthy,
        snapshot.postgres.independentlyVerified,
      ),
      dimension: "dependency",
      value: { ...snapshot.postgres },
    }),
    makeObservation(snapshot, {
      componentId: "apex",
      probeId: "apex.livewire-revision.v1",
      state: independentlyVerifiedState(
        snapshot.livewire.reportedRevisionMatches,
        snapshot.livewire.independentlyVerified,
      ),
      dimension: "dependency",
      value: {
        reportedRevisionMatches: snapshot.livewire.reportedRevisionMatches,
        independentlyVerified: snapshot.livewire.independentlyVerified,
      },
    }),
    makeObservation(snapshot, {
      componentId: "apex",
      probeId: "apex.livewire-recency.v1",
      state: independentlyVerifiedState(
        snapshot.livewire.reportedRecencyHealthy,
        snapshot.livewire.independentlyVerified,
      ),
      dimension: "freshness",
      value: {
        reportedRecencyHealthy: snapshot.livewire.reportedRecencyHealthy,
        independentlyVerified: snapshot.livewire.independentlyVerified,
      },
    }),
    makeObservation(snapshot, {
      componentId: "apex",
      probeId: "apex.mount-dependency.v1",
      state: independentlyVerifiedState(
        snapshot.mount.reportedAvailable,
        snapshot.mount.independentlyVerified,
      ),
      dimension: "dependency",
      value: { ...snapshot.mount },
    }),
  ];
}
