import { describe, expect, it } from "vitest";
import { ExactTargetOverrideSchema } from "./exact-target-override.js";

describe("ExactTargetOverrideSchema", () => {
  it("accepts only an opaque target and complete audit authority", () => {
    expect(
      ExactTargetOverrideSchema.parse({
        targetRef: "target-7",
        operator: "operator-1",
        reason: "compare a certified regression",
        purpose: "evaluation",
        expiresAt: "2026-08-30T12:00:00.000Z",
      }),
    ).toBeDefined();
  });

  it("rejects native selection and any attempt to expand work authority", () => {
    for (const forbidden of [
      { model: "provider-model", effort: "max" },
      { tools: ["shell"] },
      { mutations: "permitted" },
      { maxCost: 1_000 },
      { workspace: "/" },
    ]) {
      expect(() =>
        ExactTargetOverrideSchema.parse({
          targetRef: "target-7",
          operator: "operator-1",
          reason: "bounded test",
          purpose: "evaluation",
          expiresAt: "2026-08-30T12:00:00.000Z",
          ...forbidden,
        }),
      ).toThrow();
    }
  });

  it("rejects unapproved purposes", () => {
    expect(() =>
      ExactTargetOverrideSchema.parse({
        targetRef: "target-7",
        operator: "operator-1",
        reason: "ordinary routing",
        purpose: "preference",
        expiresAt: "2026-08-30T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
