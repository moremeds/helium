import { describe, expect, it } from "vitest";
import provider, { DSH_MODELS, DshProvider, dshTargetId } from "./provider.js";
import { SUBAGENT_TRANSPORT, authHeaders } from "./runtime.js";

describe("dsh provider", () => {
  it("is the default export and declares the union of its models' capabilities", () => {
    expect(provider.id).toBe("dsh");
    expect(provider.capabilities).toContain("reason.deep");
    expect(provider.capabilities).toContain("cheap.bulk");
    expect(provider.capabilities).toEqual([...provider.capabilities].sort());
  });

  it("can execute a step, not merely route one", () => {
    expect(typeof provider.run).toBe("function");
  });

  it("prices every model per token, not per million", () => {
    for (const model of DSH_MODELS) {
      expect(model.usdIn).toBeGreaterThan(0);
      expect(model.usdIn).toBeLessThan(1e-3);
      expect(model.usdOut).toBeGreaterThan(0);
    }
  });

  it("probes dead without a key rather than failing the load", async () => {
    await expect(new DshProvider({} as NodeJS.ProcessEnv).probe()).resolves.toBe(false);
    await expect(
      new DshProvider({ ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv).probe(),
    ).resolves.toBe(true);
    expect(new DshProvider({} as NodeJS.ProcessEnv).probeReason()).not.toContain("x");
  });

  it("lets the operator name which credential env holds the key", async () => {
    const env = {
      HELIUM_DSH_CREDENTIAL: "CLAUDE_CODE_OAUTH_TOKEN",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x",
    } as unknown as NodeJS.ProcessEnv;
    await expect(new DshProvider(env).probe()).resolves.toBe(true);
    expect(new DshProvider(env).probeReason()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("selects the cheapest model covering the requirement", () => {
    const selection = new DshProvider().select({
      role: "prober",
      requires: ["tool.use", "cheap.bulk"],
    });
    expect(selection.model).toBe("claude-haiku-4-5");
    expect(selection.targetId).toBe(dshTargetId("claude-haiku-4-5"));
  });

  it("routes on the subagent TRANSPORT, not on an LLM vendor name", () => {
    // The regression this guards: `providerName: "deepseek"` shipped once and
    // resolves to no transport at all, because that argument names the
    // subagent backend registry, not the model vendor.
    const selection = new DshProvider().select({ role: "x", requires: ["tool.use"] });
    expect(selection.options?.providerName).toBe(SUBAGENT_TRANSPORT);
    expect(selection.options?.provider).toBe("anthropic");
  });

  it("refuses rather than downgrading below what a role requires", () => {
    expect(() =>
      new DshProvider().select({ role: "x", requires: ["code.edit", "cheap.bulk"] }),
    ).toThrow(/no model covering/);
  });

  it("sends an OAuth token as a bearer, and an API key not at all", () => {
    expect(authHeaders("sk-ant-oat01-abc")).toEqual({
      authorization: "Bearer sk-ant-oat01-abc",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(authHeaders("sk-ant-api03-abc")).toEqual({});
    expect(authHeaders(undefined)).toEqual({});
  });
});
