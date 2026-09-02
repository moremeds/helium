import { describe, expect, it } from "vitest";
import provider, { DSH_MODELS, DshProvider, dshTargetId } from "./provider.js";

describe("dsh provider", () => {
  it("is the default export and declares the union of its models' capabilities", () => {
    expect(provider.id).toBe("dsh");
    expect(provider.capabilities).toContain("reason.deep");
    expect(provider.capabilities).toContain("cheap.bulk");
    expect(provider.capabilities).toEqual([...provider.capabilities].sort());
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
      new DshProvider({ DEEPSEEK_API_KEY: "x" } as NodeJS.ProcessEnv).probe(),
    ).resolves.toBe(true);
    expect(new DshProvider({} as NodeJS.ProcessEnv).probeReason()).not.toContain("x");
  });

  it("selects the cheapest model covering the requirement", () => {
    const selection = new DshProvider().select({
      role: "prober",
      requires: ["tool.use", "cheap.bulk"],
    });
    expect(selection.model).toBe("deepseek-chat");
    expect(selection.targetId).toBe(dshTargetId("deepseek-chat"));
  });

  it("refuses rather than downgrading below what a role requires", () => {
    expect(() =>
      new DshProvider().select({ role: "x", requires: ["code.edit", "cheap.bulk"] }),
    ).toThrow(/no model covering/);
  });
});
