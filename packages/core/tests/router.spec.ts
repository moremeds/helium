import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  ExecutionTargetId,
  type TargetProfile,
} from "../src/capabilities.js";
import { select, type SelectionPolicy } from "../src/router.js";
import { WorkOrderSchema, type WorkOrder } from "../src/work.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const later = new Date("2026-08-29T02:00:00.000Z");

const target = (
  id: string,
  overrides: Partial<TargetProfile> = {},
): TargetProfile => ({
  targetId: ExecutionTargetId(id),
  capabilities: ["evidence.synthesis"],
  isolationClass: "process",
  operations: { maxLatencyMs: 60_000 },
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
  ...overrides,
});

const work = (overrides: Partial<WorkOrder> = {}): WorkOrder =>
  WorkOrderSchema.parse({
    id: "work-1",
    role: "evidence-verifier",
    taskClass: "research.verification",
    requires: ["evidence.synthesis"],
    constraints: {
      tools: ["artifact_read"],
      mutations: "forbidden",
      minIsolationClass: "process",
      maxLatencyMs: 180_000,
    },
    inputs: { artifacts: [] },
    acceptance: { outputSchema: "claim-set-v1" },
    ...overrides,
  });

const policy = (
  preferred: string,
  fallback: string[] = [],
): SelectionPolicy => ({
  policyVersion: "policy-1",
  roles: {
    "evidence-verifier": {
      preferred: ExecutionTargetId(preferred),
      fallback: fallback.map(ExecutionTargetId),
    },
  },
});

const catalogOf = (...profiles: TargetProfile[]) => {
  const catalog = new CapabilityCatalog();
  for (const p of profiles) catalog.register(p);
  return catalog;
};

describe("hard filter", () => {
  it("excludes a target missing a required capability tag", () => {
    const catalog = catalogOf(target("target-a", { capabilities: ["writing.executive"] }));
    const decision = select(work(), policy("target-a"), catalog.snapshot(now));
    expect(decision.selected).toBeUndefined();
    expect(decision.candidates[0].reasons).toContain("capability");
  });

  it("excludes a target whose declared isolation class is too weak", () => {
    const catalog = catalogOf(
      target("target-a", { isolationClass: "in-process" }),
      target("target-b"),
    );
    const decision = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(now));
    expect(decision.selected).toBe(ExecutionTargetId("target-b"));
    expect(decision.candidates).toEqual([
      expect.objectContaining({ targetId: "target-b", eligible: true }),
      expect.objectContaining({
        targetId: "target-a",
        eligible: false,
        reasons: ["isolation"],
      }),
    ]);
  });

  it("excludes a target that cannot isolate tools when the work declares any", () => {
    const catalog = catalogOf(
      target("target-a", {
        supports: { structuredOutput: true, toolIsolation: false, mutations: false },
      }),
      target("target-b"),
    );
    const decision = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(now));
    expect(decision.selected).toBe(ExecutionTargetId("target-b"));
    expect(decision.candidates).toEqual([
      expect.objectContaining({ targetId: "target-b", eligible: true }),
      expect.objectContaining({
        targetId: "target-a",
        eligible: false,
        reasons: ["tool-isolation"],
      }),
    ]);
  });

  it("excludes a target that cannot mutate when the work permits mutation", () => {
    const catalog = catalogOf(target("target-a"));
    const decision = select(
      work({ constraints: { ...work().constraints, mutations: "permitted" } }),
      policy("target-a"),
      catalog.snapshot(now),
    );
    expect(decision.candidates[0].reasons).toContain("mutations");
  });

  it("excludes a target slower than the work's latency bound", () => {
    const catalog = catalogOf(target("target-a", { operations: { maxLatencyMs: 600_000 } }));
    const decision = select(
      work({ constraints: { ...work().constraints, maxLatencyMs: 60_000 } }),
      policy("target-a"),
      catalog.snapshot(now),
    );
    expect(decision.candidates[0].reasons).toContain("latency");
  });

  it("excludes a target with too small a context window", () => {
    const catalog = catalogOf(
      target("target-a", { operations: { maxContextTokens: 8_000 } }),
    );
    const decision = select(
      work({ constraints: { ...work().constraints, maxContextTokens: 200_000 } }),
      policy("target-a"),
      catalog.snapshot(now),
    );
    expect(decision.candidates[0].reasons).toContain("context");
  });
});

