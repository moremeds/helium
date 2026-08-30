import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import { signApprovalEnvelope } from "./sign-approval.mjs";
import { hardwareIdentityHash } from "./signing-host-policy.mjs";

const dir = mkdtempSync(join(tmpdir(), "helium-sign-approval-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const operatorIdentity = "fixture-operator-hardware";
const miniIdentity = "fixture-mini-hardware";
const signingHost = {
  hardwareIdentity: operatorIdentity,
  policy: {
    version: 1,
    allowedOperatorHostHashes: [hardwareIdentityHash(operatorIdentity)],
    forbiddenMiniHostHashes: [hardwareIdentityHash(miniIdentity)],
  },
};

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const unsignedPromotion = {
  version: 1,
  promotionId: "fixture-promotion",
  sop: {
    id: "repair-fixture",
    version: 1,
    digest: `sha256:${"a".repeat(64)}`,
    maxAttempts: 1,
  },
};
const promotion = {
  ...unsignedPromotion,
  inputSha256: createHash("sha256").update(canonicalJson(unsignedPromotion)).digest("hex"),
};
const unsigned = {
  kind: "approval",
  operatorId: "operator-1",
  nonce: "approval-nonce-1",
  issuedAt: "2026-08-30T00:00:00.000Z",
  approval: {
    incidentId: "fixture|integrity|failed|fixture",
    sopId: "repair-fixture",
    sopVersion: 1,
    sopDigest: `sha256:${"a".repeat(64)}`,
    promotionId: "fixture-promotion",
    promotionInputSha256: promotion.inputSha256,
    attempt: 1,
    expiresAt: "2026-08-30T00:10:00.000Z",
  },
};

test("signs the canonical unsigned approval without changing its scope", () => {
  const signed = signApprovalEnvelope(
    unsigned,
    privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(signed).filter(([key]) => key !== "signature")),
    unsigned,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      publicKey,
      Buffer.from(signed.signature, "base64"),
    ),
    true,
  );
});

test("refuses an already signed or non-approval document", () => {
  const key = privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(
    () => signApprovalEnvelope({ ...unsigned, signature: "replace-me" }, key),
    /already has a signature/,
  );
  assert.throws(
    () => signApprovalEnvelope({ ...unsigned, kind: "intervention" }, key),
    /kind must be approval/,
  );
  assert.throws(
    () => signApprovalEnvelope({
      ...unsigned,
      approval: { ...unsigned.approval, attempt: 2 },
    }, key),
    /attempt must be exactly one/,
  );
});

test("CLI writes a new artifact and refuses to overwrite one", async () => {
  const input = join(dir, "approval.json");
  const key = join(dir, "operator.pem");
  const output = join(dir, "signed.json");
  const promotionInput = join(dir, "promotion-input.json");
  writeFileSync(input, JSON.stringify(unsigned));
  writeFileSync(promotionInput, JSON.stringify(promotion));
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });

  const { runSigner } = await import("./sign-approval.mjs");
  await runSigner([
    "--input",
    input,
    "--promotion-input",
    promotionInput,
    "--private-key",
    key,
    "--output",
    output,
  ], { signingHost });
  assert.equal(JSON.parse(readFileSync(output, "utf8")).kind, "approval");
  await assert.rejects(
    runSigner([
      "--input",
      input,
      "--promotion-input",
      promotionInput,
      "--private-key",
      key,
      "--output",
      output,
    ], { signingHost }),
    /refusing to overwrite/,
  );
});

test("CLI refuses a registered mini and an uncommissioned signing policy", async () => {
  const input = join(dir, "approval.json");
  const key = join(dir, "operator.pem");
  const promotionInput = join(dir, "promotion-host-policy.json");
  writeFileSync(input, JSON.stringify(unsigned));
  writeFileSync(promotionInput, JSON.stringify(promotion));
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const { runSigner } = await import("./sign-approval.mjs");
  const args = ["--input", input, "--promotion-input", promotionInput, "--private-key", key, "--output", join(dir, "host-refused.json")];
  await assert.rejects(
    runSigner(args, { signingHost: { ...signingHost, hardwareIdentity: miniIdentity } }),
    /registered mini/,
  );
  await assert.rejects(
    runSigner(args, {
      signingHost: {
        hardwareIdentity: operatorIdentity,
        policy: { version: 1, allowedOperatorHostHashes: [], forbiddenMiniHostHashes: [] },
      },
    }),
    /not commissioned/,
  );
});
