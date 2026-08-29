import {
  DependencyGraph,
  correlate,
  reconcileOnStartup,
  type ComponentSpec,
  type Incident,
  type Observation,
} from "@helium/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runControllerScenario } from "@helium/ops-controller-fixture";
import {
  AlertManager,
  adaptArgon,
  adaptLivewire,
  launchdControllerProbe,
} from "dsh-plugin-ops-agent";
import { fakeLaunchctl, sequencedLaunchctl } from "../../plugins/ops-agent/src/testing/fake-launchctl.js";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-08-30T00:00:00.000Z");

const component = (
  id: string,
  owner: "opsd" | "external" | "none" = "opsd",
): ComponentSpec => ({
  version: 1,
  id,
  kind: "service",
  dimensions: ["readiness"],
  mutationOwner: {
    owner,
    competingLabels: ["legacy.controller"],
    changedAt: "2026-08-29T00:00:00.000Z",
    changeRef: "artifact://ownership/fixture",
  },
});

const observation = (
  componentId: string,
  state: Observation["state"],
): Observation => ({
  version: 1,
  id: `obs-${componentId}-${state}`,
  componentId,
  probeId: `${componentId}.readiness.v1`,
  observedAt: "2026-08-29T23:59:00.000Z",
  expiresAt: "2026-08-30T00:04:00.000Z",
  state,
  dimension: "readiness",
  evidenceRefs: [`artifact://fixture/${componentId}`],
  parserVersion: "fixture/1",
});

const incident = (overrides: Partial<Incident> = {}): Incident => ({
  key: "runtime|readiness|failed|runtime",
  rootComponentId: "runtime",
  symptomComponentIds: [],
  dimension: "readiness",
  failureClass: "failed",
  state: "action-eligible",
  observationIds: ["obs-runtime-failed"],
  openedAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...overrides,
});

describe("adversarial observation and incident contracts", () => {
  it("does not let HTTP 200 hide stale product data", () => {
    const rows = adaptArgon({
      observedAt: NOW.toISOString(),
      ttlMs: 300_000,
      sourceVersion: "contract/1",
      evidenceRefs: ["artifact://raw/argon"],
      api: { httpStatus: 200, bodyOk: true },
      database: { ready: true },
      worker: { heartbeatAt: NOW.toISOString(), maxAgeMs: 60_000 },
      product: { freshAt: "2026-08-20T00:00:00.000Z", maxAgeMs: 60_000 },
      backup: { createdAt: NOW.toISOString(), maxAgeMs: 60_000 },
    });
    expect(rows.find((row) => row.dimension === "liveness")?.state).toBe("ok");
    expect(rows.find((row) => row.probeId === "argon.product-freshness.v1")?.state).toBe("failed");
  });

  it("surfaces parser drift and refuses a generic restart for corrupt Parquet", () => {
    const rows = adaptLivewire({
      observedAt: NOW.toISOString(),
      ttlMs: 300_000,
      sourceVersion: "contract/1",
      evidenceRefs: ["artifact://raw/livewire"],
      status: { found: true, coverageAt: "2026-08-20T00:00:00.000Z", intradayCoverage: 0 },
      sourceLogs: { dailyAt: "2026-08-29T23:59:00.000Z", intradayAt: "2026-08-29T23:59:00.000Z" },
      parquet: { valid: false, error: "invalid footer" },
      ibAvailable: true,
      expectedCoverageAt: NOW.toISOString(),
      freshness: { degradedAfterMs: 60_000, failedAfterMs: 120_000 },
    });
    expect(rows.find((row) => row.probeId === "livewire.coverage-freshness.v1")?.state).toBe("failed");
    expect(rows.find((row) => row.dimension === "integrity")).toMatchObject({
      state: "failed",
      value: { genericRestartAddressesFailure: false },
    });
  });

  it("groups a parent failure into one incident instead of an alert storm", () => {
    const graph = DependencyGraph.from(
      [component("runtime"), component("api-a"), component("api-b")],
      [
        { from: "api-a", to: "runtime" },
        { from: "api-b", to: "runtime" },
      ],
    );
    const result = correlate(
      {
        graph,
        observations: [
          observation("runtime", "failed"),
          observation("api-a", "failed"),
          observation("api-b", "failed"),
        ],
        previous: [],
      },
      NOW,
    );
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({
      rootComponentId: "runtime",
      symptomComponentIds: ["api-a", "api-b"],
    });
  });
});

