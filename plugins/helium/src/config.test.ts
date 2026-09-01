import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.js";

const base = {
  tenantsDir: "/private/plugins",
  stateRoot: "/private/state",
  contextFile: "context",
  argonBase: "http://argon",
  apexBase: "http://apex",
  envFile: "env",
  claudeTokenFile: "claude",
  proxy: "http://proxy",
  mcpBin: "/bin/helium-mcp",
  emailTo: "operator@example.invalid",
};

describe("ConfigSchema", () => {
  // Without `delivered` in the enum, ConfigSchema.parse throws at plugin load
  // on HELIUM_TEAM_PROMOTION_MODE=delivered and the mode can never be selected.
  it.each(["off", "shadow", "review-only", "delivered"] as const)(
    "round-trips promotion mode %s",
    (mode) => {
      expect(
        ConfigSchema.parse({ ...base, teamPromotionMode: mode })
          .teamPromotionMode,
      ).toBe(mode);
    },
  );

  it("refuses a promotion mode outside the four", () => {
    expect(() =>
      ConfigSchema.parse({ ...base, teamPromotionMode: "auto-send" }),
    ).toThrow();
  });

  it("defaults the tenant delivery opt-in to OFF", () => {
    expect(ConfigSchema.parse(base).tenantDeliveryEnabled).toBe(false);
    expect(ConfigSchema.parse(base).teamCanaryTenants).toEqual([]);
  });

  it("requires an explicit tenantsDir", () => {
    const { tenantsDir: _omitted, ...without } = base;
    expect(() => ConfigSchema.parse(without)).toThrow();
  });
});
