import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JsonlWriter,
  RunLedger,
  StateStore,
  WorkOrderSchema,
} from "@helium/core";
import type { JobSpec } from "@helium/v1-compat";
import { Dispatcher } from "./dispatch.js";
import { productionProviderCertifications } from "./provider-certifications.js";
import {
  ProviderRuntime,
  type ProviderRuntimeOptions,
} from "./provider-runtime.js";
import { ev } from "./testing/fixtures.js";

const work = WorkOrderSchema.parse({
  id: "production-plane-work",
  role: "v1-senior",
  taskClass: "analysis.v1-senior",
  requires: ["analysis.general"],
  constraints: {
    tools: [],
    mutations: "forbidden",
    minIsolationClass: "in-process",
  },
  inputs: { artifacts: [], prompt: "analyze" },
  acceptance: { outputSchema: "v1-senior-analysis" },
});

function runtime(overrides: ProviderRuntimeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "helium-provider-runtime-"));
  return new ProviderRuntime(
    {
      agents: {} as never,
      sessions: {} as never,
      sessionPersistence: {} as never,
      subagents: {} as never,
    },
    {
      stateRoot: join(root, "state"),
      workspacesDir: join(root, "workspaces"),
      claudeTokenFile: join(root, "claude.env"),
      envFile: join(root, "helium.env"),
      proxy: "http://127.0.0.1:1",
    },
    {
      certifications: {
        ...productionProviderCertifications,
        deepseek: {
          certificationVersion: "deepseek-unit-v1",
          catalogSnapshotHash:
            "d3049ece1b355b8c584b914fd5eb9c95e6cf199e49f57b724575e30cefdb4aaa",
          recordedAt: "2026-08-30T00:00:00.000Z",
          source: "unit-fixture",
          targets: [{ targetRef: "deepseek-v4-flash", variants: ["high"] }],
        },
      },
      availabilityRefreshers: {
        deepseek: async () => ({ state: "unavailable" }),
      },
      codexInvoke: async () => ({
        ok: false,
        classification: "quota-exhausted",
        retryAfter: "opaque-codex-reset",
        runtimeSnapshot: {
          requestedModel: "gpt-5.6-sol",
          requestedEffort: "high",
          effectiveEffort: "high",
          usage: {},
          events: [],
        },
      }),
      claudeInvoke: async () => ({
        ok: true,
        text: "unused",
        runtimeSnapshot: {
          requestedModel: "claude-opus-5",
          requestedEffort: "max",
          effectiveEffort: "max",
          modelUsage: {},
        },
      }),
      deepseekBoundary: {
        run: async () => ({
          text: "unused",
          usage: {},
          runtimeSnapshot: {},
          providerMetadata: {},
        }),
      },
      ...overrides,
    },
  );
}

const timeoutJob: JobSpec = {
  name: "provider-timeout",
  enabled: true,
  triggers: [],
  engine: {
    triage: { engine: "deepseek", model: "deepseek-v4-flash" },
    senior: { engine: "claude-max" },
  },
  escalateWhen: "material",
  session: "fresh",
  memory: "none",
  tools: [],
  allowMutations: false,
  maxTurns: { triage: 1, senior: 1 },
  timeoutMs: 30,
  budget: { maxTriagePerHour: 1, maxSeniorPerDay: 1 },
  delivery: { jsonl: true },
  prompt: "timeout probe",
};

