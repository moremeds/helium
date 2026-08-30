import { describe, expect, it } from "vitest";
import {
  ProviderCatalogSchema,
  ProviderTargetSchema,
  parseProviderCatalog,
} from "../src/catalog.js";

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetRef: "target-1",
    model: "provider-model",
    invokeAs: "provider-model",
    quotaDomain: "subscription-session",
    enabled: true,
    effort: {
      supported: true,
      options: ["low", "medium", "high"],
      default: "high",
    },
    ...overrides,
  };
}

describe("ProviderTargetSchema", () => {
  it("accepts a strict provider-owned effort scale", () => {
    expect(ProviderTargetSchema.parse(target())).toMatchObject({
      effort: { supported: true, default: "high" },
    });
  });

  it("accepts a target with no native effort control", () => {
    expect(
      ProviderTargetSchema.parse(
        target({ effort: { supported: false }, invokeAs: undefined }),
      ).effort,
    ).toEqual({ supported: false });
  });

  it("rejects duplicate options and invalid defaults", () => {
    expect(() =>
      ProviderTargetSchema.parse(
        target({
          effort: {
            supported: true,
            options: ["low", "low"],
            default: "low",
          },
        }),
      ),
    ).toThrow(/duplicate effort option/i);

    expect(() =>
      ProviderTargetSchema.parse(
        target({
          effort: {
            supported: true,
            options: ["low", "high"],
            default: "medium",
          },
        }),
      ),
    ).toThrow(/default.*options/i);
  });

  it("rejects provider orchestration modes disguised as effort", () => {
    for (const mode of ["ultra", "ultracode"]) {
      expect(() =>
        ProviderTargetSchema.parse(
          target({
            effort: { supported: true, options: [mode], default: mode },
          }),
        ),
      ).toThrow(/orchestration mode/i);
    }
  });

  it("limits an effort scale to eight non-empty options", () => {
    expect(() =>
      ProviderTargetSchema.parse(
        target({
          effort: {
            supported: true,
            options: Array.from({ length: 9 }, (_, index) => `level-${index}`),
            default: "level-0",
          },
        }),
      ),
    ).toThrow();
  });
});

describe("ProviderCatalogSchema", () => {
  it("caps a provider catalog at 32 unique native targets", () => {
    const targets = Array.from({ length: 32 }, (_, index) =>
      target({ targetRef: `target-${index}` }),
    );
    expect(
      ProviderCatalogSchema.parse({
        catalogVersion: "fixture-v1",
        targets,
      }).targets,
    ).toHaveLength(32);

    expect(() =>
      parseProviderCatalog({
        catalogVersion: "fixture-v1",
        targets: [...targets, target({ targetRef: "target-33" })],
      }),
    ).toThrow();
  });

  it("rejects duplicate target references and unknown fields", () => {
    expect(() =>
      parseProviderCatalog({
        catalogVersion: "fixture-v1",
        targets: [target(), target()],
      }),
    ).toThrow(/duplicate target reference/i);

    expect(() =>
      ProviderCatalogSchema.parse({
        catalogVersion: "fixture-v1",
        targets: [target()],
        score: 1,
      }),
    ).toThrow();
  });
});
