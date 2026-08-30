#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CheckDefinitionSchema,
  CheckRegistry,
  ComponentSpecSchema,
  SopDefinitionSchema,
  canonicalJson,
  certifySop,
} from "../../packages/core/lib/index.js";
import { RegisteredScriptSchema } from "../../plugins/ops-agent/lib/index.js";

const requireFromOpsPlugin = createRequire(
  new URL("../../plugins/ops-agent/package.json", import.meta.url),
);
const { parse } = requireFromOpsPlugin("yaml");
const PROMOTION_ID = "trading-stack-reconcile";
const FLAGS = new Set([
  "--release-dir",
  "--release-commit",
  "--promotion-dir",
  "--registered-probes",
  "--wrapper-source",
  "--issued-at",
  "--expires-at",
  "--rollback-ref",
  "--output",
]);

export function exportPromotionInput(raw, options = {}) {
  const input = validateInput(raw);
  const resolveReleaseCommit = options.resolveReleaseCommit ?? ((dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const actualCommit = resolveReleaseCommit(input.releaseDir);
  if (actualCommit !== input.releaseCommit) {
    throw new Error(`release commit mismatch: expected ${input.releaseCommit}, got ${actualCommit}`);
  }

  const component = ComponentSpecSchema.parse(
    loadOne(input.promotionDir, "components"),
  );
  if (component.id !== "colima" || component.mutationOwner.owner !== "opsd") {
    throw new Error("promotion component owner must be opsd for colima");
  }
  const registered = JSON.parse(readFileSync(input.registeredProbesPath, "utf8"));
  if (registered.version !== 1 || !Array.isArray(registered.probeIds)) {
    throw new Error("registered probe inventory is invalid");
  }
  const checks = loadAll(input.promotionDir, "checks")
    .map((value) => CheckDefinitionSchema.parse(value));
  const checkRegistry = CheckRegistry.load(checks, registered.probeIds);
  const executor = RegisteredScriptSchema.parse(loadOne(input.promotionDir, "executors"));
  const wrapperSha = sha256(input.wrapperSourcePath);
  if (executor.identity.kind !== "sha256" || executor.identity.value !== wrapperSha) {
    throw new Error("executor identity does not match wrapper source hash");
  }
  const sop = SopDefinitionSchema.parse(loadOne(input.promotionDir, "sops"));
  const { digest: _digest, ...unsignedSop } = sop;
  const computedSopDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(unsignedSop)).digest("hex")}`;
  if (sop.digest !== computedSopDigest) throw new Error("promotion SOP digest mismatch");
  if (sop.id !== "trading-stack-container-reconcile" || sop.authority !== "approve" ||
      sop.maxAttempts !== 1) {
    throw new Error("promotion SOP is not the one-attempt approve contract");
  }
  const certification = certifySop(sop, checkRegistry, component);
  if (!certification.certified) {
    throw new Error(`promotion SOP is not certified: ${certification.reasons.join(", ")}`);
  }
  if (executor.executorId !== sop.action.executorId ||
      executor.path !== sop.action.executable.path ||
      executor.identity.kind !== sop.action.executable.identity?.kind ||
      executor.identity.value !== sop.action.executable.identity?.value ||
      executor.argvSchema.id !== sop.action.argvSchemaId) {
    throw new Error("promotion SOP and executor identity differ");
  }

  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error("promotion input expiry must be after issue time");
  }
  const bundleFiles = hashPromotionFiles(input.promotionDir);
  const unsigned = {
    version: 1,
    promotionId: PROMOTION_ID,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    release: { dir: input.releaseDir, commit: input.releaseCommit },
    bundleFiles,
    registeredProbes: {
      sha256: sha256(input.registeredProbesPath),
      probeIds: [...registered.probeIds].sort(),
    },
    componentOwner: {
      componentId: component.id,
      owner: component.mutationOwner.owner,
      competingLabels: [...component.mutationOwner.competingLabels],
      changeRef: component.mutationOwner.changeRef,
    },
    executor: {
      executorId: executor.executorId,
      path: executor.path,
      identity: executor.identity,
      expectedOwnerUid: executor.expectedOwnerUid,
      argvSchema: executor.argvSchema,
    },
    sop: {
      id: sop.id,
      version: sop.version,
      digest: sop.digest,
      authority: sop.authority,
      maxAttempts: sop.maxAttempts,
    },
    rollbackRef: input.rollbackRef,
  };
  const payload = {
    ...unsigned,
    inputSha256: createHash("sha256").update(canonicalJson(unsigned)).digest("hex"),
  };
  writeExclusive(input.output, payload);
  return payload;
}

function validateInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotion export input must be an object");
  }
  const keys = [
    "releaseDir", "releaseCommit", "promotionDir", "registeredProbesPath",
    "wrapperSourcePath", "issuedAt", "expiresAt", "rollbackRef", "output",
  ];
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key] === "") {
      throw new Error(`promotion export input requires ${key}`);
    }
  }
  return value;
}

function loadOne(root, section) {
  const values = loadAll(root, section);
  if (values.length !== 1) throw new Error(`promotion ${section} must contain exactly one file`);
  return values[0];
}

function loadAll(root, section) {
  const dir = resolve(root, section);
  return readdirSync(dir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => {
      const path = resolve(dir, name);
      const text = readFileSync(path, "utf8");
      return extname(name) === ".json" ? JSON.parse(text) : parse(text, { strict: true, uniqueKeys: true });
    });
}

function hashPromotionFiles(root) {
  const rows = [];
  for (const section of ["components", "checks", "executors", "sops"]) {
    const dir = resolve(root, section);
    for (const name of readdirSync(dir).filter((candidate) =>
      [".yaml", ".yml", ".json"].includes(extname(candidate))).sort()) {
      const path = resolve(dir, name);
      if (!statSync(path).isFile()) throw new Error(`promotion entry is not a file: ${path}`);
      rows.push({ path: relative(root, path), sha256: sha256(path) });
    }
  }
  return rows;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExclusive(path, value) {
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to overwrite promotion input: ${path}`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const dirFd = openSync(resolve(path, ".."), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.has(flag)) throw new Error(`unknown promotion export flag: ${flag ?? "<missing>"}`);
    if (value === undefined || values.has(flag)) throw new Error(`invalid promotion export flag: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of FLAGS) if (!values.has(flag)) throw new Error(`promotion export requires ${flag}`);
  return {
    releaseDir: values.get("--release-dir"),
    releaseCommit: values.get("--release-commit"),
    promotionDir: values.get("--promotion-dir"),
    registeredProbesPath: values.get("--registered-probes"),
    wrapperSourcePath: values.get("--wrapper-source"),
    issuedAt: values.get("--issued-at"),
    expiresAt: values.get("--expires-at"),
    rollbackRef: values.get("--rollback-ref"),
    output: values.get("--output"),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    exportPromotionInput(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "promotion export failed"}\n`);
    process.exitCode = 1;
  }
}
