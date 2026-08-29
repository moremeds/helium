import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "../src/operations/observation.js";

const root = fileURLToPath(new URL("../../../evals/fixtures/ops", import.meta.url));
const required = [
  "apex-healthy.json",
  "argon-backup-stale.json",
  "colima-operator-recovery.json",
  "host-memory-pressure.json",
  "livewire-parquet-corruption.json",
  "livewire-parser-drift.json",
];

/** The canonical evidence vocabulary. A fixture may not invent a sixth value. */
const STATUSES = ["PLANNED", "PARTIAL", "PROVEN", "FAILED", "BLOCKED"];

/** Design section 6.2. `recovered` and `escalated` are incident states only. */
const INCIDENT_STATES = [
  "open",
  "diagnosing",
  "action-eligible",
  "recovering",
  "verifying",
  "recovered",
  "failed",
  "uncertain",
  "escalated",
];

/** Design section 6.5. Disjoint from the incident states above. */
const ACTION_OUTCOMES = [
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
];

describe("ops evidence fixtures", () => {
  it("contains exactly the required cases", () => {
    const files = readdirSync(root).filter((name) => name.endsWith(".json"));
    expect(files.sort()).toEqual(required);
  });

  it.each(required)("%s holds schema-valid observations", (name) => {
    const value = JSON.parse(readFileSync(join(root, name), "utf8"));
    expect(value).toMatchObject({
      fixtureVersion: 1,
      observedAt: expect.any(String),
      expected: expect.any(Object),
    });
    expect(Array.isArray(value.observations)).toBe(true);
    expect(value.observations.length).toBeGreaterThan(0);
    for (const raw of value.observations) {
      const parsed = ObservationSchema.parse(raw);
      expect(["ok", "degraded", "failed", "unknown"]).toContain(parsed.state);
    }
    expect(JSON.stringify(value)).not.toMatch(/100\.66\.|api[_-]?key|password/i);
  });

  // The plan's own reasoning -- "a contract that cannot fail is worse than no
  // contract" -- applies to `expected` too. `expect.any(Object)` above passes
  // for `{}`, and these fixtures are the only encoding of the two production
  // incidents this program exists to prevent, so the expectation block gets
  // checked rather than merely typed.
  it.each(required)("%s states an expectation that could fail", (name) => {
    const { expected } = JSON.parse(readFileSync(join(root, name), "utf8"));

    expect(Object.keys(expected).sort()).toEqual([
      "actionOutcome",
      "assertions",
      "attribution",
      "automaticRecoverySucceeded",
      "incidentTerminal",
    ]);

    // The two terminal keys are separate planes with disjoint vocabularies
    // (review XDOC-9): `recovered` and `escalated` are never action outcomes.
    if (expected.incidentTerminal !== null) {
      expect(INCIDENT_STATES).toContain(expected.incidentTerminal);
    }
    if (expected.actionOutcome !== null) {
      expect(ACTION_OUTCOMES).toContain(expected.actionOutcome);
    }
    expect(typeof expected.automaticRecoverySucceeded).toBe("boolean");

    const assertions = Object.entries(expected.assertions);
    expect(assertions.length).toBeGreaterThan(0);
    for (const [claim, status] of assertions) {
      expect(STATUSES, `${name}: ${claim}`).toContain(status);
    }
  });

  it("records the operator-recovery case as automation FAILED and attribution operator", () => {
    // The single most important thing these fixtures encode: time proximity is
    // not action provenance. A controller must never read "the target became
    // healthy" as "my action worked".
    const { expected } = JSON.parse(
      readFileSync(join(root, "colima-operator-recovery.json"), "utf8"),
    );
    expect(expected.automaticRecoverySucceeded).toBe(false);
    expect(expected.attribution).toBe("operator");
    expect(expected.actionOutcome).toBeNull();
    expect(expected.assertions.automaticRecovery).toBe("FAILED");
    expect(expected.assertions.finalDockerHealth).toBe("PROVEN");
  });

  it("records the integrity case as rejecting a generic process restart", () => {
    const { expected } = JSON.parse(
      readFileSync(join(root, "livewire-parquet-corruption.json"), "utf8"),
    );
    expect(expected.assertions.processRestartIsEligibleRepair).toBe("FAILED");
    expect(expected.assertions.targetedRepairRestoresIntegrity).toBe("BLOCKED");
  });
});
