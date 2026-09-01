import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JsonlWriter,
  RunLedger,
  StateStore,
  WorkOrderSchema,
  parseTeamYaml,
} from "@helium/core";
import { productionProviderCertifications } from "./provider-certifications.js";
import {
  ProviderRuntime,
  type ProviderRuntimeOptions,
} from "./provider-runtime.js";

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

const allProviderCertifications = {
  codex: {
    certificationVersion: "codex-cost-routing-unit-v1",
    catalogSnapshotHash: productionProviderCertifications.codex.catalogSnapshotHash,
    recordedAt: "2026-08-31T00:00:00.000Z",
    source: "unit-fixture",
    targets: [
      { targetRef: "gpt-5.6-sol", variants: ["high"] },
      { targetRef: "gpt-5.6-luna", variants: ["medium"] },
    ],
  },
  deepseek: {
    certificationVersion: "deepseek-cost-routing-unit-v1",
    catalogSnapshotHash: productionProviderCertifications.deepseek.catalogSnapshotHash,
    recordedAt: "2026-08-31T00:00:00.000Z",
    source: "unit-fixture",
    targets: [{ targetRef: "deepseek-v4-flash", variants: ["low"] }],
  },
  claude: {
    certificationVersion: "claude-cost-routing-unit-v1",
    catalogSnapshotHash: productionProviderCertifications.claude.catalogSnapshotHash,
    recordedAt: "2026-08-31T00:00:00.000Z",
    source: "unit-fixture",
    targets: [{ targetRef: "claude-haiku-4-5-20251001", variants: [null] }],
  },
} satisfies NonNullable<ProviderRuntimeOptions["certifications"]>;

