import { describe, expect, it } from "vitest";
import {
  EntitlementCertificationSchema,
  stableProviderTargetId,
} from "../src/registration.js";

describe("provider target identity", () => {
  it("is opaque, stable, and independent of registration order", () => {
    const native = ["model-a|effort=high", "model-b|effort=low"];
    const forward = new Map(
      native.map((key) => [
        key,
        stableProviderTargetId("provider-plugin@1", "catalog-v1", key),
      ]),
    );
    const reversed = new Map(
      [...native].reverse().map((key) => [
        key,
        stableProviderTargetId("provider-plugin@1", "catalog-v1", key),
      ]),
    );
    expect(reversed).toEqual(forward);
    expect([...forward.values()]).toEqual([
      expect.stringMatching(/^target-[a-f0-9]+$/),
      expect.stringMatching(/^target-[a-f0-9]+$/),
    ]);
  });

  it("rejects duplicate certification variants", () => {
    expect(() =>
      EntitlementCertificationSchema.parse({
        certificationVersion: "fixture-v1",
        catalogSnapshotHash: "hash",
        recordedAt: "2026-08-30T00:00:00.000Z",
        source: "fixture",
        targets: [{ targetRef: "target-a", variants: ["high", "high"] }],
      }),
    ).toThrow(/duplicate certified variant/i);
  });
});
