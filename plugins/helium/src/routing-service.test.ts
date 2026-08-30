import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  ExecutionTargetId,
  LeaseStore,
  WorkOrderSchema,
  type TargetProfile,
} from "@helium/core";
import { RoutingService } from "./routing-service.js";

const now = new Date("2026-08-30T10:00:00.000Z");
const profile = (
  id: string,
  overrides: Partial<TargetProfile> = {},
): TargetProfile => ({
  targetId: ExecutionTargetId(id),
  capabilities: ["analysis.general"],
  isolationClass: "process",
  operations: {},
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
  ...overrides,
});

function fixture() {
  const catalog = new CapabilityCatalog();
  catalog.register(profile("target-a", { isolationClass: "in-process" }));
  catalog.register(profile("target-b"));
  catalog.register(profile("target-c"));
  const leases = new LeaseStore();
  const service = new RoutingService({
    catalog,
    leases,
    policy: {
      policyVersion: "policy-v1",
      roles: {
        analyst: {
          preferred: ExecutionTargetId("target-a"),
          fallback: [ExecutionTargetId("target-b")],
        },
      },
    },
    now: () => now,
  });
  const work = WorkOrderSchema.parse({
    id: "work-1",
    role: "analyst",
    taskClass: "analysis",
    requires: ["analysis.general"],
    constraints: {
      tools: [],
      mutations: "forbidden",
      minIsolationClass: "process",
      maxCost: 2,
    },
    inputs: { artifacts: ["artifact-1"], prompt: "analyze" },
    acceptance: { outputSchema: "analysis-v1" },
  });
  return { catalog, leases, service, work };
}

const override = (targetRef: string) => ({
  targetRef,
  operator: "operator-1",
  reason: "replay exact target",
  purpose: "replay" as const,
  expiresAt: "2026-08-30T11:00:00.000Z",
});

describe("RoutingService", () => {
  it("uses configured preference/fallback and issues the ordinary lease", () => {
    const { service, work } = fixture();
    const routed = service.route({
      work,
      reservedCost: 1,
      leaseExpiresAt: "2026-08-30T10:05:00.000Z",
    });
    expect(routed.decision.selected).toBe(ExecutionTargetId("target-b"));
    expect(routed.lease?.targetId).toBe(ExecutionTargetId("target-b"));
    expect(routed.audit.mode).toBe("normal");
  });

  it("pins an exact target, audits authority, and does not walk fallback", () => {
    const { catalog, service, work } = fixture();
    catalog.setAvailability(ExecutionTargetId("target-c"), {
      state: "quota-exhausted",
      retryAfter: "opaque-hint",
    });
    const routed = service.route({
      work,
      exactTarget: override("target-c"),
      reservedCost: 1,
      leaseExpiresAt: "2026-08-30T10:05:00.000Z",
    });
    expect(routed.decision.selected).toBeUndefined();
    expect(routed.decision.failure?.class).toBe("unavailable");
    expect(routed.lease).toBeUndefined();
    expect(routed.audit).toMatchObject({
      mode: "exact-target",
      override: {
        targetRef: "target-c",
        operator: "operator-1",
        purpose: "replay",
      },
      targetSnapshot: {
        targetId: "target-c",
        availability: { retryAfter: "opaque-hint" },
      },
    });
  });

  it("rechecks static safety instead of using the override to bypass it", () => {
    const { service, work } = fixture();
    const routed = service.route({
      work,
      exactTarget: override("target-a"),
      reservedCost: 1,
      leaseExpiresAt: "2026-08-30T10:05:00.000Z",
    });
    expect(routed.decision.failure?.class).toBe("capability-shortage");
    expect(routed.lease).toBeUndefined();
  });

  it("fails closed on expired authority and budget expansion", () => {
    const { service, work } = fixture();
    expect(() =>
      service.route({
        work,
        exactTarget: { ...override("target-b"), expiresAt: "2026-08-30T09:59:59Z" },
        reservedCost: 1,
        leaseExpiresAt: "2026-08-30T10:05:00.000Z",
      }),
    ).toThrow(/expired/i);
    expect(() =>
      service.route({
        work,
        exactTarget: override("target-b"),
        reservedCost: 3,
        leaseExpiresAt: "2026-08-30T10:05:00.000Z",
      }),
    ).toThrow(/cost/i);
  });
});
