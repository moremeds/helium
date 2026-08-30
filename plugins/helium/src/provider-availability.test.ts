import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityCatalog, ExecutionTargetId, type AgentResult } from "@helium/core";
import { ProviderAvailability } from "./provider-availability.js";

function catalog() {
  const value = new CapabilityCatalog();
  for (const id of ["target-a", "target-b", "target-c"]) {
    value.register({
      targetId: ExecutionTargetId(id),
      capabilities: ["analysis.general"],
      isolationClass: "process",
      operations: {},
      supports: {
        structuredOutput: true,
        toolIsolation: true,
        mutations: false,
      },
    });
  }
  return value;
}

const statePath = () =>
  join(mkdtempSync(join(tmpdir(), "helium-provider-availability-")), "state.json");

describe("ProviderAvailability", () => {
  it("fans a shared quota-domain update out atomically and preserves opaque hints", () => {
    const capabilities = catalog();
    const availability = new ProviderAvailability(capabilities, { statePath: statePath() });
    availability.registerDomain("shared-session", [
      ExecutionTargetId("target-a"),
      ExecutionTargetId("target-b"),
    ]);
    availability.registerDomain("other-session", [ExecutionTargetId("target-c")]);

    const changed = availability.publish("shared-session", {
      state: "quota-exhausted",
      retryAfter: "opaque-provider-reset-hint",
    });
    expect(changed.changed).toBe(true);
    const snapshot = capabilities.snapshot(new Date("2099-01-01T00:00:00Z"));
    expect(snapshot.targets.find((target) => target.targetId === "target-a")).toMatchObject({
      available: false,
      availability: { retryAfter: "opaque-provider-reset-hint" },
    });
    expect(snapshot.targets.find((target) => target.targetId === "target-b")?.available).toBe(false);
    expect(snapshot.targets.find((target) => target.targetId === "target-c")?.available).toBe(true);
  });

  it("is content-versioned and idempotent, and only an explicit refresh restores", () => {
    const capabilities = catalog();
    const availability = new ProviderAvailability(capabilities, { statePath: statePath() });
    availability.registerDomain("shared-session", [ExecutionTargetId("target-a")]);
    const first = availability.publish("shared-session", { state: "unavailable" });
    const duplicate = availability.publish("shared-session", { state: "unavailable" });
    expect(duplicate).toEqual({ changed: false, snapshot: first.snapshot });
    expect(capabilities.snapshot(new Date("2099-01-01T00:00:00Z")).targets[0]?.available).toBe(false);

    const restored = availability.publish("shared-session", { state: "available" });
    expect(restored.changed).toBe(true);
    expect(restored.snapshot.version).not.toBe(first.snapshot.version);
    expect(capabilities.snapshot(new Date()).targets[0]?.available).toBe(true);
  });

  it("restores a durable exhausted domain on restart before routing", () => {
    const path = statePath();
    const firstCatalog = catalog();
    const first = new ProviderAvailability(firstCatalog, { statePath: path });
    first.registerDomain("shared-session", [ExecutionTargetId("target-a")]);
    first.publish("shared-session", { state: "quota-exhausted", retryAfter: "opaque" });

    const restartedCatalog = catalog();
    const restarted = new ProviderAvailability(restartedCatalog, { statePath: path });
    restarted.registerDomain("shared-session", [ExecutionTargetId("target-a")]);
    expect(
      restartedCatalog.snapshot(new Date()).targets.find((target) => target.targetId === "target-a"),
    ).toMatchObject({ available: false, availability: { retryAfter: "opaque" } });
  });

  it("rejects overlapping domains and records executor quota results", () => {
    const capabilities = catalog();
    const availability = new ProviderAvailability(capabilities, { statePath: statePath() });
    availability.registerDomain("shared-session", [ExecutionTargetId("target-a")]);
    expect(() =>
      availability.registerDomain("other-session", [ExecutionTargetId("target-a")]),
    ).toThrow(/already belongs/i);

    const result: AgentResult = {
      workId: "work-1",
      outcome: "failed",
      failure: { class: "quota-exhausted", retryAfter: "opaque-reset" },
      artifacts: [],
      usage: { ms: 1 },
      executionSnapshot: {
        targetId: ExecutionTargetId("target-a"),
        providerId: "fixture",
        model: "fixture",
        providerVersion: "1",
        isolationClass: "process",
        recordedAt: "2026-08-30T00:00:00.000Z",
      },
      runtimeMetadata: {},
    };
    expect(availability.observe(result).changed).toBe(true);
    expect(capabilities.snapshot(new Date()).targets[0]?.available).toBe(false);
  });

  it("uses provider initial availability only until durable refresh overrides it", () => {
    const path = statePath();
    const firstCatalog = catalog();
    const first = new ProviderAvailability(firstCatalog, { statePath: path });
    first.registerDomain("shared-session", [ExecutionTargetId("target-a")], {
      state: "quota-exhausted",
      retryAfter: "provider-hint",
    });
    expect(firstCatalog.snapshot(new Date()).targets[0]?.availability).toEqual({
      state: "quota-exhausted",
      retryAfter: "provider-hint",
    });
    first.publish("shared-session", { state: "available" });

    const restartedCatalog = catalog();
    const restarted = new ProviderAvailability(restartedCatalog, { statePath: path });
    restarted.registerDomain("shared-session", [ExecutionTargetId("target-a")], {
      state: "quota-exhausted",
    });
    expect(restartedCatalog.snapshot(new Date()).targets[0]?.availability).toEqual({
      state: "available",
    });
  });

  it("emits one change for a new state and none for its duplicate", () => {
    const capabilities = catalog();
    const changes: string[] = [];
    const availability = new ProviderAvailability(capabilities, {
      statePath: statePath(),
      onChange: (snapshot) => changes.push(snapshot.version),
    });
    availability.registerDomain("shared-session", [ExecutionTargetId("target-a")]);
    expect(availability.publish("shared-session", { state: "unavailable" }).changed).toBe(true);
    expect(availability.publish("shared-session", { state: "unavailable" }).changed).toBe(false);
    expect(changes).toHaveLength(1);
  });
});
