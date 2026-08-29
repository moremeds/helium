import { describe, expect, it } from "vitest";
import { EvidenceLedger, acceptEvidence } from "../src/evidence/ledger.js";

const ref = (n: string) => ({ ref: `artifact://run/${n}`, sha256: n.repeat(64).slice(0, 64) });

const base = {
  assertionId: "P1-CATALOG-REPLAY",
  assertion: "A recorded catalog replays to the same selection decision.",
  acceptanceBound: "Twenty repeats select the same target.",
  assertionClass: "capability",
  evidencePolicyVersion: "p0-1",
  requiredStages: ["raw", "replay"],
  stages: { raw: [ref("a")], replay: [ref("b")] },
  verifier: {
    identity: "pnpm exec vitest run --project unit",
    version: "vitest 3.2.7",
    decision: "pass" as const,
    decidedAt: "2026-08-29T00:00:00.000Z",
  },
  freshness: { recordedAt: "2026-08-29T00:00:00.000Z" },
  status: "PROVEN" as const,
  limitation: "Offline only.",
};

const now = new Date("2026-08-29T00:10:00.000Z");

describe("acceptEvidence", () => {
  it("accepts a policy-complete bundle", () => {
    expect(acceptEvidence(base, now).status).toBe("PROVEN");
  });

  it("names the first missing required stage", () => {
    expect(() =>
      acceptEvidence(
        {
          ...base,
          requiredStages: ["raw", "replay", "regression", "bounded-production"],
          stages: { raw: [ref("a")] },
        },
        now,
      ),
    ).toThrow(/missing required evidence stage: replay/);
  });

  it("accepts an omitted stage only with a recorded not-applicable reason", () => {
    expect(() =>
      acceptEvidence(
        { ...base, requiredStages: ["raw", "replay", "regression"] },
        now,
      ),
    ).toThrow(/missing required evidence stage: regression/);

    expect(
      acceptEvidence(
        {
          ...base,
          requiredStages: ["raw", "replay", "regression"],
          notApplicable: { regression: "No prior release to regress against." },
        },
        now,
      ).status,
    ).toBe("PROVEN");
  });

  it("rejects expired proof", () => {
    expect(() =>
      acceptEvidence(
        {
          ...base,
          freshness: {
            recordedAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-08-15T00:00:00.000Z",
          },
        },
        now,
      ),
    ).toThrow(/expired/);
  });

  it("refuses a PROVEN status on a failing verifier decision", () => {
    expect(() =>
      acceptEvidence(
        { ...base, verifier: { ...base.verifier, decision: "fail" } },
        now,
      ),
    ).toThrow(/PROVEN/);
  });

  it("requires a named limitation on a PARTIAL claim", () => {
    expect(() =>
      acceptEvidence({ ...base, status: "PARTIAL", limitation: "" }, now),
    ).toThrow(/limitation/);
  });
});

describe("EvidenceLedger", () => {
  it("records every accepted decision, append-only", () => {
    const ledger = new EvidenceLedger();
    ledger.accept({ ...base, status: "PARTIAL" }, now);
    ledger.accept(
      {
        ...base,
        verifier: { ...base.verifier, decidedAt: "2026-08-29T00:05:00.000Z" },
      },
      now,
    );
    expect(ledger.history(base.assertionId)).toHaveLength(2);
    expect(ledger.current(base.assertionId)?.status).toBe("PROVEN");
  });

  it("refuses a status promotion carrying no new verifier decision", () => {
    const ledger = new EvidenceLedger();
    ledger.accept({ ...base, status: "PARTIAL" }, now);
    expect(() => ledger.accept(base, now)).toThrow(/new verifier decision/);
  });

  it("never promotes on a renderer's say-so — an unknown status cannot enter", () => {
    const ledger = new EvidenceLedger();
    expect(() =>
      ledger.accept({ ...base, status: "VERIFIED" as never }, now),
    ).toThrow();
  });
});
