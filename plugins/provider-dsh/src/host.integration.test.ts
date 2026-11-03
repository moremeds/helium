import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { CordisRunParentFactory, CordisSubagentRuntime, DshHost } from "./host.js";
import { createDshContext, registerEcosystemTools } from "./runtime.js";
import type { WorkOrder } from "@helium/core";

const ROOT = mkdtempSync(join(tmpdir(), "helium-dsh-policy-"));

class FakeLlm extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const tool = options.tools?.find(({ name }) => ["allowed", "scope_local", "structured_output"].includes(name));
    const called = options.messages.some((message) => message.role === "tool");
    if (tool !== undefined && !called) {
      const block = { type: "tool-call" as const, id: ToolCallId("fake-call"), name: tool.name, arguments: tool.name === "structured_output" ? '{"ok":true}' : "{}" };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
      yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}

describe("real DSH child tool policy (offline fake LLM)", () => {
  it.each([
    { allow: ["allowed"], local: false, visible: ["allowed"] },
    { allow: [], local: false, visible: [] },
    { allow: [], local: true, visible: ["scope_local"] },
  ])("keeps the full tool set at $visible", async ({ allow, local, visible }) => {
    const root = mkdtempSync(join(ROOT, "case-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    const fake = new FakeLlm();
    ctx.llm.registerAdapter(["fake"], fake);
    ctx.on("agent/created", ({ agent }) => { agent.ctx.tools.presentAs("native"); return undefined; });
    const executed: string[] = [];
    registerEcosystemTools(ctx, ["allowed", "forbidden"].map((name) => ({
      name, description: name, paramsSchema: {} as never, mutating: false,
      run: async () => { executed.push(name); return name; },
    })));
    if (local) ctx.on("agent/created", ({ agent }) => {
      if (agent.session.header.parentSession === undefined) return;
      agent.ctx.tools.register(defineTool({
        name: "scope_local", description: "local exception", parameters: {},
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        execute: async () => { executed.push("scope_local"); return "local"; },
      }));
      return undefined;
    });
    const runtime = new CordisSubagentRuntime(ctx);
    const host = new DshHost({ subagents: runtime, parents: new CordisRunParentFactory(ctx), workspacesDir: join(root, "ws"), maxDepth: 1, persona: "ROLE-PERSONA" });
    const work = {
      id: "run:probe", role: "prober", taskClass: "probe", requires: [],
      constraints: { tools: allow, mutations: "forbidden", minIsolationClass: "in-process" },
      inputs: { artifacts: [], prompt: "go" }, acceptance: { outputSchema: "text" },
    } as unknown as WorkOrder;
    try {
      const result = await host.run("run", work, { targetId: "fake:test" as never, model: "test", options: { providerName: "spawn", provider: "fake" } }, new AbortController().signal);
      expect(result.text).toBe("ok");
      expect(fake.calls.length).toBeGreaterThan(0);
      for (const call of fake.calls) {
        expect((call.tools ?? []).map(({ name }) => name).sort()).toEqual(visible);
        expect(JSON.stringify(call.messages)).toContain("ROLE-PERSONA");
        expect(JSON.stringify(call.messages)).not.toContain("Check the [exit code: N] marker on every bash result");
      }
      expect(executed).toEqual(visible);
      expect(result.events.some(({ type }) => type === "assistant/message")).toBe(true);
      expect(result.events.some(({ type }) => type === "turn/end")).toBe(true);
      expect(result.events.filter(({ type }) => type === "assistant/message").at(-1)).toMatchObject({ data: { usage: { inputTokens: 7, outputTokens: 2 } } });
    } finally {
      await host.close("run");
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });

  it("enforces maxDepth and leaves no children after close", async () => {
    const root = mkdtempSync(join(ROOT, "depth-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    ctx.llm.registerAdapter(["fake"], new FakeLlm());
    const host = new DshHost({ subagents: new CordisSubagentRuntime(ctx), parents: new CordisRunParentFactory(ctx), workspacesDir: join(root, "ws"), maxDepth: 0 });
    try {
      await expect(host.run("run", {
        id: "run:probe", role: "prober", taskClass: "probe", constraints: { tools: [] }, inputs: { prompt: "go" },
      } as unknown as WorkOrder, { targetId: "fake:test" as never, model: "test", options: { providerName: "spawn", provider: "fake" } }, new AbortController().signal)).rejects.toThrow(/depth/i);
    } finally {
      await host.close("run");
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });

  it("reapplies policy and persona on cold resume until disposal", async () => {
    const root = mkdtempSync(join(ROOT, "resume-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    const fake = new FakeLlm();
    ctx.llm.registerAdapter(["fake"], fake);
    const sources: string[] = [];
    ctx.on("agent/created", ({ agent, source }) => {
      agent.ctx.tools.presentAs("native");
      if (agent.session.header.parentSession !== undefined) sources.push(source);
      return undefined;
    });
    registerEcosystemTools(ctx, [{ name: "forbidden", description: "hidden", paramsSchema: {} as never, mutating: false, run: async () => "hidden" }]);
    const parents = new CordisRunParentFactory(ctx);
    const parent = await parents.ensure({ runId: "run", workspace: join(root, "ws") });
    const runtime = new CordisSubagentRuntime(ctx);
    const child = await runtime.start("spawn", {
      prompt: [{ type: "text", text: "go" }], parent: parent.parent,
      signal: new AbortController().signal, agentOptions: { provider: "fake", model: "test" },
      maxDepth: 1, allow: [], persona: "RESUMED-PERSONA",
    });
    try {
      await child.result;
      expect(ctx.agents.get(child.id as never)).toBeUndefined();
      const resumed = await ctx.agents.resume({ resumeSessionId: child.id as never, agentOptions: { provider: "fake", model: "test" } });
      try {
        resumed.agent.followup(createUserMessage({ content: [{ type: "text", text: "again" }], source: { kind: "user" } }));
        await resumed.agent.whenIdle();
        expect(sources).toEqual(["startup", "resume"]);
        expect(fake.calls).toHaveLength(2);
        for (const call of fake.calls) {
          expect((call.tools ?? []).map(({ name }) => name)).toEqual([]);
          expect(JSON.stringify(call.messages)).toContain("RESUMED-PERSONA");
        }
      } finally { await resumed.dispose(); }
    } finally {
      await child.dispose();
      await parent.dispose();
      const resumedParent = await parents.ensure({ runId: "run", workspace: join(root, "ws") });
      expect(resumedParent.resumed).toBe(true);
      await resumedParent.dispose();
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });

  it("maps the new turn/end failure shape into providerFailure", async () => {
    const root = mkdtempSync(join(ROOT, "failure-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    class RejectedLlm extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: "finish", reason: { kind: "error", failure: { code: "BAD_REQUEST", status: 400, message: "fake provider refusal", providerRetryAfterMs: 12 } } };
      }
    }
    ctx.llm.registerAdapter(["fake"], new RejectedLlm());
    const parent = await new CordisRunParentFactory(ctx).ensure({ runId: "run", workspace: join(root, "ws") });
    const child = await new CordisSubagentRuntime(ctx).start("spawn", {
      prompt: [{ type: "text", text: "go" }], parent: parent.parent,
      signal: new AbortController().signal, agentOptions: { provider: "fake", model: "test" },
      maxDepth: 1, allow: [], persona: "prober",
    });
    try {
      expect((await child.result).providerFailure).toEqual({ code: "BAD_REQUEST", status: 400, message: "fake provider refusal", retryAfterMs: 12 });
    } finally {
      await child.dispose();
      await parent.dispose();
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });

  it("retains only the scoped structured_output tool under an empty allow-list", async () => {
    const root = mkdtempSync(join(ROOT, "structured-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    const fake = new FakeLlm();
    ctx.llm.registerAdapter(["fake"], fake);
    ctx.on("agent/created", ({ agent }) => { agent.ctx.tools.presentAs("native"); return undefined; });
    registerEcosystemTools(ctx, [{ name: "forbidden", description: "hidden", paramsSchema: {} as never, mutating: false, run: async () => "hidden" }]);
    const parent = await new CordisRunParentFactory(ctx).ensure({ runId: "run", workspace: join(root, "ws") });
    const child = await new CordisSubagentRuntime(ctx).start("spawn", {
      prompt: [{ type: "text", text: "go" }], parent: parent.parent,
      signal: new AbortController().signal, agentOptions: { provider: "fake", model: "test" },
      maxDepth: 1, allow: [], persona: "prober",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    });
    try {
      expect((await child.result).structured).toEqual({ ok: true });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.tools?.map(({ name }) => name)).toEqual(["structured_output"]);
    } finally {
      await child.dispose();
      await parent.dispose();
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });

  it("interrupts a running activation when the caller aborts", async () => {
    const root = mkdtempSync(join(ROOT, "abort-"));
    const ctx = await createDshContext({ sessionRoot: join(root, "sessions"), llmProvider: "unused", apiKeyEnv: "NO_SUCH_KEY" });
    const started = Promise.withResolvers<void>();
    class BlockingLlm extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) resolve();
          else options.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "fake cancelled" } } };
      }
    }
    ctx.llm.registerAdapter(["fake"], new BlockingLlm());
    const parent = await new CordisRunParentFactory(ctx).ensure({ runId: "run", workspace: join(root, "ws") });
    const controller = new AbortController();
    const child = await new CordisSubagentRuntime(ctx).start("spawn", {
      prompt: [{ type: "text", text: "go" }], parent: parent.parent, signal: controller.signal,
      agentOptions: { provider: "fake", model: "test" }, maxDepth: 1, allow: [], persona: "prober",
    });
    try {
      await started.promise;
      controller.abort();
      expect((await child.result).stopReason).toBe("aborted");
    } finally {
      await child.dispose();
      await parent.dispose();
      expect(ctx.agents.list()).toEqual([]);
      await ctx.fiber.dispose();
    }
  });
});
