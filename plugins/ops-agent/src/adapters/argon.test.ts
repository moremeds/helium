import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { adaptArgon } from "./argon.js";

const NOW = "2026-08-25T03:20:00.000Z";
const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../evals/fixtures/ops/argon-backup-stale.json", import.meta.url)),
    "utf8",
  ),
);

const snapshot = () => ({
  observedAt: NOW,
  ttlMs: 300_000,
  sourceVersion: "argon-fixture/1",
  evidenceRefs: ["artifact://ops-fixture/argon/raw-snapshot.json"],
  api: { httpStatus: 200, bodyOk: true },
  database: { ready: true },
  worker: { heartbeatAt: "2026-08-25T03:19:30.000Z", maxAgeMs: 60_000 },
  product: { freshAt: "2026-08-25T03:19:00.000Z", maxAgeMs: 300_000 },
  backup: { createdAt: "2026-08-25T02:20:00.000Z", maxAgeMs: 86_400_000 },
});

describe("adaptArgon", () => {
  it("keeps HTTP liveness separate from the body .ok readiness contract", () => {
    const observations = adaptArgon({ ...snapshot(), api: { httpStatus: 200, bodyOk: false } });
    ObservationSchema.array().parse(observations);

    expect(observations.find((row) => row.probeId === "argon.http-liveness.v1")?.state).toBe("ok");
    expect(observations.find((row) => row.probeId === "argon.body-readiness.v1")?.state).toBe("failed");
  });

  it("emits independent database, worker, product and backup observations", () => {
    const observations = adaptArgon({
      ...snapshot(),
      database: { ready: false },
      worker: { heartbeatAt: "2026-08-25T03:00:00.000Z", maxAgeMs: 60_000 },
      product: { freshAt: "2026-08-24T03:20:00.000Z", maxAgeMs: 300_000 },
      backup: { createdAt: "2026-07-23T00:00:00.000Z", maxAgeMs: 86_400_000 },
    });
    const states = Object.fromEntries(observations.map((row) => [row.probeId, row.state]));

    expect(states).toMatchObject({
      "argon.database-readiness.v1": "failed",
      "argon.worker-heartbeat.v1": "failed",
      "argon.product-freshness.v1": "failed",
      "argon.backup-freshness.v1": "failed",
    });
    expect(frozen.expected.assertions.backupPipelineHealthy).toBe("FAILED");
  });
});