function runtime(
  overrides: ProviderRuntimeOptions = {},
  root = mkdtempSync(join(tmpdir(), "helium-provider-runtime-")),
) {
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

describe("production ProviderRuntime", () => {
  it("routes basic Shepherd research to a cheap target and reserves senior targets for PIT reasoning", async () => {
    const plane = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: {},
    });
    const candidate = (role: string, requires: string[]) => WorkOrderSchema.parse({
      id: `shepherd-${role}`,
      role,
      taskClass: `team.${role}`,
      requires,
      constraints: { tools: [], mutations: "forbidden", minIsolationClass: "process" },
      inputs: { artifacts: [], prompt: role },
      acceptance: { outputSchema: "fixture" },
    });
    const basic = candidate("corporate-action-universe-researcher", ["corporate-action-universe-research"]);
    const basicRoute = await plane.routing.route({ work: basic, reservedCost: 0, leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
    expect(plane.registered.codex.find((entry) => entry.profile.targetId === basicRoute.lease?.targetId)?.native).toMatchObject({
      targetRef: "gpt-5.6-luna",
      effort: "medium",
    });
    plane.leases.consume(basicRoute.lease!.id, basic.id);
    const senior = candidate("pit-adjudicator", ["point-in-time-adjudication"]);
    const seniorRoute = await plane.routing.route({ work: senior, reservedCost: 0, leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
    expect(plane.registered.codex.find((entry) => entry.profile.targetId === seniorRoute.lease?.targetId)?.native).toMatchObject({
      targetRef: "gpt-5.6-sol",
      effort: "high",
    });
    await plane.dispose();
  });

  it("passes only the manifest-declared Shepherd tools through the real Codex executor boundary", async () => {
    const codexInvoke = vi.fn(async (input: Parameters<NonNullable<ProviderRuntimeOptions["codexInvoke"]>>[0]) => ({
      ok: true,
      text: "{}",
      runtimeSnapshot: {
        requestedModel: input.model,
        requestedEffort: input.effort,
        effectiveEffort: input.effort,
        usage: {},
        events: [],
      },
    }));
    const plane = runtime({
      certifications: {
        ...productionProviderCertifications,
        codex: allProviderCertifications.codex,
      },
      codexInvoke,
      availabilityRefreshers: {},
    });
    const candidate = WorkOrderSchema.parse({
      id: "shepherd-tool-boundary",
      role: "corporate-action-universe-researcher",
      taskClass: "team.corporate-action-universe-research",
      requires: ["corporate-action-universe-research"],
      constraints: {
        tools: ["livewire.evidence.read", "anysearch.search"],
        mutations: "forbidden",
        minIsolationClass: "process",
      },
      inputs: { artifacts: [], prompt: "research" },
      acceptance: { outputSchema: "ShepherdClaimSet.v1" },
    });
    const routed = await plane.routing.route({
      work: candidate,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    await plane.registry.run({
      work: candidate,
      lease: routed.lease!,
      leases: plane.leases,
      workspacesDir: mkdtempSync(join(tmpdir(), "helium-shepherd-boundary-")),
      env: { PATH: process.env.PATH ?? "" },
      mcpConfigPath: "/tmp/shepherd-mcp.json",
    });
    expect(codexInvoke).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: "read-only",
      allowedTools: [
        "mcp__helium__livewire.evidence.read",
        "mcp__helium__anysearch.search",
      ],
      mcpConfigPath: "/tmp/shepherd-mcp.json",
    }));
    await plane.dispose();
  });

  it("owns tool-free cheapest-target availability probes for every configured provider", async () => {
    const codexInvoke = vi.fn(async (input: Parameters<NonNullable<ProviderRuntimeOptions["codexInvoke"]>>[0]) => ({
      ok: true,
      text: "HELIUM_PROVIDER_AVAILABLE",
      runtimeSnapshot: {
        requestedModel: input.model,
        requestedEffort: input.effort,
        effectiveEffort: input.effort,
        usage: {},
        events: [],
      },
    }));
    const claudeInvoke = vi.fn(async (input: Parameters<NonNullable<ProviderRuntimeOptions["claudeInvoke"]>>[0]) => ({
      ok: true,
      text: "HELIUM_PROVIDER_AVAILABLE",
      runtimeSnapshot: {
        requestedModel: input.model,
        modelUsage: {},
      },
    }));
    const deepseekBoundary = {
      run: vi.fn(async () => ({ text: "HELIUM_PROVIDER_AVAILABLE", usage: {}, providerMetadata: {} })),
    };
    const plane = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: {},
      codexInvoke,
      claudeInvoke,
      deepseekBoundary,
    });
    await plane.refreshProviderAvailability("codex");
    await plane.refreshProviderAvailability("claude");
    await plane.refreshProviderAvailability("deepseek");
    expect(codexInvoke).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-luna", effort: "medium", allowedTools: [], sandbox: "read-only",
    }));
    expect(claudeInvoke).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-haiku-4-5-20251001", maxTurns: 1, allowedTools: [],
    }));
    expect(deepseekBoundary.run).toHaveBeenCalledWith(expect.objectContaining({
      allowedTools: [],
      agentOptions: expect.objectContaining({ model: "deepseek-v4-flash", reasoningEffort: "low", maxTokens: 32 }),
    }));
    await plane.dispose();
  });

  it("coalesces quota-domain probes and keeps a thrown probe local with persisted backoff", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const claude = vi.fn(async () => {
      await gate;
      return { state: "available" as const };
    });
    const plane = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: {
        codex: async () => { throw new Error("probe transport down"); },
        claude,
        deepseek: async () => ({ state: "available" }),
      },
      availabilityRefreshDelayMs: 1_000,
    });
    const first = plane.refreshProviderAvailability("claude");
    const second = plane.refreshProviderAvailability("claude");
    expect(claude).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(plane.refreshProviderAvailability("codex")).resolves.toMatchObject({ changed: true });
    expect(plane.healthSnapshot().domains.find((entry) => entry.quotaDomain === "codex-subscription-session")?.availability).toMatchObject({
      state: "unavailable",
      retryAfter: expect.any(String),
    });
    await plane.dispose();
  });

  it("honors persisted provider backoff after restart instead of probing in a busy loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-provider-persisted-backoff-"));
    const first = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: {
        codex: async () => { throw new Error("still offline"); },
        claude: async () => ({ state: "available" }),
        deepseek: async () => ({ state: "available" }),
      },
      availabilityRefreshDelayMs: 60_000,
    }, root);
    await first.refreshProviderAvailability("codex");
    await first.dispose();

    const codex = vi.fn(async () => ({ state: "available" as const }));
    const second = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: {
        codex,
        claude: async () => ({ state: "available" }),
        deepseek: async () => ({ state: "available" }),
      },
      availabilityRefreshDelayMs: 60_000,
    }, root);
    await second.start();
    expect(codex).not.toHaveBeenCalled();
    await second.dispose();
  });

  it("stays checkpointed when every provider is exhausted and routes only after an explicit availability change", async () => {
    let codexAvailable = false;
    const probes = {
      codex: vi.fn(async () => codexAvailable ? { state: "available" as const } : { state: "quota-exhausted" as const, retryAfter: "opaque-codex" }),
      claude: vi.fn(async () => ({ state: "quota-exhausted" as const, retryAfter: "opaque-claude" })),
      deepseek: vi.fn(async () => ({ state: "quota-exhausted" as const, retryAfter: "opaque-deepseek" })),
    };
    const plane = runtime({
      certifications: allProviderCertifications,
      availabilityRefreshers: probes,
    });
    await Promise.all([
      plane.refreshProviderAvailability("codex"),
      plane.refreshProviderAvailability("claude"),
      plane.refreshProviderAvailability("deepseek"),
    ]);
    const candidate = WorkOrderSchema.parse({
      ...work,
      id: "all-providers-exhausted",
      role: "pit-adjudicator",
      taskClass: "team.pit-adjudication",
      requires: ["point-in-time-adjudication"],
    });
    const unavailable = await plane.routing.route({
      work: candidate,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(unavailable.lease).toBeUndefined();
    expect(unavailable.decision.failure?.class).toBe("unavailable");
    expect(probes.codex).toHaveBeenCalledOnce();
    expect(probes.claude).toHaveBeenCalledOnce();
    expect(probes.deepseek).toHaveBeenCalledOnce();

    codexAvailable = true;
    await plane.refreshProviderAvailability("codex");
    const resumed = await plane.routing.route({
      work: candidate,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(resumed.lease).toBeDefined();
    expect(probes.codex).toHaveBeenCalledTimes(2);
    expect(probes.claude).toHaveBeenCalledOnce();
    expect(probes.deepseek).toHaveBeenCalledOnce();
    await plane.dispose();
  });

  it("routes every role of an inline manifest through the certified Codex target", async () => {
    const plane = runtime({ certifications: productionProviderCertifications });
    // INLINE, not a file: this case asserts every task receives a lease, and
    // `router.ts` matches capability tags by exact containment. Pointing it at
    // a tenant manifest would make it fail on that tenant's own tags -- and
    // adding those tags to the production `targetProfile()` to make a test pass
    // is exactly backwards.
    const manifest = parseTeamYaml(`
manifestVersion: team-v1
name: routing-coverage
roles:
  inflation-researcher:
    responsibility: evidence
    requires: [macro-source-research, inflation-analysis]
    permissions: { externalResearch: true, mutations: forbidden, artifactRead: [source-artifacts] }
  verifier:
    responsibility: verification
    requires: [claim-verification, fresh-evidence, independent-source]
    permissions: { externalResearch: true, mutations: forbidden, artifactRead: [source-artifacts, dependency-artifacts] }
  lead:
    responsibility: synthesis
    requires: [macro-causal-synthesis]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [dependency-artifacts] }
  renderer:
    responsibility: rendering
    requires: [render-adjudicated-claims]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [accepted-claim-ledger] }
tasks:
  - { id: research, role: inflation-researcher, dependsOn: [], requires: [macro-source-research, inflation-analysis], inputs: [source-artifacts], outputSchema: ClaimSet.v1 }
  - { id: verify, role: verifier, dependsOn: [research], requires: [claim-verification, fresh-evidence, independent-source], inputs: [source-artifacts, dependency-artifacts], outputSchema: EvidenceDecisionSet.v1 }
  - { id: synthesis, role: lead, dependsOn: [verify], requires: [macro-causal-synthesis], inputs: [dependency-artifacts], outputSchema: AdjudicatedSynthesis.v1 }
  - { id: render, role: renderer, dependsOn: [synthesis], requires: [render-adjudicated-claims], inputs: [accepted-claim-ledger], outputSchema: ShadowReport.v1 }
crossReference: { compareClaims: true, materialContradictions: fresh-evidence-work-order, requireIndependentEvidence: true }
budgets: { maxAttempts: 4, maxTokens: 100000 }
acceptance: { allowPartialClaims: true, terminalTasks: [render] }
`);
    for (const task of manifest.tasks) {
      const candidate = WorkOrderSchema.parse({
        id: `macro-${task.id}`,
        role: task.role,
        taskClass: `team.${task.id}`,
        requires: task.requires,
        constraints: {
          tools: [],
          mutations: "forbidden",
          minIsolationClass: "process",
        },
        inputs: { artifacts: [], prompt: task.id },
        acceptance: { outputSchema: task.outputSchema },
      });
      const routed = await plane.routing.route({
        work: candidate,
        reservedCost: 0,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(routed.lease, task.id).toBeDefined();
      expect(plane.registered.codex.some(
        (entry) => entry.profile.targetId === routed.lease?.targetId,
      )).toBe(true);
      plane.leases.consume(routed.lease!.id, candidate.id);
    }
    await plane.dispose();
  });

  it("opens a provider-specific circuit after repeated failures and restores only by probe", async () => {
    const plane = runtime({
      certifications: productionProviderCertifications,
      circuitFailureThreshold: 2,
      availabilityRefreshers: { codex: async () => ({ state: "available" }) },
      codexInvoke: async () => ({
        ok: false,
        classification: "error",
        runtimeSnapshot: {
          requestedModel: "gpt-5.6-sol",
          requestedEffort: "high",
          effectiveEffort: "high",
          usage: {},
          events: [],
        },
      }),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const routed = await plane.routing.route({
        work,
        reservedCost: 0,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      await plane.registry.run({
        work,
        lease: routed.lease!,
        leases: plane.leases,
        workspacesDir: join(tmpdir(), `helium-breaker-${attempt}`),
        env: { PATH: process.env.PATH ?? "" },
      });
    }
    expect(plane.healthSnapshot()).toMatchObject({
      circuits: [{ provider: "codex", state: "open", consecutiveFailures: 2 }],
    });
    expect((await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })).lease).toBeUndefined();

    await plane.refreshProviderAvailability("codex");
    expect(plane.healthSnapshot()).toMatchObject({
      circuits: [{ provider: "codex", state: "closed", consecutiveFailures: 0 }],
    });
    expect((await plane.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })).lease).toBeDefined();
    await plane.dispose();
  });

  it("reapplies an open provider circuit before routing after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-provider-circuit-restart-"));
    const failing: ProviderRuntimeOptions = {
      certifications: productionProviderCertifications,
      circuitFailureThreshold: 1,
      codexInvoke: async () => ({
        ok: false,
        classification: "error",
        runtimeSnapshot: {
          requestedModel: "gpt-5.6-sol",
          requestedEffort: "high",
          effectiveEffort: "high",
          usage: {},
          events: [],
        },
      }),
    };
    const first = runtime(failing, root);
    const routed = await first.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    await first.registry.run({
      work,
      lease: routed.lease!,
      leases: first.leases,
      workspacesDir: join(root, "first-run"),
      env: { PATH: process.env.PATH ?? "" },
    });
    await first.dispose();

    // Prove the circuit itself is authoritative, rather than accidentally
    // relying on the availability file written by the first process.
    rmSync(join(root, "state", "providers", "availability.json"));
    const second = runtime({
      ...failing,
      availabilityRefreshers: { codex: async () => ({ state: "unavailable" }) },
    }, root);
    await second.start();
    expect((await second.routing.route({
      work,
      reservedCost: 0,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })).lease).toBeUndefined();
    expect(second.healthSnapshot()).toMatchObject({
      circuits: [{ provider: "codex", state: "open" }],
    });
    await second.dispose();
  });

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
});
