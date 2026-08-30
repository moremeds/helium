import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkOrderSchema } from "@helium/core";
import { ProviderRuntime } from "../../plugins/helium/src/provider-runtime.js";

describe("production provider capacity plane", () => {
  it("runs the complete non-live quota/fallback/wait/restore matrix", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-provider-plane-contract-"));
    const stateRoot = join(root, "state");
    const plane = new ProviderRuntime(
      {
        agents: {} as never,
        sessions: {} as never,
        sessionPersistence: {} as never,
        subagents: {} as never,
      },
      {
        stateRoot,
        workspacesDir: join(root, "workspaces"),
        claudeTokenFile: join(root, "claude.env"),
        envFile: join(root, "helium.env"),
        proxy: "http://127.0.0.1:1",
      },
      {
        codexInvoke: async () => ({
          ok: false,
          classification: "quota-exhausted",
          retryAfter: "opaque-contract-reset",
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
          text: "must-not-run-while-unavailable",
          runtimeSnapshot: { requestedModel: "x", modelUsage: {} },
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
    const work = WorkOrderSchema.parse({
      id: "capacity-contract-work",
      role: "v1-senior",
      taskClass: "analysis.v1-senior",
      requires: ["analysis.general"],
      constraints: {
        tools: [],
        mutations: "forbidden",
        minIsolationClass: "in-process",
      },
      inputs: { artifacts: [], prompt: "capacity matrix" },
      acceptance: { outputSchema: "v1-senior-analysis" },
    });
    const route = (exactTarget?: string) =>
      plane.routing.route({
        work,
        ...(exactTarget === undefined
          ? {}
          : {
              exactTarget: {
                targetRef: exactTarget,
                operator: "contract",
                reason: "prove exact target has no fallback",
                purpose: "replay",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            }),
        reservedCost: 0,
        leaseExpiresAt: "2098-01-01T00:00:00.000Z",
      });

    const preferred = await route();
    const codexTarget = preferred.lease!.targetId;
    const quota = await plane.registry.run({
      work,
      lease: preferred.lease!,
      leases: plane.leases,
      workspacesDir: join(root, "attempts"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(quota.failure).toMatchObject({
      class: "quota-exhausted",
      retryAfter: "opaque-contract-reset",
    });
    expect((await route(codexTarget)).lease).toBeUndefined();

    const fallback = await route();
    expect(
      plane.registered.deepseek.some(
        (entry) => entry.profile.targetId === fallback.lease?.targetId,
      ),
    ).toBe(true);
    plane.leases.consume(fallback.lease!.id, work.id);

    plane.availability.publish("deepseek-api-key", { state: "unavailable" });
    expect((await route()).decision.failure?.class).toBe("unavailable");

    const auditPath = join(stateRoot, "audit", "provider-availability.ndjson");
    const before = readFileSync(auditPath, "utf8").trim().split("\n").length;
    expect(
      plane.availability.publish("codex-subscription-session", {
        state: "available",
      }).changed,
    ).toBe(true);
    expect(
      plane.availability.publish("codex-subscription-session", {
        state: "available",
      }).changed,
    ).toBe(false);
    const after = readFileSync(auditPath, "utf8").trim().split("\n").length;
    expect(after - before).toBe(1);

    const resumed = await route();
    expect(resumed.lease?.targetId).toBe(codexTarget);
    expect(plane.leases.outstanding()).toHaveLength(1);
    plane.leases.consume(resumed.lease!.id, work.id);
    await plane.dispose();
  });
});
