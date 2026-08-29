import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  ExecutionTargetId,
  type TargetProfile,
} from "../src/capabilities.js";

const profile = (): TargetProfile => ({
  targetId: ExecutionTargetId("target-a"),
  capabilities: ["writing.executive", "evidence.synthesis"],
  isolationClass: "process",
  operations: { maxLatencyMs: 180_000 },
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
});

const now = new Date("2026-08-29T00:00:00.000Z");

describe("CapabilityCatalog", () => {
  it("registers an opaque target and lists it", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get(ExecutionTargetId("target-a"))?.capabilities).toContain(
      "evidence.synthesis",
    );
  });

  it("refuses a duplicate target", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    expect(() => catalog.register(profile())).toThrow(/duplicate target/);
  });

  it("refuses a duplicate capability tag", () => {
    const catalog = new CapabilityCatalog();
    expect(() =>
      catalog.register({
        ...profile(),
        capabilities: ["writing.executive", "writing.executive"],
      }),
    ).toThrow(/duplicate capability/);
  });

  it("refuses a profile with no capability tags at all", () => {
    const catalog = new CapabilityCatalog();
    expect(() => catalog.register({ ...profile(), capabilities: [] })).toThrow();
  });

  it("refuses an unknown isolation class", () => {
    const catalog = new CapabilityCatalog();
    expect(() =>
      catalog.register({
        ...profile(),
        isolationClass: "sandboxed-ish" as never,
      }),
    ).toThrow();
  });

  // The 31-leaf ontology, per-capability scores and confidence intervals are
  // deferred v2. A v2 field arriving early must fail loud rather than be
  // silently ignored: an unused numeric field is exactly what a later reader
  // mistakes for a measurement.
  it.each(["score", "confidence", "sampleCount"])(
    "refuses a registration carrying the deferred %s field",
    (field) => {
      const catalog = new CapabilityCatalog();
      expect(() =>
        catalog.register({ ...profile(), [field]: 0.9 } as never),
      ).toThrow();
    },
  );

  it("exposes no provider or model field", () => {
    const catalog = new CapabilityCatalog();
    expect(() =>
      catalog.register({ ...profile(), providerId: "some-provider" } as never),
    ).toThrow();
    expect(() =>
      catalog.register({ ...profile(), model: "some-model" } as never),
    ).toThrow();
  });

  it("returns an effect-scoped disposer", () => {
    const catalog = new CapabilityCatalog();
    const dispose = catalog.register(profile());
    dispose();
    expect(catalog.get(ExecutionTargetId("target-a"))).toBeUndefined();
    expect(catalog.list()).toHaveLength(0);
  });
});

describe("availability", () => {
  it("is dynamic and separate from the registered profile", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    expect(catalog.available(ExecutionTargetId("target-a"), now)).toBe(true);

    catalog.setAvailability(ExecutionTargetId("target-a"), {
      state: "quota-exhausted",
      retryAfter: "2026-08-29T01:00:00.000Z",
    });
    expect(catalog.available(ExecutionTargetId("target-a"), now)).toBe(false);
  });

  it("becomes available again once retryAfter has passed", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    catalog.setAvailability(ExecutionTargetId("target-a"), {
      state: "quota-exhausted",
      retryAfter: "2026-08-29T01:00:00.000Z",
    });
    expect(
      catalog.available(
        ExecutionTargetId("target-a"),
        new Date("2026-08-29T01:00:01.000Z"),
      ),
    ).toBe(true);
  });

  it("keeps an unavailable target unavailable with no retryAfter to wait for", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    catalog.setAvailability(ExecutionTargetId("target-a"), {
      state: "unavailable",
    });
    expect(
      catalog.available(
        ExecutionTargetId("target-a"),
        new Date("2030-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("refuses availability for a target that was never registered", () => {
    const catalog = new CapabilityCatalog();
    expect(() =>
      catalog.setAvailability(ExecutionTargetId("ghost"), { state: "available" }),
    ).toThrow(/unknown target/);
  });
});

describe("snapshot", () => {
  it("is a value the pure selector can be handed, not a live view", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile());
    const snapshot = catalog.snapshot(now);
    expect(snapshot.targets).toHaveLength(1);
    expect(snapshot.targets[0].available).toBe(true);

    catalog.setAvailability(ExecutionTargetId("target-a"), {
      state: "unavailable",
    });
    expect(snapshot.targets[0].available).toBe(true);
    expect(catalog.snapshot(now).targets[0].available).toBe(false);
  });

  it("advances its version on every mutation, so a decision can name the catalog it saw", () => {
    const catalog = new CapabilityCatalog();
    const first = catalog.snapshot(now).catalogVersion;
    catalog.register(profile());
    expect(catalog.snapshot(now).catalogVersion).not.toBe(first);
  });
});
