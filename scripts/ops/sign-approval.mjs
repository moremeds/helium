#!/usr/bin/env node
/** Sign one scoped approval on an operator-controlled workstation. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import { assertTrustedSigningHost } from "./signing-host-policy.mjs";

const flags = new Set(["--input", "--promotion-input", "--private-key", "--output"]);

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flags.has(flag)) throw new Error(`unknown signer flag: ${flag ?? "<missing>"}`);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`duplicate signer flag: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of flags) {
    if (!values.has(flag)) throw new Error(`sign-approval requires ${flag}`);
  }
  return {
    input: values.get("--input"),
    promotionInput: values.get("--promotion-input"),
    privateKey: values.get("--private-key"),
    output: values.get("--output"),
  };
}

function validateUnsignedApproval(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("approval input must be an object");
  }
  if (Object.hasOwn(value, "signature")) {
    throw new Error("approval input already has a signature");
  }
  if (value.kind !== "approval") throw new Error("approval kind must be approval");
  const required = ["operatorId", "nonce", "issuedAt", "approval"];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`approval input is missing ${key}`);
  }
  const allowed = new Set(["kind", ...required]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`approval input has unknown key ${key}`);
  }
  const approvalRequired = [
    "incidentId", "sopId", "sopVersion", "sopDigest", "promotionId",
    "promotionInputSha256", "attempt", "expiresAt",
  ];
  if (value.approval === null || typeof value.approval !== "object" ||
      Array.isArray(value.approval)) {
    throw new Error("approval payload must be an object");
  }
  for (const key of approvalRequired) {
    if (!Object.hasOwn(value.approval, key)) throw new Error(`approval payload is missing ${key}`);
  }
  if (value.approval.attempt !== 1) throw new Error("approval attempt must be exactly one");
  if (!/^[0-9a-f]{64}$/.test(value.approval.promotionInputSha256)) {
    throw new Error("approval promotion input hash is invalid");
  }
  return value;
}

export function signApprovalEnvelope(raw, privateKeyPem) {
  const unsigned = validateUnsignedApproval(structuredClone(raw));
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("approval private key must be Ed25519");
  }
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), key).toString("base64"),
  };
}

export async function runSigner(argv, testOptions = undefined) {
  assertTrustedSigningHost(testOptions?.signingHost);
  const parsed = parseArgs(argv);
  const keyStat = statSync(parsed.privateKey);
  if (!keyStat.isFile()) throw new Error("approval private key is not a file");
  if ((keyStat.mode & 0o077) !== 0) {
    throw new Error("approval private key must not be group- or world-accessible");
  }
  const unsigned = JSON.parse(readFileSync(parsed.input, "utf8"));
  const promotion = JSON.parse(readFileSync(parsed.promotionInput, "utf8"));
  const { inputSha256, ...unsignedPromotion } = promotion;
  const computedPromotionHash = createHash("sha256")
    .update(canonicalJson(unsignedPromotion)).digest("hex");
  if (inputSha256 !== computedPromotionHash) {
    throw new Error("promotion input hash does not match its canonical content");
  }
  if (unsigned.approval?.promotionId !== promotion.promotionId ||
      unsigned.approval?.promotionInputSha256 !== promotion.inputSha256 ||
      unsigned.approval?.sopId !== promotion.sop?.id ||
      unsigned.approval?.sopVersion !== promotion.sop?.version ||
      unsigned.approval?.sopDigest !== promotion.sop?.digest ||
      unsigned.approval?.attempt !== promotion.sop?.maxAttempts ||
      promotion.sop?.maxAttempts !== 1) {
    throw new Error("approval does not match the exact one-attempt promotion input");
  }
  const signed = signApprovalEnvelope(unsigned, readFileSync(parsed.privateKey));

  let fd;
  try {
    fd = openSync(parsed.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(signed, null, 2)}\n`, {
      encoding: "utf8",
      flush: true,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`refusing to overwrite approval artifact: ${parsed.output}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return signed;
}

async function main() {
  await runSigner(process.argv.slice(2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "signing failed"}\n`);
    process.exitCode = 1;
  });
}
