import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core";
import { adaptApex } from "./apex.js";

const NOW = "2026-08-25T03:25:00.000Z";
const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../evals/fixtures/ops/apex-healthy.json", import.meta.url)),
    "utf8",
  ),
);

const snapshot = () => ({
  observedAt: NOW,
  ttlMs: 300_000,
  sourceVersion: "apex-fixture/1",
  api: { httpStatus: 200, bodyOk: true },
  postgres: { reportedHealthy: true, independentlyVerified: true },
  livewire: {
    reportedRevisionMatches: true,
    reportedRecencyHealthy: true,
    independentlyVerified: true,
  },
  mount: { reportedAvailable: true, independentlyVerified: true },
});

describe("adaptApex", () => {
  it("emits API, database, upstream revision/recency and mount observations", () => {
    const observations = adaptApex(snapshot());
    ObservationSchema.array().parse(observations);
    expect(observations.map((row) => row.probeId)).toEqual([
      "apex.http-health.v1",
      "apex.postgres-dependency.v1",
      "apex.livewire-revision.v1",
      "apex.livewire-recency.v1",
      "apex.mount-dependency.v1",
    ]);
    expect(observations.every((row) => row.state === "ok")).toBe(true);
  });

  it("does not promote a healthy self-report to independent dependency proof", () => {
    const observations = adaptApex({
      ...snapshot(),
      postgres: { reportedHealthy: true, independentlyVerified: false },
      livewire: {
        reportedRevisionMatches: true,
        reportedRecencyHealthy: true,
        independentlyVerified: false,
      },
      mount: { reportedAvailable: true, independentlyVerified: false },
    });

    expect(frozen.expected.assertions.dependenciesIndependentlyVerified).toBe("PARTIAL");
    expect(observations.slice(1).map((row) => row.state)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
});
