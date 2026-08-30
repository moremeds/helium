#!/usr/bin/env node
/** Render a reversible, non-executing Ops suggest-only configuration. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["preflight", "apply", "restore", "status"]);
const FLAGS = new Set(["--config", "--release", "--authority-manifest", "--trusted-key"]);

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return stat;
}

function readJson(path, label) {
  regularFile(path, label);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function writeCandidate(path, value) {
  writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultIsLoaded() {
  try {
    execFileSync("/bin/launchctl", [
      "print",
      `gui/${process.getuid?.() ?? 0}/com.helium.opsd`,
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function validateInput(input, command) {
  for (const key of ["config", "release"]) {
    if (typeof input[key] !== "string" || !isAbsolute(input[key])) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  if (command === "preflight" || command === "apply") {
    for (const key of ["authorityManifest", "trustedKey"]) {
      if (typeof input[key] !== "string" || !isAbsolute(input[key])) {
        throw new Error(`${key} must be an absolute path`);
      }
    }
  }
}

function suggestConfig(active, input) {
  return {
    ...active,
    mode: "suggest",
    releaseDir: input.release,
    promotionBundleDir: join(
      input.release,
      "ops",
      "promotions",
      "trading-stack-reconcile",
    ),
    componentsDir: "components",
    dependenciesDir: "dependencies",
    checksDir: "checks",
    sopsDir: "sops",
    executorsDir: "executors",
    authorityManifestPath: input.authorityManifest,
    trustedKeyPath: input.trustedKey,
  };
}

function defaultValidateCandidate(path, release) {
  const binary = join(release, "plugins", "ops-agent", "lib", "bin", "opsd.js");
  regularFile(binary, "opsd binary");
  execFileSync(process.execPath, [
    binary,
    "--check-config",
    path,
    "--release",
    release,
  ], { stdio: "inherit" });
}

export function runSuggestConfig(command, input, deps = {}) {
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}`);
  validateInput(input, command);
  const active = readJson(input.config, "active opsd config");
  const backup = `${input.config}.pre-p4-suggest`;
  const backupMeta = `${backup}.sha256.json`;
  const isLoaded = deps.isLoaded ?? defaultIsLoaded;
  const validateCandidate = deps.validateCandidate ?? ((path) =>
    defaultValidateCandidate(path, input.release));

  if (command === "status") {
    let backupPresent = false;
    try { regularFile(backup, "suggest backup"); backupPresent = true; } catch {}
    return { mode: active.mode, releaseDir: active.releaseDir, backupPresent };
  }

  if (command === "restore") {
    if (isLoaded()) throw new Error("com.helium.opsd must be unloaded before restore");
    if (active.mode !== "suggest") throw new Error("restore requires active suggest mode");
    const bytes = readFileSync(backup);
    const meta = readJson(backupMeta, "suggest backup hash");
    if (meta.version !== 1 || meta.sha256 !== sha256(bytes)) {
      throw new Error("suggest backup hash mismatch");
    }
    const restored = JSON.parse(bytes.toString("utf8"));
    if (restored.mode !== "observe") throw new Error("suggest backup is not observe mode");
    validateCandidate(backup);
    const temporary = `${input.config}.restore.${randomBytes(6).toString("hex")}`;
    try {
      writeExclusive(temporary, bytes);
      renameSync(temporary, input.config);
      syncDirectory(dirname(input.config));
      rmSync(backup);
      rmSync(backupMeta);
      syncDirectory(dirname(input.config));
    } finally {
      rmSync(temporary, { force: true });
    }
    return { mode: "observe", config: input.config };
  }

  if (active.mode !== "observe") {
    throw new Error(`${command} requires observe mode, got ${String(active.mode)}`);
  }
  regularFile(join(
    input.release,
    "plugins",
    "ops-agent",
    "lib",
    "bin",
    "opsd.js",
  ), "opsd binary");
  regularFile(input.authorityManifest, "signed authority manifest");
  regularFile(input.trustedKey, "trusted authority key");
  const candidate = suggestConfig(active, input);
  const temporary = `${input.config}.suggest.${randomBytes(6).toString("hex")}`;
  try {
    writeCandidate(temporary, candidate);
    validateCandidate(temporary);
    if (command === "preflight") {
      return { mode: "suggest", config: input.config, changed: false };
    }
    if (isLoaded()) throw new Error("com.helium.opsd must be unloaded before apply");
    const original = readFileSync(input.config);
    writeExclusive(backup, original);
    try {
      writeExclusive(
        backupMeta,
        `${JSON.stringify({ version: 1, sha256: sha256(original) }, null, 2)}\n`,
      );
      renameSync(temporary, input.config);
      syncDirectory(dirname(input.config));
    } catch (error) {
      rmSync(backup, { force: true });
      rmSync(backupMeta, { force: true });
      throw error;
    }
    return { mode: "suggest", config: input.config, backup };
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const values = new Map();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.has(flag) || value === undefined || values.has(flag)) {
      throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    }
    values.set(flag, value);
  }
  for (const flag of ["--config", "--release"]) {
    if (!values.has(flag)) throw new Error(`missing ${flag}`);
  }
  if (command === "preflight" || command === "apply") {
    for (const flag of ["--authority-manifest", "--trusted-key"]) {
      if (!values.has(flag)) throw new Error(`missing ${flag}`);
    }
  }
  return {
    command,
    input: {
      config: values.get("--config"),
      release: values.get("--release"),
      authorityManifest: values.get("--authority-manifest"),
      trustedKey: values.get("--trusted-key"),
    },
  };
}

if (process.argv[1] !== undefined &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const { command, input } = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(runSuggestConfig(command, input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "suggest configuration failed"}\n`);
    process.exitCode = 1;
  }
}
