import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkOrderSchema } from "@helium/core";
import { productionProviderCertifications } from "../../plugins/helium/src/provider-certifications.js";
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
        certifications: {
          ...productionProviderCertifications,
          deepseek: {
            certificationVersion: "deepseek-contract-v1",
            catalogSnapshotHash:
              "d3049ece1b355b8c584b914fd5eb9c95e6cf199e49f57b724575e30cefdb4aaa",
            recordedAt: "2026-08-30T00:00:00.000Z",
            source: "contract-fixture",
            targets: [{ targetRef: "deepseek-v4-flash", variants: ["high"] }],
          },
        },
        availabilityRefreshers: {
          codex: async () => ({ state: "available" }),
          deepseek: async () => ({ state: "unavailable" }),
        },
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

    await plane.refreshProviderAvailability("deepseek");
    expect((await route()).decision.failure?.class).toBe("unavailable");

    const auditPath = join(stateRoot, "audit", "provider-availability.ndjson");
    const before = readFileSync(auditPath, "utf8").trim().split("\n").length;
    expect(
      (await plane.refreshProviderAvailability("codex")).changed,
    ).toBe(true);
    expect(
      (await plane.refreshProviderAvailability("codex")).changed,
    ).toBe(false);
    const after = readFileSync(auditPath, "utf8").trim().split("\n").length;
    expect(after - before).toBe(1);

    const resumed = await route();
    expect(resumed.lease?.targetId).toBe(codexTarget);
    expect(plane.leases.outstanding()).toHaveLength(1);
    plane.leases.consume(resumed.lease!.id, work.id);
    await plane.dispose();
  });

  it("rechecks a persisted exhausted provider once on restart and restores routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-provider-refresh-contract-"));
    const config = {
      stateRoot: join(root, "state"),
      workspacesDir: join(root, "workspaces"),
      claudeTokenFile: join(root, "claude.env"),
      envFile: join(root, "helium.env"),
      proxy: "http://127.0.0.1:1",
    };
    const context = {
      agents: {} as never,
      sessions: {} as never,
      sessionPersistence: {} as never,
      subagents: {} as never,
    };
    const work = WorkOrderSchema.parse({
      id: "restart-refresh-work",
      role: "v1-senior",
      taskClass: "analysis.v1-senior",
      requires: ["analysis.general"],
      constraints: {
        tools: [],
        mutations: "forbidden",
        minIsolationClass: "process",
      },
      inputs: { artifacts: [], prompt: "provider refresh" },
      acceptance: { outputSchema: "v1-senior-analysis" },
    });
    const first = new ProviderRuntime(context, config, {
      codexInvoke: async () => ({
        ok: false,
        classification: "quota-exhausted",
        runtimeSnapshot: {
          requestedModel: "gpt-5.6-sol",
          requestedEffort: "high",
          effectiveEffort: "high",
          usage: {},
          events: [],
        },
      }),
    });
    const selected = await first.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    await first.registry.run({
      work,
      lease: selected.lease!,
      leases: first.leases,
      workspacesDir: join(root, "attempts"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(
      first.availability.snapshot().domains[0]?.availability.state,
    ).toBe("quota-exhausted");
    await first.dispose();

    const refresh = vi.fn(async () => ({ state: "available" as const }));
    const restarted = new ProviderRuntime(context, config, {
      availabilityRefreshers: { codex: refresh },
    });
    expect(
      restarted.availability.snapshot().domains[0]?.availability.state,
    ).toBe("quota-exhausted");
    await restarted.start();
    expect(refresh).toHaveBeenCalledOnce();
    expect((await restarted.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })).lease).toBeDefined();
    await restarted.dispose();
  });
});
