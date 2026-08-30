#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const RECONCILE_WRAPPER_SHA256 =
  "15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074";

const wrapperRelativePath =
  "scripts/ops/actions/trading-stack-reconcile.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPrivateDirectory(path, expectedOwnerUid, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  if (stat.uid !== expectedOwnerUid) {
    throw new Error(`${label} owner does not match installer owner`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be private mode 0700`);
  }
}

function ensurePrivateDirectory(path, expectedOwnerUid, label) {
  try {
    assertPrivateDirectory(path, expectedOwnerUid, label);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    assertPrivateDirectory(path, expectedOwnerUid, label);
  }
}

function assertExistingTarget(target, expectedOwnerUid, expectedBytes) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("existing wrapper is not a regular file");
  }
  if (stat.uid !== expectedOwnerUid || (stat.mode & 0o777) !== 0o500) {
    throw new Error("existing wrapper owner or mode does not match");
  }
  if (!readFileSync(target).equals(expectedBytes)) {
    throw new Error("existing wrapper does not match certified bytes");
  }
}

export function installTradingStackReconcileWrapper({
  release,
  root,
  expectedOwnerUid = 501,
}) {
  if (!isAbsolute(release) || !isAbsolute(root)) {
    throw new Error("release and ops root must be absolute");
  }
  if (!root.endsWith("/.helium/ops")) {
    throw new Error("ops root must end in /.helium/ops");
  }
  assertPrivateDirectory(root, expectedOwnerUid, "ops root");

  const source = join(release, wrapperRelativePath);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("wrapper source is not a regular file");
  }
  if (sourceStat.uid !== expectedOwnerUid || (sourceStat.mode & 0o022) !== 0) {
    throw new Error("wrapper source owner or mode is not trusted");
  }
  const bytes = readFileSync(source);
  if (sha256(bytes) !== RECONCILE_WRAPPER_SHA256) {
    throw new Error("wrapper source hash does not match certification");
  }

  const actions = join(root, "actions");
  ensurePrivateDirectory(actions, expectedOwnerUid, "actions directory");
  const digestDirectory = join(
    actions,
    `sha256-${RECONCILE_WRAPPER_SHA256}`,
  );
  ensurePrivateDirectory(
    digestDirectory,
    expectedOwnerUid,
    "wrapper digest directory",
  );
  const target = join(digestDirectory, "trading-stack-reconcile.mjs");

  try {
    assertExistingTarget(target, expectedOwnerUid, bytes);
    return target;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = join(
    digestDirectory,
    `.trading-stack-reconcile.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o500,
    );
    writeFileSync(descriptor, bytes, { flush: true });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o500);
    linkSync(temporary, target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  assertExistingTarget(target, expectedOwnerUid, bytes);
  return target;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--release" && flag !== "--root") {
      throw new Error(`unknown action installer flag: ${flag ?? "<missing>"}`);
    }
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`duplicate action installer flag: ${flag}`);
    values.set(flag, value);
  }
  if (!values.has("--release") || !values.has("--root")) {
    throw new Error("usage: install-action-wrapper.mjs --release ABS --root ABS");
  }
  return {
    release: values.get("--release"),
    root: values.get("--root"),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const target = installTradingStackReconcileWrapper(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${target}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "action wrapper install refused"}\n`,
    );
    process.exitCode = 1;
  }
}
