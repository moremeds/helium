#!/usr/bin/env node
/** Sign one exact Ops suggestion decision on the commissioned workstation. */
import { createPrivateKey, sign } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import { assertTrustedSigningHost } from "./signing-host-policy.mjs";

const FLAGS = new Set(["--input", "--private-key", "--output"]);
const TOP_KEYS = ["kind", "operatorId", "nonce", "issuedAt", "expiresAt", "decision"];
const DECISION_KEYS = [
  "actionId",
  "incidentId",
  "componentId",
  "sopId",
  "sopVersion",
  "sopDigest",
  "decision",
  "reason",
  "at",
];

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`${label} has unknown key ${key}`);
  }
}

function text(value, label, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`${label} must be 1-${max} characters`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") ||
      new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO UTC timestamp`);
  }
}

function validateUnsigned(raw) {
  if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "signature")) {
    throw new Error("suggestion decision already has a signature");
  }
  exactKeys(raw, TOP_KEYS, "suggestion decision envelope");
  if (raw.kind !== "suggestion-decision") {
    throw new Error("suggestion decision kind must be suggestion-decision");
  }
  text(raw.operatorId, "operatorId", 200);
  text(raw.nonce, "nonce", 200);
  timestamp(raw.issuedAt, "issuedAt");
  timestamp(raw.expiresAt, "expiresAt");
  if (Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt)) {
    throw new Error("suggestion decision expiry must follow issue time");
  }
  exactKeys(raw.decision, DECISION_KEYS, "suggestion decision payload");
  for (const key of ["actionId", "incidentId", "componentId", "sopId"]) {
    text(raw.decision[key], key, 200);
  }
  if (!Number.isInteger(raw.decision.sopVersion) || raw.decision.sopVersion < 1) {
    throw new Error("sopVersion must be a positive integer");
  }
  if (typeof raw.decision.sopDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(raw.decision.sopDigest)) {
    throw new Error("sopDigest must be an exact SHA-256 digest");
  }
  if (!["accepted", "rejected", "alternate"].includes(raw.decision.decision)) {
    throw new Error("suggestion decision must be accepted, rejected, or alternate");
  }
  text(raw.decision.reason, "reason", 1000);
  timestamp(raw.decision.at, "decision at");
  return structuredClone(raw);
}

export function signSuggestionDecisionEnvelope(raw, privateKeyPem) {
  const unsigned = validateUnsigned(raw);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("suggestion decision private key must be Ed25519");
  }
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), key).toString("base64"),
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.has(flag) || value === undefined || values.has(flag)) {
      throw new Error(`invalid signer argument: ${flag ?? "<missing>"}`);
    }
    values.set(flag, value);
  }
  for (const flag of FLAGS) if (!values.has(flag)) throw new Error(`missing ${flag}`);
  return {
    input: values.get("--input"),
    privateKey: values.get("--private-key"),
    output: values.get("--output"),
  };
}

export async function runSuggestionDecisionSigner(argv, testOptions = undefined) {
  assertTrustedSigningHost(testOptions?.signingHost);
  const parsed = parseArgs(argv);
  const keyStat = statSync(parsed.privateKey);
  if (!keyStat.isFile()) throw new Error("suggestion decision private key is not a file");
  if ((keyStat.mode & 0o077) !== 0) {
    throw new Error("suggestion decision private key must not be group- or world-accessible");
  }
  const signed = signSuggestionDecisionEnvelope(
    JSON.parse(readFileSync(parsed.input, "utf8")),
    readFileSync(parsed.privateKey),
  );
  let fd;
  try {
    fd = openSync(parsed.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(signed, null, 2)}\n`, {
      encoding: "utf8",
      flush: true,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`refusing to overwrite suggestion decision: ${parsed.output}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return signed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSuggestionDecisionSigner(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "signing failed"}\n`);
    process.exitCode = 1;
  });
}
