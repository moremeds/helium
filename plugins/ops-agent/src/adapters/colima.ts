/** Read-only Colima and container-runtime observations. */
import type { Observation } from "@helium/core";
import { makeObservation, type AdapterContext } from "./shared.js";

export const COLIMA_READ_COMMANDS = {
  status: ["colima", "status", "--json"],
  inventory: ["docker", "ps", "--all", "--no-trunc", "--format", "{{json .}}"],
  inspect: ["docker", "inspect", "--type", "container"],
} as const;

export interface ColimaSnapshot extends AdapterContext {
  hostSocketAvailable: boolean;
  guestRuntimeReady: boolean;
  vmState: "running" | "stopped" | "unknown";
  expectedContainers: readonly string[];
  containers: readonly { name: string; restartCount: number; oomKilled: boolean }[];
  watchdogOutcome?: string;
}

export function adaptColima(snapshot: ColimaSnapshot): Observation[] {
  const running = new Set(snapshot.containers.map((container) => container.name));
  const missing = snapshot.expectedContainers.filter((name) => !running.has(name));
  const restarted = snapshot.containers.filter((container) => container.restartCount > 0);
  const oomKilled = snapshot.containers.filter((container) => container.oomKilled);
  const observations: Observation[] = [
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.host-socket.v1",
      state: snapshot.hostSocketAvailable ? "ok" : "failed",
      dimension: "readiness",
      value: { available: snapshot.hostSocketAvailable },
    }),
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.guest-runtime.v1",
      state: snapshot.guestRuntimeReady ? "ok" : "failed",
      dimension: "readiness",
      value: { ready: snapshot.guestRuntimeReady },
    }),
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.vm-state.v1",
      state: snapshot.vmState === "running" ? "ok" : snapshot.vmState === "stopped" ? "failed" : "unknown",
      dimension: "liveness",
      value: { vmState: snapshot.vmState },
    }),
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.container-inventory.v1",
      state: missing.length === 0 ? "ok" : "failed",
      dimension: "readiness",
      value: { expected: snapshot.expectedContainers, observed: [...running], missing },
    }),
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.restart-count.v1",
      state: restarted.length === 0 ? "ok" : "degraded",
      dimension: "stability",
      value: { restarted },
    }),
    makeObservation(snapshot, {
      componentId: "colima",
      probeId: "colima.oom-state.v1",
      state: oomKilled.length === 0 ? "ok" : "failed",
      dimension: "capacity",
      value: { oomKilled: oomKilled.map((container) => container.name) },
    }),
  ];

  if (snapshot.watchdogOutcome !== undefined) {
    observations.push(
      makeObservation(snapshot, {
        componentId: "colima",
        probeId: "colima.watchdog-outcome.v1",
        state: snapshot.watchdogOutcome === "recovery_exhausted" ? "failed" : "unknown",
        dimension: "controller",
        value: {
          watchdogOutcome: snapshot.watchdogOutcome,
          automaticRecoverySucceeded: false,
        },
      }),
    );
  }
  return observations;
}
