import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { COLIMA_READ_COMMANDS, adaptColima } from "./colima.js";

const NOW = "2026-08-25T03:02:34.000Z";
const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../evals/fixtures/ops/colima-operator-recovery.json", import.meta.url)),
    "utf8",
  ),
);

const snapshot = () => ({
  observedAt: NOW,
  ttlMs: 300_000,
  sourceVersion: "colima-fixture/1",
  evidenceRefs: ["artifact://ops-fixture/colima/raw-snapshot.json"],
  hostSocketAvailable: true,
  guestRuntimeReady: true,
  vmState: "running" as const,
  expectedContainers: ["a", "b"],
  containers: [
    { name: "a", restartCount: 0, oomKilled: false },
    { name: "b", restartCount: 0, oomKilled: false },
  ],
});

describe("adaptColima", () => {
  it("declares only exact, read-only command argv", () => {
    expect(COLIMA_READ_COMMANDS).toEqual({
      status: ["colima", "status", "--json"],
      inventory: ["docker", "ps", "--no-trunc", "--format", "{{json .}}"],
      inspect: ["docker", "inspect", "--type", "container"],
    });
    expect(JSON.stringify(COLIMA_READ_COMMANDS)).not.toMatch(/\b(?:restart|start|stop|rm)\b|sh -c/i);
  });

  it("emits socket, guest runtime, VM, inventory, restart and OOM observations", () => {
    const observations = adaptColima(snapshot());
    ObservationSchema.array().parse(observations);
    expect(observations.map((row) => row.probeId)).toEqual([
      "colima.host-socket.v1",
      "colima.guest-runtime.v1",
      "colima.vm-state.v1",
      "colima.container-inventory.v1",
      "colima.restart-count.v1",
      "colima.oom-state.v1",
    ]);
    expect(observations.every((row) => row.state === "ok")).toBe(true);
  });

  it("does not rewrite failed automation as success when inventory later becomes healthy", () => {
    const observations = adaptColima({ ...snapshot(), watchdogOutcome: "recovery_exhausted" });
    expect(frozen.expected.assertions.automaticRecovery).toBe("FAILED");
    expect(frozen.expected.attribution).toBe("operator");
    expect(observations.find((row) => row.probeId === "colima.watchdog-outcome.v1")).toMatchObject({
      state: "failed",
      value: { watchdogOutcome: "recovery_exhausted", automaticRecoverySucceeded: false },
    });
    expect(observations.find((row) => row.probeId === "colima.container-inventory.v1")?.state).toBe("ok");
  });
});
