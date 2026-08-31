#!/usr/bin/env node
/** Export and verify an offline, content-addressed Livewire promotion proof. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/core/lib/index.js";

const HEX = /^[0-9a-f]{64}$/;

export function exportLivewirePromotionEvidence(raw) {
  const promotionInputPath = absolute(raw.promotionInputPath, "promotion input");
  const outputDir = absolute(raw.outputDir, "evidence output");
  const input = loadPromotionInput(promotionInputPath);
  const expected = expectedEntries(input, promotionInputPath);
  const prepared = expected.map((entry) => {
    const source = safeSource(entry, expected);
    const bytes = readFileSync(source);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`promotion evidence input hash mismatch: ${entry.productionPath}`);
    }
    return { entry, source, bytes, actual, stat: lstatSync(source) };
  });
  try {
    mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`refusing to overwrite evidence directory: ${outputDir}`);
    }
    throw error;
  }
  const blobsDir = join(outputDir, "blobs");
  mkdirSync(blobsDir, { mode: 0o700 });
  const entries = prepared.map(({ entry, bytes, actual, stat }) => {
    const blob = join(blobsDir, actual);
    let fd;
    try {
      fd = openSync(blob, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
      writeFileSync(fd, bytes, { flush: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    chmodSync(blob, 0o400);
    return {
      kinds: entry.kinds,
      productionPath: entry.productionPath,
      sha256: actual,
      size: bytes.length,
      mode: stat.mode & 0o777,
      ...(entry.releaseRelativePath === undefined
        ? {}
        : { releaseRelativePath: entry.releaseRelativePath }),
    };
  });
  const manifest = {
    version: 1,
    promotionId: input.promotionId,
    promotionInputSha256: input.inputSha256,
    releaseCommit: input.release.commit,
    entries,
  };
  writeExclusive(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o400);
  fsyncDir(blobsDir);
  fsyncDir(outputDir);
  return manifest;
}

export function verifyLivewirePromotionEvidence(raw) {
  const promotionInputPath = absolute(raw.promotionInputPath, "promotion input");
  const evidenceDir = absolute(raw.evidenceDir, "evidence directory");
  const releaseCheckout = absolute(raw.releaseCheckout, "release checkout");
  const input = loadPromotionInput(promotionInputPath);
  const expected = expectedEntries(input, promotionInputPath);
  const manifestPath = join(evidenceDir, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("promotion evidence manifest is unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || manifest.promotionId !== input.promotionId ||
      manifest.promotionInputSha256 !== input.inputSha256 ||
      manifest.releaseCommit !== input.release.commit || !Array.isArray(manifest.entries)) {
    throw new Error("promotion evidence manifest binding mismatch");
  }
  const actualCommit = (raw.resolveReleaseCommit ?? ((path) =>
    execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()))(releaseCheckout);
  if (actualCommit !== input.release.commit) throw new Error("offline release commit mismatch");
  (raw.assertReleaseClean ?? assertCleanRelease)(releaseCheckout);

  const expectedManifestEntries = expected.map((entry) => {
    const blob = join(evidenceDir, "blobs", entry.sha256);
    const blobStat = lstatSync(blob);
    if (!blobStat.isFile() || blobStat.isSymbolicLink()) {
      throw new Error(`unsafe evidence blob: ${entry.sha256}`);
    }
    const bytes = readFileSync(blob);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) throw new Error(`evidence blob hash mismatch: ${entry.sha256}`);
    if (entry.releaseRelativePath !== undefined) {
      const localPath = join(releaseCheckout, entry.releaseRelativePath);
      const localStat = lstatSync(localPath);
      if (!localStat.isFile() || localStat.isSymbolicLink() || sha256(localPath) !== entry.sha256) {
        throw new Error(`offline release byte mismatch: ${entry.releaseRelativePath}`);
      }
    }
    const recorded = manifest.entries.find((row) => row.productionPath === entry.productionPath);
    if (recorded === undefined || canonicalJson(recorded.kinds) !== canonicalJson(entry.kinds) ||
        recorded.sha256 !== entry.sha256 ||
        recorded.size !== bytes.length || recorded.releaseRelativePath !== entry.releaseRelativePath) {
      throw new Error(`promotion evidence entry mismatch: ${entry.productionPath}`);
    }
    return recorded;
  });
  if (manifest.entries.length !== expectedManifestEntries.length) {
    throw new Error("promotion evidence entry set is not exact");
  }
  const expectedBlobs = new Set(expected.map((entry) => entry.sha256));
  for (const name of readdirSync(join(evidenceDir, "blobs"))) {
    if (!expectedBlobs.has(name)) throw new Error(`unexpected evidence blob: ${name}`);
  }
  return manifest;
}

function expectedEntries(input, promotionInputPath) {
  const promotionRoot = dirname(input.registeredProbes.path);
  const rows = [];
  const seen = new Map();
  const add = (kind, productionPath, declaredSha, releaseRelativePath = undefined) => {
    if (!isAbsolute(productionPath)) throw new Error(`evidence production path is not absolute: ${productionPath}`);
    if (!HEX.test(declaredSha ?? "")) throw new Error(`evidence input hash is invalid: ${productionPath}`);
    const normalized = normalize(productionPath);
    const prior = seen.get(normalized);
    if (prior !== undefined) {
      if (prior.sha256 !== declaredSha || prior.releaseRelativePath !== releaseRelativePath) {
        throw new Error(`conflicting evidence production path: ${normalized}`);
      }
      prior.kinds = [...new Set([...prior.kinds, kind])].sort();
      return;
    }
    const row = { kinds: [kind], productionPath: normalized, sha256: declaredSha, releaseRelativePath };
    seen.set(normalized, row);
    rows.push(row);
  };
  for (const row of input.runtimeFiles) {
    const relativePath = isAbsolute(row.path) ? undefined : safeRelative(row.path, "Node runtime");
    add("node-runtime", relativePath === undefined ? row.path : join(input.release.dir, relativePath), row.sha256, relativePath);
  }
  add("node-runtime-manifest", input.runtimeManifest.path, input.runtimeManifest.sha256);
  for (const row of input.pythonRuntimeFiles) add("python-runtime", row.path, row.sha256);
  add("python-runtime-manifest", input.pythonRuntimeManifest.path, input.pythonRuntimeManifest.sha256);
  for (const row of input.bundleFiles) {
    const relativePath = safeRelative(row.path, "promotion bundle");
    add("promotion-bundle", join(promotionRoot, relativePath), row.sha256);
  }
  add("registered-probes", input.registeredProbes.path, input.registeredProbes.sha256);
  add("livewire-source-manifest", input.livewireSource.manifest.path, input.livewireSource.manifest.sha256);
  for (const row of input.livewireSource.files) {
    const relativePath = safeRelative(row.path, "Livewire source");
    add("livewire-source", join(input.livewireSource.root, relativePath), row.sha256);
  }
  return rows.sort((left, right) => left.productionPath.localeCompare(right.productionPath));
}

function safeSource(entry, expected) {
  const stat = lstatSync(entry.productionPath);
  if (stat.isFile() && !stat.isSymbolicLink()) return entry.productionPath;
  if (stat.isSymbolicLink() && entry.kinds.includes("python-runtime")) {
    const target = realpathSync(entry.productionPath);
    const targetEntry = expected.find((candidate) =>
      candidate.kinds.includes("python-runtime") && candidate.productionPath === target &&
      candidate.sha256 === entry.sha256);
    if (targetEntry !== undefined && lstatSync(target).isFile()) return target;
  }
  throw new Error(`promotion evidence input is a symlink or non-file: ${entry.productionPath}`);
}

function loadPromotionInput(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.version !== 1 || value.promotionId !== "livewire-shepherd-targeted-repair" ||
      typeof value.inputSha256 !== "string" || value.release?.dir === undefined ||
      !Array.isArray(value.runtimeFiles) || !Array.isArray(value.pythonRuntimeFiles) ||
      !Array.isArray(value.bundleFiles) || typeof value.registeredProbes?.path !== "string" ||
      typeof value.livewireSource?.root !== "string" ||
      !Array.isArray(value.livewireSource?.files)) {
    throw new Error("Livewire promotion input lacks offline evidence bindings");
  }
  const { inputSha256, ...unsigned } = value;
  const actual = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  if (!HEX.test(inputSha256) || inputSha256 !== actual) throw new Error("promotion input hash mismatch");
  return value;
}

function safeRelative(path, label) {
  if (typeof path !== "string" || path === "" || isAbsolute(path)) {
    throw new Error(`${label} path is not relative`);
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} path escapes its root`);
  }
  return normalized;
}

function absolute(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function assertCleanRelease(path) {
  const dirty = execFileSync("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (dirty !== "") throw new Error("offline release checkout must be clean");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExclusive(path, bytes, mode) {
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(fd, bytes, { flush: true });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  chmodSync(path, mode);
}

function fsyncDir(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--promotion-input", "--output"].includes(flag) || value === undefined || values.has(flag)) {
      throw new Error("usage: livewire-promotion-evidence.mjs export --promotion-input ABS --output ABS");
    }
    values.set(flag, value);
  }
  if (!values.has("--promotion-input") || !values.has("--output")) {
    throw new Error("usage: livewire-promotion-evidence.mjs export --promotion-input ABS --output ABS");
  }
  return { promotionInputPath: values.get("--promotion-input"), outputDir: values.get("--output") };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (command !== "export") throw new Error("usage: livewire-promotion-evidence.mjs export --promotion-input ABS --output ABS");
    exportLivewirePromotionEvidence(parseArgs(argv));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Livewire evidence export failed"}\n`);
    process.exitCode = 1;
  }
}
