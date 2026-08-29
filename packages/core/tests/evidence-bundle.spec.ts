import { describe, expect, it } from "vitest";
import {
  EVIDENCE_STAGES,
  EVIDENCE_STATUSES,
  EvidenceBundleSchema,
} from "../src/evidence/bundle.js";

const bundle = {
  assertionId: "P1-NEUTRALITY",
  assertion: "packages/core/src names no provider and no business domain.",
  acceptanceBound: "Zero matches across the whole directory.",
  assertionClass: "capability",
  evidencePolicyVersion: "p0-1",
  requiredStages: ["raw", "replay"],
  stages: {
    raw: [{ ref: "artifact://run/raw", sha256: "a".repeat(64) }],
    replay: [{ ref: "artifact://run/replay", sha256: "b".repeat(64) }],
  },
  verifier: {
    identity: "pnpm run test:contracts",
    version: "vitest 3.2.7",
    decision: "pass",
    decidedAt: "2026-08-29T00:00:00.000Z",
  },
  freshness: { recordedAt: "2026-08-29T00:00:00.000Z" },
  status: "PROVEN",
  limitation: "Proves the scan, not the absence of a provider name at runtime.",
};

describe("EvidenceBundleSchema", () => {
  it("parses a policy-complete bundle", () => {
    expect(EvidenceBundleSchema.parse(bundle).status).toBe("PROVEN");
  });

  it("admits exactly the canonical status vocabulary", () => {
    expect([...EVIDENCE_STATUSES]).toEqual([
      "PLANNED",
      "PARTIAL",
      "PROVEN",
      "FAILED",
      "BLOCKED",
    ]);
    for (const status of EVIDENCE_STATUSES) {
      expect(EvidenceBundleSchema.parse({ ...bundle, status }).status).toBe(status);
    }
    expect(() =>
      EvidenceBundleSchema.parse({ ...bundle, status: "VERIFIED" }),
    ).toThrow();
    // `AgentResult.outcome` is never an evidence verdict.
    expect(() =>
      EvidenceBundleSchema.parse({ ...bundle, status: "completed" }),
    ).toThrow();
  });

  it("rejects an unknown evidence stage", () => {
    expect([...EVIDENCE_STAGES]).toEqual([
      "raw",
      "replay",
      "regression",
      "bounded-production",
    ]);
    expect(() =>
      EvidenceBundleSchema.parse({ ...bundle, requiredStages: ["vibes"] }),
    ).toThrow();
  });

  it("rejects an artifact reference with no hash", () => {
    expect(() =>
      EvidenceBundleSchema.parse({
        ...bundle,
        stages: { ...bundle.stages, raw: [{ ref: "artifact://run/raw" }] },
      }),
    ).toThrow();
  });

  it("rejects a verifier decision outside pass/fail/inconclusive", () => {
    expect(() =>
      EvidenceBundleSchema.parse({
        ...bundle,
        verifier: { ...bundle.verifier, decision: "completed" },
      }),
    ).toThrow();
  });
});
