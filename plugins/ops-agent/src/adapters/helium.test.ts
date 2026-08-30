import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { adaptHelium } from "./helium.js";

const NOW = "2026-08-29T12:00:00.000Z";

const snapshot = () => ({
  observedAt: NOW,
  ttlMs: 300_000,
  sourceVersion: "helium-fixture/1",
  evidenceRefs: ["artifact://ops-fixture/helium/raw-snapshot.json"],
  processRunning: true,
  globalHeartbeat: { at: "2026-08-29T11:59:45.000Z", maxAgeMs: 60_000 },
  expectedTenantManifestRef: "artifact://helium/expected-tenants/v1",
  expectedTenants: ["macro", "research"],
  tenantHeartbeats: {
    macro: "2026-08-29T11:59:40.000Z",
    research: "2026-08-29T11:59:35.000Z",
  },
  tenantMaxAgeMs: 60_000,
  collectorHeartbeat: { at: "2026-08-29T11:59:50.000Z", maxAgeMs: 60_000 },
  deadMan: { armed: true, at: "2026-08-29T11:59:30.000Z", maxAgeMs: 60_000 },
});

describe("adaptHelium", () => {
  it("emits process, global heartbeat, each expected tenant, collector and dead-man state", () => {
    const observations = adaptHelium(snapshot());
    ObservationSchema.array().parse(observations);
    expect(observations.map((row) => row.probeId)).toEqual([
      "helium.process.v1",
      "helium.global-heartbeat.v1",
      "helium.tenant.macro.v1",
      "helium.tenant.research.v1",
      "helium.collector-freshness.v1",
      "helium.dead-man.v1",
    ]);
    expect(observations.every((row) => row.state === "ok")).toBe(true);
  });

  it("fails a missing expected tenant without inventing another tenant inventory", () => {
    const observations = adaptHelium({
      ...snapshot(),
      tenantHeartbeats: { macro: "2026-08-29T11:59:40.000Z" },
    });
    expect(observations.find((row) => row.probeId === "helium.tenant.research.v1")).toMatchObject({
      state: "failed",
      value: { manifestRef: "artifact://helium/expected-tenants/v1" },
    });
  });

  it("keeps collector and dead-man failures independent of the main process", () => {
    const observations = adaptHelium({
      ...snapshot(),
      collectorHeartbeat: { at: "2026-08-29T11:00:00.000Z", maxAgeMs: 60_000 },
      deadMan: { armed: false, at: "2026-08-29T11:59:30.000Z", maxAgeMs: 60_000 },
    });
    expect(observations.find((row) => row.probeId === "helium.process.v1")?.state).toBe("ok");
    expect(observations.find((row) => row.probeId === "helium.collector-freshness.v1")?.state).toBe("failed");
    expect(observations.find((row) => row.probeId === "helium.dead-man.v1")?.state).toBe("failed");
  });

  it("uses each tenant's declared heartbeat cadence", () => {
    const observations = adaptHelium({
      ...snapshot(),
      expectedTenants: ["macro", "canary"],
      tenantHeartbeats: {
        macro: "2026-08-29T11:59:40.000Z",
        canary: "2026-08-29T06:00:00.000Z",
      },
      tenantMaxAgeMs: 60_000,
      tenantMaxAgeMsByTenant: { macro: 60_000, canary: 13 * 3_600_000 },
    });

    expect(observations.find((row) => row.probeId === "helium.tenant.macro.v1")?.state)
      .toBe("ok");
    expect(observations.find((row) => row.probeId === "helium.tenant.canary.v1")?.state)
      .toBe("ok");
  });

  it("does not accept a future tenant heartbeat as fresh", () => {
    const observations = adaptHelium({
      ...snapshot(),
      expectedTenants: ["macro"],
      tenantHeartbeats: { macro: "2026-08-29T12:05:00.000Z" },
    });
    expect(observations.find((row) => row.probeId === "helium.tenant.macro.v1")?.state)
      .toBe("unknown");
  });
});
