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
  type Provider,
} from "@helium/core";
import { registerProviders, runTenant, type ModelExecutor } from "./runner.js";

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
    { id: "cheap", caps: ["tool.use", "cheap.bulk"], usdIn: 1e-6, usdOut: 2e-6 },
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
            chunk: { type: "usage", usage: { inputTokens: 3_000, outputTokens: 120 } },
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

  it("fails budget-exhausted rather than running a step it cannot pay for", async () => {
    const audit = new AuditStore(":memory:");
    const spec = tenant(0.001);
    audit.append({
      runId: "fixed", spanId: "s", tenant: "demo", role: "prober", provider: "fake",
      model: "cheap", stepNo: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0,
      contextSize: 10, latencyMs: 1, costUsd: 0.002, summarised: false,
      ts: "2026-09-02T00:00:00.000Z",
    });
    const report = await runTenant({
      tenant: spec, audit, pluginsDir: "/nonexistent", stateRoot: "/tmp",
      runId: "fixed", providers: [provider], tools: [echo], modelExecutor,
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
      tenant: tenant(), audit, pluginsDir: "/nonexistent", stateRoot: "/tmp",
      providers: [provider], tools: [echo], catalog: catalogFor([provider]),
      modelExecutor: {
        async run(work) {
          seen = work.inputs.prompt ?? "";
          return { text: "", events: [] };
        },
      },
    });
    expect(seen).toContain("[helium budget] remaining 1.0000 USD of 1.00 (100%)");
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
          { type: "step/start", seq: 1, time: 1_000, data: { turn: 1, step: 1 } },
          {
            type: "assistant/message",
            seq: 2,
            time: 1_400,
            data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 4 } },
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
    expect(rows[0]).toMatchObject({ provider: "selfrun", inputTokens: 40, outputTokens: 4 });
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
          { id: "flat", caps: ["tool.use"], usdIn: 0, usdOut: 0, unmetered: true },
        ],
      },
      { ...provider, id: "metered", overheadTokens: 500 },
    ]);
    const targets = catalog.snapshot().targets;
    expect(targets.find((t) => String(t.targetId) === "sub:flat")?.price).toBeUndefined();
    expect(
      targets.find((t) => String(t.targetId) === "metered:cheap")?.price,
    ).toEqual({ usdIn: 1e-6, usdOut: 2e-6, overheadInputTokens: 500 });
  });
});
