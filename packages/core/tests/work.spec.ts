import { describe, expect, it } from "vitest";
import {
  AgentResultSchema,
  WorkOrderSchema,
  type AgentResult,
} from "../src/work.js";

const work = {
  id: "work-1",
  role: "evidence-verifier",
  taskClass: "research.verification",
  requires: ["verification.claims"],
  constraints: {
    tools: ["artifact_read"],
    mutations: "forbidden" as const,
    minIsolationClass: "process" as const,
    maxCost: 2,
    maxLatencyMs: 180_000,
  },
  inputs: { artifacts: ["artifact-1"] },
  acceptance: { outputSchema: "claim-set-v1" },
};

const snapshot = {
  targetId: "target-a",
  providerId: "provider-a",
  model: "model-a",
  providerVersion: "1.2.3",
  isolationClass: "process" as const,
  recordedAt: "2026-08-29T00:00:00.000Z",
};

const completedResult: AgentResult = {
  workId: "work-1",
  outcome: "completed",
  artifacts: ["artifact-2"],
  usage: { ms: 1200 },
  executionSnapshot: snapshot,
  runtimeMetadata: {},
};

describe("WorkOrderSchema", () => {
  it("parses a model-blind work order", () => {
    expect(WorkOrderSchema.parse(work).role).toBe("evidence-verifier");
  });

  it("rejects any provider or model key", () => {
    expect(() => WorkOrderSchema.parse({ ...work, model: "anything" })).toThrow();
    expect(() =>
      WorkOrderSchema.parse({ ...work, provider: "anything" }),
    ).toThrow();
  });

  it("rejects the graded requires shape deferred to v2", () => {
    // v1 `requires` is a flat tag set evaluated as a hard filter. The graded
    // form is deferred (Task 9), so the strict schema must reject it rather
    // than accept a shape nothing reads.
    expect(() =>
      WorkOrderSchema.parse({
        ...work,
        requires: { "verification.claims": { min: 0.8, weight: 1 } },
      }),
    ).toThrow();
  });

  it("rejects an unusable isolation class in the constraint", () => {
    expect(() =>
      WorkOrderSchema.parse({
        ...work,
        constraints: { ...work.constraints, minIsolationClass: "sandboxed-ish" },
      }),
    ).toThrow();
  });
});

describe("AgentResultSchema", () => {
  it("requires the typed execution snapshot", () => {
    expect(() =>
      AgentResultSchema.parse({ ...completedResult, executionSnapshot: undefined }),
    ).toThrow();
  });

  it("rejects an unusable isolation class in the snapshot", () => {
    expect(() =>
      AgentResultSchema.parse({
        ...completedResult,
        executionSnapshot: { ...snapshot, isolationClass: "sandboxed-ish" },
      }),
    ).toThrow();
  });

  it("keeps provider identity as opaque strings core never branches on", () => {
    expect(AgentResultSchema.parse(completedResult).executionSnapshot).toMatchObject({
      targetId: expect.any(String),
      providerId: expect.any(String),
      model: expect.any(String),
      providerVersion: expect.any(String),
      isolationClass: "process",
    });
  });

  it("keeps an absent cost absent rather than defaulting it to a known zero", () => {
    // A flat-rate target reports no cost and no tokens. Defaulting the field
    // to 0 would turn "not metered" into "measured as free".
    const parsed = AgentResultSchema.parse(completedResult);
    expect(parsed.usage.cost).toBeUndefined();
    expect("cost" in parsed.usage).toBe(false);
  });

  it("keeps quota-exhausted distinct from budget-exhausted", () => {
    const quota = AgentResultSchema.parse({
      ...completedResult,
      outcome: "failed",
      failure: { class: "quota-exhausted", retryAfter: "2026-08-29T01:00:00Z" },
    });
    expect(quota.failure?.class).toBe("quota-exhausted");
    const budget = AgentResultSchema.parse({
      ...completedResult,
      outcome: "failed",
      failure: { class: "budget-exhausted" },
    });
    expect(budget.failure?.class).toBe("budget-exhausted");
    expect(() =>
      AgentResultSchema.parse({
        ...completedResult,
        outcome: "failed",
        failure: { class: "out-of-money" },
      }),
    ).toThrow();
  });
});
