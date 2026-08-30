import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkOrderSchema } from "@helium/core";
import { ProviderRuntime } from "./provider-runtime.js";

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

function runtime() {
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
    },
  );
}

describe("production ProviderRuntime", () => {
  it("composes all providers and turns executor quota into durable shared-domain fallback", async () => {
    const plane = runtime();
    expect(plane.registered.codex.length).toBeGreaterThan(1);
    expect(plane.registered.deepseek.length).toBeGreaterThan(1);
    expect(plane.registered.claude.length).toBeGreaterThan(1);
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

    plane.availability.publish("deepseek-api-key", { state: "unavailable" });
    const waiting = await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(waiting.lease).toBeUndefined();
    expect(waiting.decision.failure?.class).toBe("unavailable");
    await plane.dispose();
  });
});
