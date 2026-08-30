import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import {
  runSuggestionDecisionSigner,
  signSuggestionDecisionEnvelope,
} from "./sign-suggestion-decision.mjs";
import { hardwareIdentityHash } from "./signing-host-policy.mjs";

const root = mkdtempSync(join(tmpdir(), "helium-sign-suggestion-"));
after(() => rmSync(root, { recursive: true, force: true }));
const operatorIdentity = "fixture-operator-hardware";
const signingHost = {
  hardwareIdentity: operatorIdentity,
  policy: {
    version: 1,
    allowedOperatorHostHashes: [hardwareIdentityHash(operatorIdentity)],
    forbiddenMiniHostHashes: [hardwareIdentityHash("fixture-mini-hardware")],
  },
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const unsigned = {
  kind: "suggestion-decision",
  operatorId: "operator-1",
  nonce: "suggestion-decision-nonce-1",
  issuedAt: "2026-08-30T00:00:00.000Z",
  expiresAt: "2026-08-30T00:10:00.000Z",
  decision: {
    actionId: "act-1",
    incidentId: "inc-1",
    componentId: "colima",
    sopId: "trading-stack-container-reconcile",
    sopVersion: 1,
    sopDigest: `sha256:${"a".repeat(64)}`,
    decision: "rejected",
    reason: "The existing watchdog remains the preferred owner.",
    at: "2026-08-30T00:01:00.000Z",
  },
};

test("signs one exact suggestion decision", () => {
  const signed = signSuggestionDecisionEnvelope(
    unsigned,
    privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(signed).filter(([key]) => key !== "signature")),
    unsigned,
  );
  assert.equal(verify(
    null,
    Buffer.from(canonicalJson(unsigned)),
    publicKey,
    Buffer.from(signed.signature, "base64"),
  ), true);
});

test("refuses unknown fields, invalid decisions, and an existing signature", () => {
  const key = privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(() => signSuggestionDecisionEnvelope({ ...unsigned, extra: true }, key), /unknown key/);
  assert.throws(() => signSuggestionDecisionEnvelope({
    ...unsigned,
    decision: { ...unsigned.decision, decision: "execute" },
  }, key), /accepted, rejected, or alternate/);
  assert.throws(() => signSuggestionDecisionEnvelope({ ...unsigned, signature: "replace" }, key), /already has/);
});

test("CLI writes owner-only output and refuses overwrite", async () => {
  const input = join(root, "decision.json");
  const key = join(root, "operator.pem");
  const output = join(root, "signed.json");
  writeFileSync(input, JSON.stringify(unsigned));
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const args = ["--input", input, "--private-key", key, "--output", output];
  await runSuggestionDecisionSigner(args, { signingHost });
  assert.equal(JSON.parse(readFileSync(output, "utf8")).kind, "suggestion-decision");
  await assert.rejects(runSuggestionDecisionSigner(args, { signingHost }), /refusing to overwrite/);
});
