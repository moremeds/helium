import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditStore,
  CapabilityCatalog,
  loadTenants,
  type EcosystemTool,
  type LoadedTenant,
  ProviderRunFailure,
  type Provider,
} from "@helium/core";
import {
  registerProviders,
  retireQuotaDomain,
  runTenant,
  type ModelExecutor,
} from "./runner.js";

const TEAM = `manifestVersion: "2"
name: demo
roles:
  prober:
    requires: [tool.use, cheap.bulk]
    permissions: { tools: [echo] }
tasks:
  - id: one
    role: prober
    requires: [tool.use]
    prompt: say hello
`;

function tenant(budgetUsd = 1): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-run-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    `tenant: demo\nenabled: true\nteam: team.yaml\nbudget: { usd: ${budgetUsd}, tokens: 100000 }\n`,
  );
  writeFileSync(join(dir, "demo", "team.yaml"), TEAM);
  return loadTenants(dir).tenants[0]!;
}

const echo: EcosystemTool = {
  name: "echo",
  description: "echo",
  paramsSchema: z.object({ q: z.string() }),
  mutating: false,
  async run(args) {
    return JSON.stringify({ echoed: args.q });
  },
};

const provider: Provider = {
  id: "fake",
  capabilities: ["tool.use", "cheap.bulk"],
  overheadTokens: 0,
  models: [
    {
      id: "cheap",
      caps: ["tool.use", "cheap.bulk"],
      usdIn: 1e-6,
      usdOut: 2e-6,
    },
  ],
  async probe() {
    return true;
  },
  select() {
    return { targetId: "fake:cheap" as never, model: "cheap" };
  },
};

/** A stand-in runtime that returns a session log shaped like the real one. */
const modelExecutor: ModelExecutor = {
  async run() {
    return {
      text: "hello",
      events: [
        { type: "step/start", seq: 1, time: 1_000, data: { turn: 1, step: 1 } },
        {
          type: "assistant/chunk",
          seq: 2,
          time: 1_750,
          data: {
            turn: 1,
            step: 1,
            chunk: {
              type: "usage",
              usage: { inputTokens: 3_000, outputTokens: 120 },
            },
          },
        },
      ],
    };
  },
};

function catalogFor(providers: Provider[]): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  registerProviders(catalog, providers);
  return catalog;
}

