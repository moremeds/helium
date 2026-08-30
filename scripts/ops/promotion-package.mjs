#!/usr/bin/env node
/** Export a fixed-host promotion package, then sign it on the operator host. */
import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROLLED_MUTATION_ARTIFACT_KEYS,
  createControlledMutationLayout,
} from "./controlled-mutation.mjs";
import { assertTrustedSigningHost } from "./signing-host-policy.mjs";

const PROMOTION_ID = "trading-stack-reconcile";

export function exportPromotionPackage(raw) {
  const promotion = loadPromotionInput(raw.promotionInputPath);
  const layout = resolvedLayout(raw.layout ?? createControlledMutationLayout(), promotion);
  if (raw.promotionInputPath !== layout.promotionInput) {
    throw new Error("promotion input is not at the canonical staged path");
  }
  const artifacts = Object.fromEntries(CONTROLLED_MUTATION_ARTIFACT_KEYS.map((key) => {
    const path = layout[key];
    const stat = safeRegularStat(path, key);
    return [key, {
      path,
      sha256: sha256(path),
      uid: stat.uid,
      mode: stat.mode & 0o777,
    }];
  }));
  const payload = {
    version: 1,
    promotionId: PROMOTION_ID,
    issuedAt: promotion.issuedAt,
    expiresAt: promotion.expiresAt,
    promotionInputSha256: promotion.inputSha256,
    release: promotion.release,
    rollbackRef: promotion.rollbackRef,
    artifacts,
  };
  writeExclusive(raw.output, payload, "unsigned promotion package");
  return payload;
}

export function signPromotionPackage(raw, testOptions = undefined) {
  assertTrustedSigningHost(testOptions?.signingHost);
  const promotion = loadPromotionInput(raw.promotionInputPath);
  const payload = JSON.parse(readFileSync(raw.unsignedPackagePath, "utf8"));
  validatePackageBinding(payload, promotion);
  const keyStat = safeRegularStat(raw.privateKeyPath, "promotion private key");
  if ((keyStat.mode & 0o077) !== 0) {
    throw new Error("promotion private key must not be group- or world-accessible");
  }
  const privateKey = createPrivateKey(readFileSync(raw.privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("promotion private key must be Ed25519");
  }
  const envelope = {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64"),
  };
  writeExclusive(raw.output, envelope, "signed promotion package");
  return envelope;
}

export function validatePackageBinding(payload, promotion) {
  const exactKeys = [
    "version", "promotionId", "issuedAt", "expiresAt",
    "promotionInputSha256", "release", "rollbackRef", "artifacts",
  ].sort();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
      JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error("promotion package payload shape is not exact");
  }
  if (payload.version !== 1 || payload.promotionId !== PROMOTION_ID ||
      payload.issuedAt !== promotion.issuedAt || payload.expiresAt !== promotion.expiresAt ||
      payload.promotionInputSha256 !== promotion.inputSha256 ||
      canonicalJson(payload.release) !== canonicalJson(promotion.release) ||
      payload.rollbackRef !== promotion.rollbackRef) {
    throw new Error("promotion package does not match the canonical promotion input");
  }
  const artifactKeys = payload.artifacts === null || typeof payload.artifacts !== "object"
    ? []
    : Object.keys(payload.artifacts).sort();
  if (JSON.stringify(artifactKeys) !==
      JSON.stringify([...CONTROLLED_MUTATION_ARTIFACT_KEYS].sort())) {
    throw new Error("promotion artifact set is not exact");
  }
  for (const key of CONTROLLED_MUTATION_ARTIFACT_KEYS) {
    const artifact = payload.artifacts[key];
    if (artifact === null || typeof artifact !== "object" ||
        typeof artifact.path !== "string" || artifact.path === "" ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
        !Number.isInteger(artifact.uid) || !Number.isInteger(artifact.mode)) {
      throw new Error(`invalid promotion artifact identity: ${key}`);
    }
  }
}

function loadPromotionInput(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.version !== 1 || value.promotionId !== PROMOTION_ID ||
      typeof value.inputSha256 !== "string") {
    throw new Error("canonical promotion input is invalid");
  }
  const { inputSha256, ...unsigned } = value;
  const actual = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  if (inputSha256 !== actual) throw new Error("promotion input hash mismatch");
  return value;
}

function resolvedLayout(layout, promotion) {
  return {
    ...layout,
    opsdBinary: join(promotion.release.dir, "plugins", "ops-agent", "lib", "bin", "opsd.js"),
  };
}

function safeRegularStat(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExclusive(path, value, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to overwrite ${label}: ${path}`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const dirFd = openSync(dirname(resolve(path)), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsePairs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined ||
        values.has(flag)) {
      throw new Error("invalid promotion package arguments");
    }
    values.set(flag, value);
  }
  return values;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    const values = parsePairs(argv);
    if (command === "export") {
      const allowed = ["--promotion-input", "--output"];
      if ([...values.keys()].some((key) => !allowed.includes(key)) ||
          allowed.some((key) => !values.has(key))) throw new Error("usage: promotion-package.mjs export --promotion-input ABS --output ABS");
      exportPromotionPackage({
        promotionInputPath: values.get("--promotion-input"),
        output: values.get("--output"),
      });
    } else if (command === "sign") {
      const allowed = ["--input", "--promotion-input", "--private-key", "--output"];
      if ([...values.keys()].some((key) => !allowed.includes(key)) ||
          allowed.some((key) => !values.has(key))) throw new Error("usage: promotion-package.mjs sign --input ABS --promotion-input ABS --private-key ABS --output ABS");
      signPromotionPackage({
        unsignedPackagePath: values.get("--input"),
        promotionInputPath: values.get("--promotion-input"),
        privateKeyPath: values.get("--private-key"),
        output: values.get("--output"),
      });
    } else {
      throw new Error("usage: promotion-package.mjs export|sign ...");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "promotion package failed"}\n`);
    process.exitCode = 1;
  }
}