describe("production ProviderRuntime", () => {
  it("publishes only variants present in the durable production certification", async () => {
    const plane = runtime({ certifications: productionProviderCertifications });
    expect(plane.registered.codex.map((entry) => entry.native)).toMatchObject([
      { targetRef: "gpt-5.6-sol", effort: "high" },
    ]);
    expect(plane.registered.deepseek).toHaveLength(0);
    expect(plane.registered.claude).toHaveLength(0);
    await plane.dispose();
  });

  it("composes all providers and turns executor quota into durable shared-domain fallback", async () => {
    const plane = runtime();
    expect(plane.registered.codex).toHaveLength(1);
    expect(plane.registered.deepseek).toHaveLength(1);
    expect(plane.registered.claude).toHaveLength(0);
    expect(
      plane.registered.claude.every(
        (entry) =>
          plane.capabilities.snapshot(new Date()).targets.find(
            (target) => target.targetId === entry.profile.targetId,
          )?.availability.state === "quota-exhausted",
      ),
    ).toBe(true);

    const first = await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      plane.registered.codex.some(
        (entry) => entry.profile.targetId === first.lease?.targetId,
      ),
    ).toBe(true);
    const result = await plane.registry.run({
      work,
      lease: first.lease!,
      leases: plane.leases,
      workspacesDir: join(tmpdir(), "helium-provider-runtime-runs"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.failure).toMatchObject({
      class: "quota-exhausted",
      retryAfter: "opaque-codex-reset",
    });
    expect(
      plane.registered.codex.every(
        (entry) =>
          plane.capabilities.snapshot(new Date()).targets.find(
            (target) => target.targetId === entry.profile.targetId,
          )?.availability.state === "quota-exhausted",
      ),
    ).toBe(true);

    const fallback = await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      plane.registered.deepseek.some(
        (entry) => entry.profile.targetId === fallback.lease?.targetId,
      ),
    ).toBe(true);

    const exact = await plane.routing.route({
      work,
      exactTarget: {
        targetRef: first.lease!.targetId,
        operator: "test-operator",
        reason: "prove no fallback",
        purpose: "replay",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      reservedCost: 0,
      leaseExpiresAt: "2098-01-01T00:00:00.000Z",
    });
    expect(exact.lease).toBeUndefined();
    expect(exact.decision.failure?.class).toBe("unavailable");

    await plane.refreshProviderAvailability("deepseek");
    const waiting = await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(waiting.lease).toBeUndefined();
    expect(waiting.decision.failure?.class).toBe("unavailable");
    await plane.dispose();
  });

  it("does not release the Dispatcher senior slot until a timed-out DeepSeek child is disposed", async () => {
    const interrupted = vi.fn();
    const order: string[] = [];
    let starts = 0;
    const disposed = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      order.push("first-disposed");
    });
    const plane = runtime({
      availabilityRefreshers: {
        codex: async () => ({ state: "unavailable" }),
        deepseek: async () => ({ state: "available" }),
      },
      subagents: {
        start: vi.fn(async () => {
          starts += 1;
          if (starts === 1) {
            return {
              id: "hung-deepseek-child",
              result: new Promise<never>(() => {}),
              dispose: disposed,
            };
          }
          order.push("second-started");
          return {
            id: "second-deepseek-child",
            result: Promise.resolve({
              output: [{ type: "text", text: "done" }],
              structured: { analysis: "done" },
              stopReason: "completed",
              effectiveReasoningEffort: "high",
            }),
            dispose: async () => {},
          };
        }),
        drainDescendants: vi.fn(async () => {}),
        followup: vi.fn(async () => "unused"),
        interrupt: interrupted,
        listChildren: vi.fn(async () => []),
        listDescendants: vi.fn(async () => []),
      },
      parents: {
        ensure: vi.fn(async () => ({
          parent: { id: "timeout-parent" },
          resumed: false,
          dispose: async () => {},
        })),
      },
    });
    await plane.refreshProviderAvailability("codex");
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-provider-timeout-"));
    const outcomes: Array<{ job: string; tier: string; outcome: string }> = [];
    const dispatcher = new Dispatcher({
      store: new StateStore(stateRoot),
      ledger: new RunLedger(new JsonlWriter(join(stateRoot, "jsonl"))),
      contextText: "timeout integration",
      triage: {
        dispatch: async () => ({
          outcome: "run_completed",
          verdict: {
            escalate: true,
            severity: "material",
            reason: "exercise senior capacity",
          },
        }),
      },
      senior: plane.seniorLane((_job, dir) => join(dir, "mcp.json")),
      onResult: (job, _event, result) => {
        outcomes.push({ job: job.name, tier: result.tier, outcome: result.outcome });
      },
      onSuppressed: () => {},
      maxConcurrentSenior: 1,
    });
    const firstJob = { ...timeoutJob, name: "provider-timeout-first" };
    const secondJob = { ...timeoutJob, name: "provider-timeout-second" };
    dispatcher.enqueue(firstJob, {
      ...ev,
      job: firstJob.name,
      dedupKey: firstJob.name,
    });
    dispatcher.enqueue(secondJob, {
      ...ev,
      job: secondJob.name,
      dedupKey: secondJob.name,
    });
    await dispatcher.drain();

    expect(outcomes).toEqual(
      expect.arrayContaining([
        { job: firstJob.name, tier: "senior", outcome: "timed_out" },
        { job: secondJob.name, tier: "senior", outcome: "run_completed" },
      ]),
    );
    expect(interrupted).toHaveBeenCalledWith("hung-deepseek-child", {
      id: "timeout-parent",
    });
    expect(disposed).toHaveBeenCalledOnce();
    expect(order).toEqual(["first-disposed", "second-started"]);
    await plane.dispose();
  });
});