describe("ownership, provider and delivery failures", () => {
  it.each([
    { exitCode: 1, stdout: "", timedOut: false, truncated: false },
    { exitCode: 0, stdout: "", timedOut: true, truncated: false },
    { exitCode: 0, stdout: "PID\tStatus\tLabel\nbad", timedOut: false, truncated: false },
    { exitCode: 0, stdout: "PID\tStatus\tLabel", timedOut: false, truncated: true },
  ])("refuses mutation when controller enumeration is unverifiable", async (script) => {
    const result = await launchdControllerProbe({
      launchctl: fakeLaunchctl({ ...script, evidenceRef: "artifact://controller/failure" }),
    }).check(component("runtime"));
    expect(result).toMatchObject({ result: "unknown", evidenceRef: "artifact://controller/failure" });
  });

  it("sees a legacy controller that appears at the final pre-spawn enumeration", async () => {
    const probe = launchdControllerProbe({
      launchctl: sequencedLaunchctl([[], ["legacy.controller"]]),
    });
    expect((await probe.check(component("runtime"))).result).toBe("clear");
    expect((await probe.check(component("runtime")))).toMatchObject({
      result: "competing",
      observedLabels: ["legacy.controller"],
    });
  });

  it("runs the real controller baseline before its final rival check and records no intent", async () => {
    const result = await runControllerScenario({
      stateDir: mkdtempSync(join(tmpdir(), "helium-contract-late-rival-")),
      lateRival: true,
    });
    expect(result.tick.actions[0]).toMatchObject({
      disposition: "observe",
      reason: "competing-controller",
    });
    expect(result.sideEffects).toBe(0);
    expect(result.events.map((event) => event.type)).not.toContain("action-intent-recorded");
  });

  it("keeps the deterministic side effect available when all provider quota domains are exhausted", async () => {
    const result = await runControllerScenario({
      stateDir: mkdtempSync(join(tmpdir(), "helium-contract-provider-outage-")),
      providerQuota: { codex: "quota-exhausted", deepseek: "quota-exhausted", claude: "quota-exhausted" },
    });
    expect(result.tick.actions[0]).toMatchObject({ outcome: "succeeded" });
    expect(result.sideEffects).toBe(1);
    expect(result.providerCalls).toBe(0);
  });

  it("suppresses spawn when an operator repairs the target before the baseline", async () => {
    const result = await runControllerScenario({
      stateDir: mkdtempSync(join(tmpdir(), "helium-contract-not-needed-")),
      baselinePassing: true,
    });
    expect(result.tick.actions[0]).toMatchObject({ outcome: "not-needed" });
    expect(result.sideEffects).toBe(0);
    expect(result.events.map((event) => event.type)).not.toContain("action-intent-recorded");
  });

  it("does not take automatic credit when operator and controller act concurrently", async () => {
    const result = await runControllerScenario({
      stateDir: mkdtempSync(join(tmpdir(), "helium-contract-operator-race-")),
      operatorDuringExecution: true,
    });
    expect(result.tick.actions[0]).toMatchObject({ outcome: "superseded-by-operator" });
    expect(Object.values(result.state.actions)[0]).toMatchObject({
      attribution: "operator",
      state: "superseded-by-operator",
    });
  });

  it("turns alert delivery failure into an incident and never requests recovery", async () => {
    const alerts = new AlertManager({
      forMs: 0,
      delivery: { async deliver() { throw new Error("channel unavailable"); } },
    });
    const result = await alerts.evaluate(
      {
        incident: incident(),
        severity: "critical",
        impact: "runtime unavailable",
        inhibitedSymptoms: [],
        nextDecision: "operator review",
      },
      NOW,
    );
    expect(result).toMatchObject({
      emitted: false,
      deliveryIncident: { rootComponentId: "alert-delivery" },
      recoveryActionRequested: false,
    });
  });

  it("attributes a Colima recovery after a recorded operator action to the operator", () => {
    const [decision] = reconcileOnStartup({
      actions: [{
        actionId: "act-1", incidentId: "inc-1", componentId: "colima", sopId: "restart",
        sopDigest: `sha256:${"a".repeat(64)}`, state: "intent-recorded",
      }],
      evidence: {
        "act-1": {
          intentRecorded: true,
          baselineAllPassing: false,
          postconditions: "pass",
          operatorConfirmed: true,
        },
      },
    });
    expect(decision).toMatchObject({
      outcome: "superseded-by-operator",
      attribution: "operator",
      automationCredit: false,
      rerun: false,
    });
  });
});
