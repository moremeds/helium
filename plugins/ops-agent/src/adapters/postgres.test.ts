import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { POSTGRES_READ_PROBES, adaptPostgres } from "./postgres.js";

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
  sourceVersion: "postgres-fixture/1",
  isReady: true,
  selectOne: { ok: true, latencyMs: 8, failedAfterMs: 1_000 },
  connections: { used: 20, max: 100, degradedRatio: 0.8, failedRatio: 0.95 },
  locks: { blockedCount: 0, oldestMs: 0, failedAfterMs: 60_000 },
  database: { bytes: 1_000_000, deltaBytes: 1_000, intervalMs: 60_000 },
  backup: {
    createdAt: "2026-08-25T02:20:00.000Z",
    maxAgeMs: 86_400_000,
    metadataValid: true,
    integrityTier: "header" as const,
  },
  launchOwnership: { expectedOwner: "launchd", actualOwner: "launchd" },
});

describe("adaptPostgres", () => {
  it("pins exact argv and bounded read-only SQL", () => {
    expect(POSTGRES_READ_PROBES.isReady).toEqual(["pg_isready", "--quiet"]);
    for (const sql of Object.values(POSTGRES_READ_PROBES.sql)) {
      expect(sql).toContain("BEGIN READ ONLY");
      expect(sql).toContain("statement_timeout");
      expect(sql).not.toMatch(/\b(?:insert|update|delete|alter|drop|create|vacuum)\b/i);
    }
  });

  it("emits readiness, latency, pressure, locks, growth, backup and ownership separately", () => {
    const observations = adaptPostgres(snapshot());
    ObservationSchema.array().parse(observations);
    expect(observations.map((row) => row.probeId)).toEqual([
      "postgres.pg-isready.v1",
      "postgres.select-one.v1",
      "postgres.connection-pressure.v1",
      "postgres.locks.v1",
      "postgres.database-growth.v1",
      "postgres.backup.v1",
      "postgres.launch-ownership.v1",
    ]);
  });

  it("keeps a stale backup failed even while listener and SELECT 1 are healthy", () => {
    const observations = adaptPostgres({
      ...snapshot(),
      backup: {
        createdAt: "2026-07-23T00:00:00.000Z",
        maxAgeMs: 86_400_000,
        metadataValid: true,
        integrityTier: "unchecked" as const,
      },
    });
    expect(frozen.expected.assertions.listeningPortProvesBackupHealth).toBe("FAILED");
    expect(observations.find((row) => row.probeId === "postgres.pg-isready.v1")?.state).toBe("ok");
    expect(observations.find((row) => row.probeId === "postgres.select-one.v1")?.state).toBe("ok");
    expect(observations.find((row) => row.probeId === "postgres.backup.v1")).toMatchObject({
      state: "failed",
      value: { integrityTier: "unchecked" },
    });
  });
});