describe("preference and fallback", () => {
  it("selects the configured preference when it survives the filter", () => {
    const catalog = catalogOf(target("target-a"), target("target-b"));
    const decision = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(now));
    expect(decision.selected).toBe(ExecutionTargetId("target-a"));
    expect(decision.fallbackPosition).toBe(0);
  });

  it("records the fallback position that produced the selection", () => {
    const catalog = catalogOf(
      target("target-a", { isolationClass: "in-process" }),
      target("target-b", { isolationClass: "in-process" }),
      target("target-c"),
    );
    const decision = select(
      work(),
      policy("target-a", ["target-b", "target-c"]),
      catalog.snapshot(now),
    );
    expect(decision.selected).toBe(ExecutionTargetId("target-c"));
    expect(decision.fallbackPosition).toBe(2);
  });

  it("falls through a quota-exhausted preference until the provider restores it", () => {
    const catalog = catalogOf(target("target-a"), target("target-b"));
    catalog.setAvailability(ExecutionTargetId("target-a"), {
      state: "quota-exhausted",
      retryAfter: "2026-08-29T01:00:00.000Z",
    });

    const during = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(now));
    expect(during.selected).toBe(ExecutionTargetId("target-b"));
    expect(during.candidates.find((c) => c.targetId === "target-a")?.reasons).toEqual([
      "quota-exhausted",
    ]);

    const after = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(later));
    expect(after.selected).toBe(ExecutionTargetId("target-b"));
    catalog.setAvailability(ExecutionTargetId("target-a"), { state: "available" });
    const restored = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(later));
    expect(restored.selected).toBe(ExecutionTargetId("target-a"));
    expect(restored.fallbackPosition).toBe(0);
  });

  it("never lets a preference re-admit a target a hard filter excluded", () => {
    // There is no boost that outranks a hard requirement. The preference is a
    // lookup among survivors, not a weight applied before filtering.
    const catalog = catalogOf(
      target("target-a", { isolationClass: "in-process" }),
      target("target-b"),
    );
    const decision = select(
      work({ constraints: { ...work().constraints, minIsolationClass: "sandboxed" } }),
      policy("target-a", ["target-b"]),
      catalog.snapshot(now),
    );
    expect(decision.selected).toBeUndefined();
    expect(decision.failure?.class).toBe("capability-shortage");
  });
});

describe("shortage", () => {
  it("reports per-target exclusion reasons and never relaxes a requirement", () => {
    const catalog = catalogOf(
      target("target-a", { isolationClass: "in-process" }),
      target("target-b", { capabilities: ["writing.executive"] }),
    );
    const decision = select(work(), policy("target-a", ["target-b"]), catalog.snapshot(now));
    expect(decision.selected).toBeUndefined();
    expect(decision.failure).toEqual({
      class: "capability-shortage",
      reasons: ["target-a: isolation", "target-b: capability"],
    });
  });

  it("reports a role with no configured target rather than picking one", () => {
    const catalog = catalogOf(target("target-a"));
    const decision = select(
      work(),
      { policyVersion: "policy-1", roles: {} },
      catalog.snapshot(now),
    );
    expect(decision.selected).toBeUndefined();
    expect(decision.failure?.reasons).toEqual([
      "no configured target for role evidence-verifier",
    ]);
  });
});

describe("determinism", () => {
  it("names the policy and catalog version it decided against", () => {
    const catalog = catalogOf(target("target-a"));
    const decision = select(work(), policy("target-a"), catalog.snapshot(now));
    expect(decision.policyVersion).toBe("policy-1");
    expect(decision.catalogVersion).toBe(catalog.snapshot(now).catalogVersion);
  });

  it("returns an identical decision on every repeat of the same inputs", () => {
    const catalog = catalogOf(
      target("target-a", { isolationClass: "in-process" }),
      target("target-b"),
      target("target-c"),
    );
    const snapshot = catalog.snapshot(now);
    const p = policy("target-a", ["target-c", "target-b"]);
    const first = JSON.stringify(select(work(), p, snapshot));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(select(work(), p, snapshot))).toBe(first);
    }
  });
});
