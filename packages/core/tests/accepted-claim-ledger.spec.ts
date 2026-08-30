import { describe, expect, it } from "vitest";
import {
  AcceptedClaimLedger,
  type ClaimDecision,
} from "../src/evidence/ledger.js";

const ref = (name: string) => ({
  ref: `artifact://claim/${name}`,
  sha256: (name === "raw" ? "a" : "b").repeat(64),
});

const now = new Date("2026-08-30T12:00:00.000Z");

const decision = (overrides: Partial<ClaimDecision> = {}): ClaimDecision => ({
  actorRole: "verifier",
  claim: {
    key: "policy.rate_path",
    statement: "Rates remain restrictive.",
    kind: "fact",
    evidenceRefs: ["artifact://claim/raw"],
    confidence: 0.8,
    assumptions: [],
    asOf: "2026-08-30T00:00:00.000Z",
  },
  evidence: {
    assertionId: "policy.rate_path",
    assertion: "Rates remain restrictive.",
    acceptanceBound: "Primary source and independent replay agree.",
    assertionClass: "claim:fact",
    evidencePolicyVersion: "claim-v1",
    requiredStages: ["raw", "replay"],
    stages: { raw: [ref("raw")], replay: [ref("replay")] },
    verifier: {
      identity: "claim-verifier",
      version: "1.0.0",
      decision: "pass",
      decidedAt: "2026-08-30T11:00:00.000Z",
    },
    freshness: { recordedAt: "2026-08-30T11:00:00.000Z" },
    executionSnapshot: {
      targetId: "target-a",
      providerId: "provider-a",
      model: "model-a",
      effort: "high",
      providerVersion: "1.0.0",
      isolationClass: "process",
      recordedAt: "2026-08-30T11:00:00.000Z",
    },
    status: "PROVEN",
    limitation: "Macro conditions can change after the as-of time.",
  },
  ...overrides,
});

describe("AcceptedClaimLedger", () => {
  it("accepts a complete and fresh factual claim", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: false });
    expect(ledger.publish(decision(), now)).toMatchObject({
      claim: { key: "policy.rate_path" },
      evidence: { status: "PROVEN" },
    });
    expect(ledger.current("policy.rate_path")?.claim.statement).toBe(
      "Rates remain restrictive.",
    );
  });

  it("rejects expired, incomplete, and unbound evidence", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: false });
    expect(() =>
      ledger.publish(
        decision({
          evidence: {
            ...decision().evidence,
            freshness: {
              recordedAt: "2026-08-01T00:00:00.000Z",
              expiresAt: "2026-08-15T00:00:00.000Z",
            },
          },
        }),
        now,
      ),
    ).toThrow(/expired/);

    expect(() =>
      ledger.publish(
        decision({
          evidence: { ...decision().evidence, stages: { raw: [ref("raw")] } },
        }),
        now,
      ),
    ).toThrow(/missing required evidence stage: replay/);

    expect(() =>
      ledger.publish(
        decision({
          claim: { ...decision().claim, evidenceRefs: ["artifact://claim/missing"] },
        }),
        now,
      ),
    ).toThrow(/not bound to hashed evidence/);
  });

  it("does not let a renderer add, remove, or promote a claim", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: true });
    expect(() =>
      ledger.publish(decision({ actorRole: "renderer" }), now),
    ).toThrow(/renderer cannot add or promote claims/);
    expect(() => ledger.remove("renderer", "policy.rate_path")).toThrow(
      /renderer cannot remove claims/,
    );
  });

  it("keeps PARTIAL labelled when delivery policy permits it", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: true });
    const accepted = ledger.publish(
      decision({
        evidence: {
          ...decision().evidence,
          status: "PARTIAL",
          verifier: { ...decision().evidence.verifier, decision: "inconclusive" },
          limitation: "No bounded-production observation yet.",
        },
      }),
      now,
    );
    expect(accepted.evidence.status).toBe("PARTIAL");
    expect(ledger.current("policy.rate_path")?.evidence.status).toBe("PARTIAL");
  });

  it("replay preserves hashes, verifier version, execution snapshot, and limitations", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: false });
    ledger.publish(decision(), now);

    const replayed = AcceptedClaimLedger.replay(ledger.entries(), {
      allowPartial: false,
    });
    const current = replayed.current("policy.rate_path");
    expect(current?.evidence.stages.raw?.[0]?.sha256).toBe(ref("raw").sha256);
    expect(current?.evidence.verifier.version).toBe("1.0.0");
    expect(current?.evidence.executionSnapshot).toEqual(
      decision().evidence.executionSnapshot,
    );
    expect(current?.evidence.limitation).toBe(
      "Macro conditions can change after the as-of time.",
    );
  });
});
