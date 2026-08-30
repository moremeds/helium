import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalLedger,
  FileOperatorEnvelopeStore,
  OperatorEnvelopeVerifier,
  approvalSigningPayload,
  interventionSigningPayload,
  type SignedApprovalEnvelope,
  type SignedInterventionEnvelope,
} from "./approval.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519").privateKey;

function approval(
  overrides: Partial<SignedApprovalEnvelope> = {},
  key = privateKey,
): SignedApprovalEnvelope {
  const unsigned = {
    kind: "approval" as const,
    operatorId: "operator-1",
    nonce: "nonce-approval-1",
    issuedAt: "2026-08-29T23:59:00.000Z",
    approval: {
      incidentId: "fixture-service|integrity|failed|fixture-service",
      sopId: "repair-fixture",
      sopVersion: 1,
      sopDigest: `sha256:${"a".repeat(64)}`,
      promotionId: "fixture-promotion",
      promotionInputSha256: "b".repeat(64),
      attempt: 1 as const,
      expiresAt: "2026-08-30T00:10:00.000Z",
    },
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, approvalSigningPayload(unsigned), key).toString("base64"),
  };
}

function intervention(
  overrides: Partial<SignedInterventionEnvelope> = {},
  key = privateKey,
): SignedInterventionEnvelope {
  const unsigned = {
    kind: "intervention" as const,
    operatorId: "operator-1",
    nonce: "nonce-intervention-1",
    issuedAt: "2026-08-29T23:59:00.000Z",
    expiresAt: "2026-08-30T00:10:00.000Z",
    intervention: {
      componentId: "fixture-service",
      interventionKind: "manual-repair",
      confirmed: true,
      at: "2026-08-30T00:00:00.000Z",
    },
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, interventionSigningPayload(unsigned), key).toString(
      "base64",
    ),
  };
}

describe("ApprovalLedger", () => {
  it("accepts one matching signed approval and exposes the core approval", () => {
    const ledger = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
    const accepted = ledger.accept(approval());
    expect(accepted).toMatchObject({ sopId: "repair-fixture", sopVersion: 1 });
    expect(
      ledger.find(
        "fixture-service|integrity|failed|fixture-service",
        "repair-fixture",
      ),
    ).toEqual(accepted);
  });

  it("rejects signature tampering, an untrusted key, expiry, and nonce replay", () => {
    const ledger = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
    const tampered = approval();
    tampered.approval.sopId = "other-sop";
    expect(() => ledger.accept(tampered)).toThrow(/signature/);
    expect(() =>
      ledger.accept(approval({ nonce: "nonce-other-key" }, otherKey)),
    ).toThrow(/signature/);
    expect(() =>
      ledger.accept(
        approval({
          nonce: "nonce-expired",
          approval: {
            ...approval().approval,
            expiresAt: "2026-08-29T23:59:59.999Z",
          },
        }),
      ),
    ).toThrow(/expired/);

    const once = approval({ nonce: "nonce-replay" });
    ledger.accept(once);
    expect(() => ledger.accept(once)).toThrow(/replay/);
  });

  it("refuses malformed envelopes before signature verification", () => {
    const ledger = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
    expect(() => ledger.accept({ ...approval(), command: "rm -rf" })).toThrow();
  });

  it("persists accepted approvals and refuses the same nonce after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-approval-ledger-"));
    const first = new ApprovalLedger({
      trustedKey: publicKey,
      now: () => NOW,
      persistence: new FileOperatorEnvelopeStore(dir),
    });
    const envelope = approval({ nonce: "nonce-durable-approval" });
    const accepted = first.accept(envelope);

    const restarted = new ApprovalLedger({
      trustedKey: publicKey,
      now: () => NOW,
      persistence: new FileOperatorEnvelopeStore(dir),
    });
    expect(restarted.find(accepted.incidentId, accepted.sopId)).toEqual(accepted);
    expect(() => restarted.accept(envelope)).toThrow(/replay/);
  });
});

describe("OperatorEnvelopeVerifier", () => {
  it("requires a signed intervention even when a same-uid caller reaches IPC", () => {
    const verifier = new OperatorEnvelopeVerifier({
      trustedKey: publicKey,
      now: () => NOW,
    });
    expect(verifier.acceptIntervention(intervention())).toEqual({
      componentId: "fixture-service",
      interventionKind: "manual-repair",
      confirmed: true,
      at: "2026-08-30T00:00:00.000Z",
      operatorId: "operator-1",
    });

    expect(() =>
      verifier.acceptIntervention({
        ...intervention({ nonce: "same-uid-unsigned" }),
        signature: "not-a-signature",
      }),
    ).toThrow(/signature/);
  });

  it("rejects expired and replayed intervention envelopes", () => {
    const verifier = new OperatorEnvelopeVerifier({
      trustedKey: publicKey,
      now: () => NOW,
    });
    expect(() =>
      verifier.acceptIntervention(
        intervention({
          nonce: "expired-intervention",
          expiresAt: "2026-08-29T23:59:59.999Z",
        }),
      ),
    ).toThrow(/expired/);
    const once = intervention({ nonce: "intervention-replay" });
    verifier.acceptIntervention(once);
    expect(() => verifier.acceptIntervention(once)).toThrow(/replay/);
  });

  it("refuses an intervention nonce after verifier restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-intervention-ledger-"));
    const envelope = intervention({ nonce: "nonce-durable-intervention" });
    new OperatorEnvelopeVerifier({
      trustedKey: publicKey,
      now: () => NOW,
      persistence: new FileOperatorEnvelopeStore(dir),
    }).acceptIntervention(envelope);

    expect(() =>
      new OperatorEnvelopeVerifier({
        trustedKey: publicKey,
        now: () => NOW,
        persistence: new FileOperatorEnvelopeStore(dir),
      }).acceptIntervention(envelope),
    ).toThrow(/replay/);
  });
});