describe("runTenant", () => {
  it("falls back to a tool-only run and says so, inventing no token counts", async () => {
    const audit = new AuditStore(":memory:");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [],
      providersSkipped: [{ id: "fake", reason: "no key" }],
      tools: [echo],
      catalog: catalogFor([]),
    });
    expect(report.mode).toBe("tool-only");
    expect(report.outcome).toBe("completed");
    expect(report.steps[0]?.text).toContain('{"echoed":"say hello"}');
    const spans = audit.spans(report.runId);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      toolName: "echo",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      provider: "none",
    });
    expect(spans[0]!.toolOutputBytes).toBeGreaterThan(0);
    audit.close();
  });

  it("folds a model step's own session log into a priced span", async () => {
    const audit = new AuditStore(":memory:");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [provider],
      tools: [echo],
      modelExecutor,
      catalog: catalogFor([provider]),
    });
    expect(report.mode).toBe("model");
    expect(report.steps[0]?.targetId).toBe("fake:cheap");
    const spans = audit.spans(report.runId);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      inputTokens: 3_000,
      outputTokens: 120,
      latencyMs: 750,
      provider: "fake",
      model: "cheap",
    });
    // 3000 * 1e-6 + 120 * 2e-6
    expect(spans[0]!.costUsd).toBeCloseTo(0.00324, 9);
    expect(audit.runCost(report.runId)[0]?.usd).toBeCloseTo(0.00324, 9);
    audit.close();
  });

  it("the routed model is what runs, not the provider's own pick", async () => {
    // select() uses models.find(covering) and would land on "pricey" (listed
    // first); the router ranks by price and must land on "bargain" instead.
    const twoModels: Provider = {
      ...provider,
      id: "picky",
      models: [
        {
          id: "pricey",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 9e-6,
          usdOut: 9e-6,
        },
        {
          id: "bargain",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 1e-9,
          usdOut: 1e-9,
        },
      ],
      select: () => ({ targetId: "picky:pricey" as never, model: "pricey" }),
    };
    let seenSelection: { targetId: unknown; model: string } | undefined;
    const audit = new AuditStore(":memory:");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [twoModels],
      tools: [echo],
      catalog: catalogFor([twoModels]),
      modelExecutor: {
        async run(_work, selection) {
          seenSelection = selection;
          return { text: "hello", events: [] };
        },
      },
    });
    expect(report.steps[0]?.targetId).toBe("picky:bargain");
    expect(seenSelection).toMatchObject({
      targetId: "picky:bargain",
      model: "bargain",
    });
    audit.close();
  });

  it("fails budget-exhausted rather than running a step it cannot pay for", async () => {
    const audit = new AuditStore(":memory:");
    const spec = tenant(0.001);
    audit.append({
      runId: "fixed",
      spanId: "s",
      tenant: "demo",
      role: "prober",
      provider: "fake",
      model: "cheap",
      stepNo: 1,
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 10,
      latencyMs: 1,
      costUsd: 0.002,
      summarised: false,
      ts: "2026-09-02T00:00:00.000Z",
    });
    const report = await runTenant({
      tenant: spec,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      runId: "fixed",
      providers: [provider],
      tools: [echo],
      modelExecutor,
      catalog: catalogFor([provider]),
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure?.class).toBe("budget-exhausted");
    expect(report.failure?.detail).toContain("ran out of usd");
    audit.close();
  });

  it("injects the remaining budget into the prompt the step is given", async () => {
    const audit = new AuditStore(":memory:");
    let seen = "";
    await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      modelExecutor: {
        async run(work) {
          seen = work.inputs.prompt ?? "";
          return { text: "", events: [] };
        },
      },
    });
    expect(seen).toContain(
      "[helium budget] remaining 1.0000 USD of 1.00 (100%)",
    );
    expect(seen).toContain("say hello");
    audit.close();
  });

  it("executes through the provider itself when no executor is injected", async () => {
    // The seam M2 needs: a discovered provider owns both routing and running,
    // so adding a vendor is a directory and never a core edit.
    const audit = new AuditStore(":memory:");
    const selfRunning: Provider = {
      ...provider,
      id: "selfrun",
      select: () => ({ targetId: "selfrun:cheap" as never, model: "cheap" }),
      run: async () => ({
        text: "ran in the provider",
        events: [
          {
            type: "step/start",
            seq: 1,
            time: 1_000,
            data: { turn: 1, step: 1 },
          },
          {
            type: "assistant/message",
            seq: 2,
            time: 1_400,
            data: {
              turn: 1,
              step: 1,
              usage: { inputTokens: 40, outputTokens: 4 },
            },
          },
        ],
      }),
    };
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [selfRunning],
      tools: [echo],
      catalog: catalogFor([selfRunning]),
    });

    expect(report.mode).toBe("model");
    expect(report.steps[0]?.text).toBe("ran in the provider");
    const rows = audit.runCost(report.runId);
    expect(rows[0]).toMatchObject({
      provider: "selfrun",
      inputTokens: 40,
      outputTokens: 4,
    });
    audit.close();
  });

  it("registers a flat-rate model unpriced and charges the metered one for its preamble", () => {
    // Unmetered must not read as zero-priced: the router ranks an unpriced
    // target LAST, which is the honest place for a subscription.
    const catalog = catalogFor([
      {
        ...provider,
        id: "sub",
        overheadTokens: 21,
        models: [
          {
            id: "flat",
            caps: ["tool.use"],
            usdIn: 0,
            usdOut: 0,
            unmetered: true,
          },
        ],
      },
      { ...provider, id: "metered", overheadTokens: 500 },
    ]);
    const targets = catalog.snapshot().targets;
    expect(
      targets.find((t) => String(t.targetId) === "sub:flat")?.price,
    ).toBeUndefined();
    expect(
      targets.find((t) => String(t.targetId) === "metered:cheap")?.price,
    ).toEqual({ usdIn: 1e-6, usdOut: 2e-6, overheadInputTokens: 500 });
  });

  it("retires a whole exhausted pool and re-routes to the model that has its own", async () => {
    // The reason quotaDomain exists: retiring only the model that reported 429
    // would route straight to a sibling drawing on the same spent allowance.
    const audit = new AuditStore(":memory:");
    const spent: Provider = {
      ...provider,
      id: "pool",
      models: [
        {
          id: "a",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 1e-9,
          usdOut: 1e-9,
          quotaDomain: "shared",
        },
        {
          id: "b",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 2e-9,
          usdOut: 2e-9,
          quotaDomain: "shared",
        },
      ],
      select: () => ({ targetId: "pool:a" as never, model: "a" }),
      run: async () => {
        throw new ProviderRunFailure("quota-exhausted", "429", "shared");
      },
    };
    const survivor: Provider = {
      ...provider,
      id: "own",
      models: [
        {
          id: "c",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 9e-6,
          usdOut: 9e-6,
          quotaDomain: "separate",
        },
      ],
      select: () => ({ targetId: "own:c" as never, model: "c" }),
      run: async () => ({
        text: "served by the separate allowance",
        events: [
          {
            type: "step/start",
            seq: 1,
            time: 1_000,
            data: { turn: 1, step: 1 },
          },
          {
            type: "assistant/message",
            seq: 2,
            time: 1_100,
            data: {
              turn: 1,
              step: 1,
              usage: { inputTokens: 10, outputTokens: 2 },
            },
          },
        ],
      }),
    };

    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [spent, survivor],
      tools: [echo],
      catalog: catalogFor([spent, survivor]),
    });

    expect(report.outcome).toBe("completed");
    // Both pool models are retired by one 429, not just the one that reported.
    expect(report.steps[0]).toMatchObject({
      failure: "quota-exhausted",
      downgradeReason: expect.stringContaining("2 target(s) retired"),
    });
    expect(report.steps[1]?.text).toBe("served by the separate allowance");
    audit.close();
  });

  it("re-routes at most once, then fails the run with the provider's own class", async () => {
    const audit = new AuditStore(":memory:");
    const alwaysSpent: Provider = {
      ...provider,
      id: "pool",
      models: [
        {
          id: "a",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 1e-9,
          usdOut: 1e-9,
          quotaDomain: "one",
        },
        {
          id: "b",
          caps: ["tool.use", "cheap.bulk"],
          usdIn: 2e-9,
          usdOut: 2e-9,
          quotaDomain: "two",
        },
      ],
      select: () => ({ targetId: "pool:a" as never, model: "a" }),
      run: async () => {
        throw new ProviderRunFailure("quota-exhausted", "429", "one");
      },
    };
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      providers: [alwaysSpent],
      tools: [echo],
      catalog: catalogFor([alwaysSpent]),
    });
    expect(report).toMatchObject({
      outcome: "failed",
      failure: { class: "quota-exhausted" },
    });
    audit.close();
  });

  it("fails the step instead of throwing when a provider breaks", async () => {
    // Before this, an exception out of run() escaped runTenant entirely and
    // took the process with it.
    const audit = new AuditStore(":memory:");
    const broken: Provider = {
      ...provider,
      id: "broken",
      select: () => ({ targetId: "broken:cheap" as never, model: "cheap" }),
      run: async () => {
        throw new Error("socket hung up");
      },
    };
    await expect(
      runTenant({
        tenant: tenant(),
        audit,
        pluginsDir: "/nonexistent",
        stateRoot: "/tmp",
        providers: [broken],
        tools: [echo],
        catalog: catalogFor([broken]),
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      failure: { class: "provider-error", detail: "socket hung up" },
    });
    audit.close();
  });

  it("leaves a target on another allowance alone", () => {
    const catalog = catalogFor([
      {
        ...provider,
        id: "p",
        models: [
          {
            id: "shared",
            caps: ["tool.use"],
            usdIn: 0,
            usdOut: 0,
            quotaDomain: "x",
          },
          {
            id: "own",
            caps: ["tool.use"],
            usdIn: 0,
            usdOut: 0,
            quotaDomain: "y",
          },
        ],
      },
    ]);
    expect(retireQuotaDomain(catalog, [], "x")).toBe(0);
    const targets = catalog.snapshot().targets;
    expect(targets.every((t) => t.available)).toBe(true);
  });
});
