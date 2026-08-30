import { describe, expect, it } from "vitest";
import {
  applyClaudeEffortCap,
  claudeSubscriptionCatalog,
  createClaudeCatalog,
  resolveClaudeEffort,
} from "./catalog.js";

describe("Claude subscription provider catalog", () => {
  it("uses the sanitized historical entitlement while live capacity is unavailable", () => {
    expect(claudeSubscriptionCatalog.targets).toEqual([
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        invokeAs: "haiku",
        effort: { supported: false },
      }),
      expect.objectContaining({
        model: "claude-sonnet-5",
        invokeAs: "sonnet",
        effort: {
          supported: true,
          options: ["low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      }),
      expect.objectContaining({
        model: "claude-opus-5",
        invokeAs: "opus",
        effort: expect.objectContaining({ default: "high" }),
      }),
    ]);
    expect(claudeSubscriptionCatalog.executionModes.ultracode.enabled).toBe(false);
  });

  it("applies organization caps and rejects Haiku effort", () => {
    const sonnet = claudeSubscriptionCatalog.targets[1]!;
    const haiku = claudeSubscriptionCatalog.targets[0]!;
    expect(applyClaudeEffortCap(sonnet.effort, "high")).toEqual({
      supported: true,
      options: ["low", "medium", "high"],
      default: "high",
    });
    expect(() => resolveClaudeEffort(haiku, "low")).toThrow(/unsupported/i);
    expect(resolveClaudeEffort(haiku, undefined)).toBeUndefined();
  });

  it("has an order-independent snapshot hash", () => {
    const reversed = createClaudeCatalog(
      [...claudeSubscriptionCatalog.targets].reverse(),
    );
    expect(reversed.snapshotHash).toBe(claudeSubscriptionCatalog.snapshotHash);
  });
});
