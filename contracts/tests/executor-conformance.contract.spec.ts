/**
 * Every registered executor is graded by the ONE execution-boundary suite
 * Phase 0 shipped -- adapted through `asBoundarySubject()`, not forked.
 *
 * The two fakes are workspace PACKAGES rather than in-tree modules because the
 * Phase 1 exit gate proves install and removal without a core edit: an in-tree
 * `testing/fake-executor.ts` cannot be installed or removed, so it cannot make
 * that gate falsifiable. They differ on BOTH axes -- isolation class and
 * billing model -- because one fake cannot hold both sets of invariants, and
 * splitting only on isolation class leaves the budget/quota distinction with
 * no test that can break it.
 *
 * SCOPE NOTE. `runExecutionBoundaryConformance()` is run over the
 * `process`-class fake only, and that is not a gap being waved through. Every
 * assertion in that suite reads a boundary report written by a spawned CLI
 * child; an `in-process` executor has no child to write one, so the suite
 * cannot grade it at all -- `subject.invoke()` would return no text and the
 * suite would fail for a reason that has nothing to do with isolation. The
 * registry therefore admits an `in-process` executor at the floor and refuses
 * it any work requiring more. That is sound because the suite exists to catch
 * a claim STRONGER than reality, and `in-process` is the weakest class there
 * is: it cannot be over-claimed.
 * @module contracts/executor-conformance
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityCatalog,
  ExecutionTargetId,
  LeaseStore,
  WorkOrderSchema,
  conformanceAtFloor,
  select,
  type ConformanceRecord,
  type SelectionPolicy,
  type TargetProfile,
  type WorkOrder,
} from "@helium/core";
import { createFlatRateExecutor } from "@helium/fake-flat-rate";
import { createMeteredExecutor } from "@helium/fake-metered";
import { describe, expect, it } from "vitest";
import {
  ExecutorRegistry,
  asBoundarySubject,
} from "../../plugins/helium/src/executor-registry.js";
import { runExecutionBoundaryConformance } from "../harness/execution-boundary.js";

const METERED = ExecutionTargetId("fake-metered");
const FLAT_RATE = ExecutionTargetId("fake-flat-rate");
const now = new Date("2026-08-29T00:00:00.000Z");
const later = new Date("2026-08-29T02:00:00.000Z");

const metered = createMeteredExecutor({ targetId: METERED, command: "claude" });
const flatRate = createFlatRateExecutor({ targetId: FLAT_RATE });

// The suite spawns the harness's fake binary as `claude` on a narrowed PATH.
runExecutionBoundaryConformance(asBoundarySubject(metered, "fake-metered"));

const provenProcess: ConformanceRecord = {
  targetId: METERED,
  provenClass: "process",
  basis: "execution-boundary-conformance",
  recordedAt: now.toISOString(),
};

const work = (overrides: Partial<WorkOrder> = {}): WorkOrder =>
  WorkOrderSchema.parse({
    id: "work-1",
    role: "analyst",
    taskClass: "test",
    requires: ["analysis"],
    constraints: {
      tools: [],
      mutations: "forbidden",
      minIsolationClass: "in-process",
    },
    inputs: { artifacts: [] },
    acceptance: { outputSchema: "any-v1" },
    ...overrides,
  });

const profile = (id: string, isolationClass: "in-process" | "process"): TargetProfile => ({
  targetId: ExecutionTargetId(id),
  capabilities: ["analysis"],
  isolationClass,
  operations: {},
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
});

const policy: SelectionPolicy = {
  policyVersion: "policy-1",
  roles: {
    analyst: { preferred: FLAT_RATE, fallback: [METERED] },
  },
};

const run = async (
  registry: ExecutorRegistry,
  targetId: ExecutionTargetId,
  w: WorkOrder,
) => {
  const leases = new LeaseStore();
  const lease = leases.issue({
    targetId,
    workId: w.id,
    reservedCost: 0,
    expiresAt: "2026-08-29T01:00:00.000Z",
  });
  return await registry.run({
    work: w,
    lease,
    leases,
    workspacesDir: mkdtempSync(join(tmpdir(), "helium-conf-")),
    env: { PATH: process.env.PATH ?? "" },
    now,
  });
};

describe("billing models stay distinct", () => {
  it("reports no cost and no tokens for a flat-rate run — absent, not zero", async () => {
    const registry = new ExecutorRegistry();
    registry.register(flatRate, conformanceAtFloor(FLAT_RATE));
    const result = await run(registry, FLAT_RATE, work());

    expect(result.outcome).toBe("completed");
    // `0` would record "measured as free" where the truth is "not metered".
    expect("cost" in result.usage).toBe(false);
    expect("inputTokens" in result.usage).toBe(false);
    expect("outputTokens" in result.usage).toBe(false);
    expect(result.usage.ms).toBeGreaterThanOrEqual(0);
  });

  it("charges a flat-rate run without recording a zero it never observed", async () => {
    const registry = new ExecutorRegistry();
    registry.register(flatRate, conformanceAtFloor(FLAT_RATE));
    const result = await run(registry, FLAT_RATE, work());

    // A ledger must distinguish "no cost reported" from "cost was zero".
    // `usage.cost ?? 0` is the exact bug this asserts against: it produces a
    // confident total from an observation that was never made.
    const metered_ = [result].filter((r) => r.usage.cost !== undefined);
    expect(metered_).toHaveLength(0);
    expect(() => result.usage.cost?.toFixed(2)).not.toThrow();
  });

  it("reports tokens and cost for a metered run", async () => {
    const registry = new ExecutorRegistry();
    registry.register(metered, provenProcess);
    const result = await run(
      registry,
      METERED,
      work({ constraints: { ...work().constraints, minIsolationClass: "process" } }),
    );
    expect(result.usage.cost).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("never normalizes one exhaustion state into the other, in either direction", async () => {
    const exhaustedQuota = createFlatRateExecutor({
      targetId: ExecutionTargetId("flat-exhausted"),
      quotaExhaustedUntil: "2026-08-29T01:00:00.000Z",
    });
    const exhaustedBudget = createMeteredExecutor({
      targetId: ExecutionTargetId("metered-exhausted"),
      command: "claude",
      budgetExhausted: true,
    });

    const registry = new ExecutorRegistry();
    registry.register(exhaustedQuota, conformanceAtFloor(ExecutionTargetId("flat-exhausted")));
    registry.register(exhaustedBudget, {
      targetId: ExecutionTargetId("metered-exhausted"),
      provenClass: "process",
      basis: "execution-boundary-conformance",
      recordedAt: now.toISOString(),
    });

    const quota = await run(registry, ExecutionTargetId("flat-exhausted"), work());
    expect(quota.failure?.class).toBe("quota-exhausted");
    expect(quota.failure?.retryAfter).toBe("2026-08-29T01:00:00.000Z");
    expect("cost" in quota.usage).toBe(false);

    const budget = await run(
      registry,
      ExecutionTargetId("metered-exhausted"),
      work({ constraints: { ...work().constraints, minIsolationClass: "process" } }),
    );
    expect(budget.failure?.class).toBe("budget-exhausted");
    expect(budget.failure?.retryAfter).toBeUndefined();
  });
});

describe("isolation class governs selection", () => {
  it("never resolves work requiring `process` to the in-process fake", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile("fake-flat-rate", "in-process"));
    catalog.register(profile("fake-metered", "process"));

    const decision = select(
      work({ constraints: { ...work().constraints, minIsolationClass: "process" } }),
      policy,
      catalog.snapshot(now),
    );
    expect(decision.selected).toBe(METERED);
    expect(
      decision.candidates.find((c) => c.targetId === "fake-flat-rate")?.reasons,
    ).toEqual(["isolation"]);
  });

  it("falls through a quota-exhausted preference until a provider-owned availability update", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(profile("fake-flat-rate", "in-process"));
    catalog.register(profile("fake-metered", "process"));
    catalog.setAvailability(FLAT_RATE, {
      state: "quota-exhausted",
      retryAfter: "2026-08-29T01:00:00.000Z",
    });

    const during = select(work(), policy, catalog.snapshot(now));
    expect(during.selected).toBe(METERED);
    expect(during.failure).toBeUndefined();

    const after = select(work(), policy, catalog.snapshot(later));
    expect(after.selected).toBe(METERED);
    catalog.setAvailability(FLAT_RATE, { state: "available" });
    const restored = select(work(), policy, catalog.snapshot(later));
    expect(restored.selected).toBe(FLAT_RATE);
  });
});
