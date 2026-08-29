import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { adaptLivewire } from "./livewire.js";

const NOW = "2026-08-25T03:12:00.000Z";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../evals/fixtures/ops/${name}`, import.meta.url)),
      "utf8",
    ),
  );

const base = () => ({
  observedAt: NOW,
  ttlMs: 300_000,
  sourceVersion: "livewire-fixture/1",
  evidenceRefs: ["artifact://ops-fixture/livewire/raw-snapshot.json"],
  status: { found: true, coverageAt: "2026-08-25T03:10:00.000Z", intradayCoverage: 1 },
  sourceLogs: {
    dailyAt: "2026-08-25T03:11:00.000Z",
    intradayAt: "2026-08-25T03:11:30.000Z",
  },
  parquet: { valid: true },
  ibAvailable: true,
  expectedCoverageAt: "2026-08-25T03:12:00.000Z",
  freshness: { degradedAfterMs: 3_600_000, failedAfterMs: 86_400_000 },
});

describe("adaptLivewire", () => {
  it("reports a missing status-parser record unknown while current raw logs remain healthy", () => {
    const observations = adaptLivewire({
      ...base(),
      status: { found: false },
    });
    ObservationSchema.array().parse(observations);

    expect(observations.find((row) => row.probeId === "livewire.status-parser.v1")).toMatchObject({
      state: "unknown",
      value: { found: false, taskFailed: false },
    });
    expect(observations.find((row) => row.probeId === "livewire.coverage-freshness.v1")?.state).toBe("ok");
  });

  it("preserves the raw artifact references instead of inventing probe URIs", () => {
    const observations = adaptLivewire(base());
    expect(observations.every((row) =>
      JSON.stringify(row.evidenceRefs) ===
      JSON.stringify(["artifact://ops-fixture/livewire/raw-snapshot.json"]),
    )).toBe(true);
  });

  it("refuses an adapter snapshot with no raw evidence reference", () => {
    expect(() => adaptLivewire({ ...base(), evidenceRefs: [] })).toThrow(
      /evidence reference/,
    );
  });

  it("preserves the frozen Parquet case as an integrity failure that a restart does not address", () => {
    const frozen = fixture("livewire-parquet-corruption.json");
    const observations = adaptLivewire({
      ...base(),
      parquet: { valid: false, error: "invalid parquet footer" },
    });

    expect(frozen.expected.assertions.processRestartIsEligibleRepair).toBe("FAILED");
    expect(observations.find((row) => row.dimension === "integrity")).toMatchObject({
      state: "failed",
      value: {
        error: "invalid parquet footer",
        genericRestartAddressesFailure: false,
      },
    });
  });

  it("reports IB unavailability as an upstream degradation without granting restart authority", () => {
    const observations = adaptLivewire({ ...base(), ibAvailable: false });
    expect(observations.find((row) => row.dimension === "dependency")).toMatchObject({
      state: "degraded",
      value: { dependency: "ib", available: false, genericRestartAddressesFailure: false },
    });
  });

  it("keeps unmeasured integrity and dependency unknown, and preserves a measured bad status", () => {
    const observations = adaptLivewire({
      ...base(),
      status: { ...base().status, state: "failed" as const },
      parquet: { valid: undefined },
      ibAvailable: undefined,
    });

    expect(observations.find((row) => row.probeId === "livewire.status-parser.v1")?.state)
      .toBe("failed");
    expect(observations.find((row) => row.probeId === "livewire.parquet-integrity.v1")?.state)
      .toBe("unknown");
    expect(observations.find((row) => row.probeId === "livewire.ib-dependency.v1")?.state)
      .toBe("unknown");
  });

  it("classifies coverage age against the configured trading-calendar thresholds", () => {
    const degraded = adaptLivewire({
      ...base(),
      status: { found: true, coverageAt: "2026-08-25T01:12:00.000Z", intradayCoverage: 1 },
    });
    const failed = adaptLivewire({
      ...base(),
      status: { found: true, coverageAt: "2026-08-23T03:12:00.000Z", intradayCoverage: 0 },
    });

    expect(degraded.find((row) => row.probeId === "livewire.coverage-freshness.v1")?.state).toBe("degraded");
    expect(failed.find((row) => row.probeId === "livewire.coverage-freshness.v1")?.state).toBe("failed");
  });
});
