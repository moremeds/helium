import { describe, expect, it } from "vitest";
import {
  codexSubscriptionCatalog,
  createCodexCatalog,
  resolveCodexEffort,
} from "./catalog.js";

describe("Codex subscription provider catalog", () => {
  it("freezes the current account-visible model matrix", () => {
    expect(codexSubscriptionCatalog.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "gpt-5.6-sol",
          enabled: true,
          quotaDomain: "codex-subscription-session",
          effort: {
            supported: true,
            options: ["low", "medium", "high", "xhigh", "max"],
            default: "low",
          },
        }),
        expect.objectContaining({
          model: "gpt-5.6-terra",
          enabled: true,
          effort: expect.objectContaining({ default: "medium" }),
        }),
        expect.objectContaining({
          model: "gpt-5.6-luna",
          enabled: true,
          effort: expect.objectContaining({ default: "medium" }),
        }),
        expect.objectContaining({ model: "gpt-5.3-codex-spark", enabled: false }),
        expect.objectContaining({ model: "codex-auto-review", enabled: false }),
      ]),
    );
  });

  it("keeps orchestration out of native effort", () => {
    const sol = codexSubscriptionCatalog.targets.find(
      (target) => target.model === "gpt-5.6-sol",
    )!;
    expect(resolveCodexEffort(sol, "max")).toBe("max");
    expect(() => resolveCodexEffort(sol, "ultra")).toThrow(/orchestration/i);
    expect(codexSubscriptionCatalog.executionModes.ultra.enabled).toBe(false);
  });

  it("has an order-independent snapshot hash", () => {
    const reversed = createCodexCatalog(
      [...codexSubscriptionCatalog.targets].reverse(),
    );
    expect(reversed.snapshotHash).toBe(codexSubscriptionCatalog.snapshotHash);
  });
});
