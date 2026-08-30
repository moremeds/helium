import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_EFFORT_ORDER,
  createDeepSeekCatalog,
  deepseekDshCatalog,
  resolveDeepSeekEffort,
} from "./catalog.js";

describe("DeepSeek DSH provider catalog", () => {
  it("freezes the account-visible native model and effort matrix", () => {
    expect(deepseekDshCatalog.targets).toEqual([
      expect.objectContaining({
        model: "deepseek-v4-flash",
        enabled: true,
        quotaDomain: "deepseek-api-key",
        effort: {
          supported: true,
          options: ["off", "low", "high", "max"],
          default: "high",
        },
      }),
      expect.objectContaining({ model: "deepseek-v4-pro", enabled: true }),
      expect.objectContaining({
        model: "deepseek-v4-flash-vision-exp",
        enabled: false,
      }),
    ]);
    expect(DEEPSEEK_EFFORT_ORDER).toEqual(["off", "low", "high", "max"]);
  });

  it("resolves only provider-native effort values", () => {
    expect(resolveDeepSeekEffort(deepseekDshCatalog.targets[0]!, undefined)).toBe(
      "high",
    );
    expect(resolveDeepSeekEffort(deepseekDshCatalog.targets[0]!, "max")).toBe(
      "max",
    );
    expect(() =>
      resolveDeepSeekEffort(deepseekDshCatalog.targets[0]!, "medium"),
    ).toThrow(/unsupported/i);
  });

  it("has an order-independent snapshot hash", () => {
    const reversed = createDeepSeekCatalog(
      [...deepseekDshCatalog.targets].reverse(),
    );
    expect(reversed.snapshotHash).toBe(deepseekDshCatalog.snapshotHash);
  });
});
