import { describe, expect, it } from "vitest";
import { CapabilityCatalog, ExecutionTargetId } from "@helium/core";
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

describe("ProviderAvailability", () => {
  it("fans a shared quota-domain update out atomically and preserves opaque hints", () => {
    const capabilities = catalog();
    const availability = new ProviderAvailability(capabilities);
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
    const availability = new ProviderAvailability(capabilities);
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
});
