import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent, ModelSelection, WorkOrder } from "@helium/core";
import { describe, expect, it } from "vitest";
import { DshHost, type DshSubagentRuntime, type SubagentRun } from "./host.js";
import { createDshContext, registerEcosystemTools } from "./runtime.js";

const ROOT = mkdtempSync(join(tmpdir(), "helium-dsh-test-"));

function work(tools: string[]): WorkOrder {
  return {
    id: "run-1:probe",
    role: "prober",
    taskClass: "probe",
    requires: ["tool.use"],
    constraints: { tools, mutations: "forbidden", minIsolationClass: "in-process" },
    inputs: { artifacts: [], prompt: "go" },
    acceptance: { outputSchema: "text" },
  } as unknown as WorkOrder;
}

describe("dsh runtime", () => {
  // Boot is offline and writes nothing: the jsonl root is created lazily on
  // the first session, and pi-ai resolves its credential per request. That is
  // exactly why `DshProvider.probe()` is allowed to be cheap.
  it("boots every service the host needs with no credential and no network", async () => {
    const ctx = await createDshContext({
      sessionRoot: join(ROOT, "sessions"),
      llmProvider: "anthropic",
      apiKeyEnv: "HELIUM_TEST_NO_SUCH_KEY",
    });
    for (const service of ["llm", "sessions", "tools", "agents", "subagents"] as const) {
      expect(ctx[service], service).toBeDefined();
    }
    expect(ctx.subagents.list()).toContain("spawn");
    expect(await ctx.llm.listProviders()).toEqual([
      { id: "anthropic", name: "anthropic" },
    ]);
  });

  it("registers a tenant tool under its own name and takes it away again", async () => {
    const ctx = await createDshContext({
      sessionRoot: join(ROOT, "sessions"),
      llmProvider: "anthropic",
      apiKeyEnv: "HELIUM_TEST_NO_SUCH_KEY",
    });
    const tool = {
      name: "fake_probe",
      description: "echo",
      paramsSchema: {} as never,
      mutating: false,
      dshParams: { q: { type: "string", required: true, description: "Anything" } },
      run: async (args: Record<string, unknown>) => JSON.stringify({ echoed: args.q }),
    };
    const dispose = registerEcosystemTools(ctx, [tool]);
    expect(ctx.tools.get("fake_probe")).toBeDefined();
    dispose();
    expect(ctx.tools.get("fake_probe")).toBeUndefined();
  });
});

function stubRuntime(seen: Record<string, unknown>[]): DshSubagentRuntime {
  return {
    async start(transport, request) {
      seen.push({ transport, ...request });
      return {
        id: "child",
        result: Promise.resolve({
          output: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          events: [] as LogEvent[],
        }),
        dispose: async () => undefined,
      } satisfies SubagentRun;
    },
    async drainDescendants() {},
    interrupt() {},
  };
}

describe("DshHost.run", () => {
  const selection: ModelSelection = {
    targetId: "dsh:claude-haiku-4-5" as never,
    model: "claude-haiku-4-5",
    options: { providerName: "spawn", provider: "anthropic" },
  };
  const parents = {
    ensure: async () => ({ parent: {}, resumed: false, dispose: async () => undefined }),
  };

  it("starts on the transport and keeps the vendor in agentOptions", async () => {
    const seen: Record<string, unknown>[] = [];
    const host = new DshHost({
      subagents: stubRuntime(seen),
      parents,
      workspacesDir: join(ROOT, "ws"),
      maxDepth: 1,
    });
    await host.run("run-1", work(["fake_probe"]), selection, new AbortController().signal);
    expect(seen[0]!.transport).toBe("spawn");
    expect(seen[0]!.agentOptions).toEqual({
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
    expect(seen[0]!.toolFilter).toEqual({ allow: ["fake_probe"] });
  });

  it("omits the tool filter entirely for a role with no tools", async () => {
    // `tools.restrict({allow: []})` is rejected by dsh outright, so an empty
    // allow-list is not "allow nothing" — it is a start-time throw.
    const seen: Record<string, unknown>[] = [];
    const host = new DshHost({
      subagents: stubRuntime(seen),
      parents,
      workspacesDir: join(ROOT, "ws"),
      maxDepth: 1,
    });
    await host.run("run-1", work([]), selection, new AbortController().signal);
    expect(seen[0]).not.toHaveProperty("toolFilter");
  });
});
