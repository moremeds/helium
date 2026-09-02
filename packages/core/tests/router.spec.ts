import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  ExecutionTargetId,
  WorkOrderSchema,
  select,
  type TargetProfile,
  type WorkOrder,
} from "../src/index.js";

function target(
  id: string,
  capabilities: string[],
  price?: { usdIn: number; usdOut: number; overheadInputTokens?: number },
): TargetProfile {
  return {
    targetId: ExecutionTargetId(id),
    capabilities,
    ...(price === undefined ? {} : { price }),
    operations: {},
    supports: { structuredOutput: true, toolIsolation: true, mutations: false },
  };
}

function work(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return WorkOrderSchema.parse({
    id: "w1",
    role: "auditor",
    taskClass: "analysis",
    requires: ["reason.deep"],
    constraints: { tools: [], mutations: "forbidden", minIsolationClass: "in-process" },
    inputs: { artifacts: [] },
    acceptance: { outputSchema: "text" },
    ...overrides,
  });
}

describe("select", () => {
  it("picks the cheapest target whose capabilities cover the requirement", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(target("pricey", ["reason.deep", "tool.use"], { usdIn: 1e-5, usdOut: 3e-5 }));
    catalog.register(target("thrifty", ["reason.deep", "tool.use"], { usdIn: 1e-7, usdOut: 4e-7 }));
    const decision = select(work(), catalog.snapshot());
    expect(decision.selected).toBe("thrifty");
    expect(decision.basis).toBe("cheapest-capable");
  });

  it("sorts an unpriced target last rather than treating absent price as free", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(target("flat-rate", ["reason.deep"]));
    catalog.register(target("metered", ["reason.deep"], { usdIn: 1e-6, usdOut: 2e-6 }));
    expect(select(work(), catalog.snapshot()).selected).toBe("metered");
  });

  it("refuses to relax a capability requirement to produce a selection", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(target("fast-only", ["reason.fast"], { usdIn: 0, usdOut: 0 }));
    const decision = select(work(), catalog.snapshot());
    expect(decision.selected).toBeUndefined();
    expect(decision.failure?.class).toBe("capability-shortage");
    expect(decision.candidates[0]?.reasons).toContain("capability");
  });

  it("downgrades one step with a recorded reason when the preference is unaffordable", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(target("big", ["reason.deep"], { usdIn: 1e-4, usdOut: 1e-4 }));
    catalog.register(target("small", ["reason.deep"], { usdIn: 1e-7, usdOut: 1e-7 }));
    const decision = select(work(), catalog.snapshot(), {
      policy: {
        roles: {
          auditor: { preferred: ExecutionTargetId("big"), fallback: [ExecutionTargetId("small")] },
        },
      },
      budget: { remainingUsd: 0.5, projectedInputTokens: 10_000, projectedOutputTokens: 2_000 },
    });
    expect(decision.selected).toBe("small");
    expect(decision.downgradeReason).toContain("big projected");
  });

  it("fails budget-exhausted rather than selecting something it cannot pay for", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(target("big", ["reason.deep"], { usdIn: 1e-4, usdOut: 1e-4 }));
    const decision = select(work(), catalog.snapshot(), {
      budget: { remainingUsd: 0.01, projectedInputTokens: 10_000, projectedOutputTokens: 2_000 },
    });
    expect(decision.selected).toBeUndefined();
    expect(decision.failure?.class).toBe("budget-exhausted");
  });

  it("separates quota exhaustion from being down", () => {
    const catalog = new CapabilityCatalog();
    const id = ExecutionTargetId("throttled");
    catalog.register(target("throttled", ["reason.deep"], { usdIn: 0, usdOut: 0 }));
    catalog.setAvailability(id, { state: "quota-exhausted", retryAfter: "60s" });
    const decision = select(work(), catalog.snapshot());
    expect(decision.failure?.class).toBe("unavailable");
    expect(decision.candidates[0]?.reasons).toEqual(["quota-exhausted"]);
  });

  it("charges a target for its own preamble, so a fat one loses its price edge", () => {
    // Design §3.1: a model with a cheap per-token rate and a large mandatory
    // preamble is not the cheap option. The overhead is input the caller never
    // wrote and always pays for, so it belongs in the projection.
    const catalog = new CapabilityCatalog();
    catalog.register(
      target("verbose", ["reason.deep"], {
        usdIn: 1e-6,
        usdOut: 1e-6,
        overheadInputTokens: 18_000,
      }),
    );
    const budget = {
      remainingUsd: 1,
      projectedInputTokens: 2_000,
      projectedOutputTokens: 100,
    };
    const decision = select(work(), catalog.snapshot(), { budget });
    const projected = decision.candidates.find(
      (c) => c.targetId === "verbose",
    )?.projectedUsd;
    // (2,000 prompt + 18,000 preamble) * 1e-6 + 100 * 1e-6
    expect(projected).toBeCloseTo(0.0201, 10);
  });
});

describe("a step that carries tools", () => {
  it("excludes a target that cannot call one, whatever the task declared", () => {
    // The task requires `reason.deep` only — no `tool.use` — but the role's
    // permissions put tools in the work order. Routing to a target with no
    // tool loop produces a step that fails at execution, or worse a model
    // politely explaining it has no tools, in a report that reads as an answer.
    const catalog = new CapabilityCatalog();
    catalog.register(target("inference-only", ["reason.deep"], { usdIn: 1e-9, usdOut: 1e-9 }));
    catalog.register(target("has-tools", ["reason.deep", "tool.use"], { usdIn: 1e-4, usdOut: 1e-4 }));

    const decision = select(
      work({ constraints: { tools: ["ow_spot"], mutations: "forbidden", minIsolationClass: "in-process" } }),
      catalog.snapshot(),
    );

    // The dearer target wins, because the cheaper one cannot do the job.
    expect(decision.selected).toBe("has-tools");
    expect(
      decision.candidates.find((entry) => entry.targetId === "inference-only")!.reasons,
    ).toContain("tool-capability");
  });
});
