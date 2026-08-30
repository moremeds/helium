#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PROMOTION_ID = "trading-stack-reconcile";
const OPSD_LABEL = "com.helium.opsd";
const LEGACY_RUNTIME_LABEL = "com.moremeds.colima-runtime-watchdog";
const LEGACY_AFTER_DATALAKE_LABEL = "com.moremeds.colima-after-datalake";
const LEGACY_HASHES = {
  [LEGACY_RUNTIME_LABEL]: "ee3116091b5a1713597e6c76ca6e4276a16356cf47dad1443ecf30ce25268907",
  [LEGACY_AFTER_DATALAKE_LABEL]: "53e7a6a37c8f6c1ecb64bc58f683b2afb93e87bd16e548baefe8c97dc4d80b90",
};
// Fingerprint of the Ed25519 public key commissioned on the registered
// operator workstation. The private key remains off-mini and outside Git; a
// package cannot establish trust by signing itself with a bundled key.
const TRUSTED_PROMOTION_PUBLIC_KEY_SHA256 =
  "acb7e8c3bfa7c485b98ce216e35be7ee0a333b66803ed203997b1fb07c84ec43";
export const CONTROLLED_MUTATION_ARTIFACT_KEYS = [
  "activeConfig",
  "candidateConfig",
  "promotionInput",
  "authorityManifest",
  "publicKey",
  "wrapper",
  "delegate",
  "opsdBinary",
  "opsdPlist",
  "legacyRuntimePlist",
  "legacyAfterDataLakePlist",
];

export function createControlledMutationLayout(home = "/Users/moremeds", uid = 501) {
  const opsRoot = join(home, ".helium", "ops");
  const launchdRoot = join(home, "Library", "LaunchAgents");
  const promotionRoot = join(opsRoot, "promotions", PROMOTION_ID);
  const backupRoot = join(opsRoot, "state", "handoff", `${PROMOTION_ID}-backup`);
  return {
    home,
    uid,
    opsRoot,
    launchdRoot,
    promotionRoot,
    activeConfig: join(opsRoot, "config", "opsd.json"),
    candidateConfig: join(promotionRoot, "opsd.approve.json"),
    promotionInput: join(promotionRoot, "promotion-input.json"),
    authorityManifest: join(promotionRoot, "authority-manifest.json"),
    publicKey: join(promotionRoot, "authority-manifest.pub.pem"),
    promotionPackage: join(promotionRoot, "promotion-package.json"),
    wrapper: join(
      opsRoot,
      "actions",
      "sha256-15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074",
      "trading-stack-reconcile.mjs",
    ),
    delegate: join(home, "trading-stack", "scripts", "reconcile.sh"),
    opsdBinary: join(promotionRoot, "opsd.js"),
    opsdPlist: join(launchdRoot, `${OPSD_LABEL}.plist`),
    legacyRuntimePlist: join(launchdRoot, `${LEGACY_RUNTIME_LABEL}.plist`),
    legacyAfterDataLakePlist: join(launchdRoot, `${LEGACY_AFTER_DATALAKE_LABEL}.plist`),
    eventsPath: join(opsRoot, "state", "events.jsonl"),
    journalPath: join(opsRoot, "state", "handoff", `${PROMOTION_ID}.jsonl`),
    backupRoot,
    backupManifest: join(backupRoot, "manifest.json"),
    backupActiveConfig: join(backupRoot, "activeConfig.bin"),
    expectedLegacyHashes: home === "/Users/moremeds" ? LEGACY_HASHES : undefined,
    expectedPromotionKeySha256:
      home === "/Users/moremeds" ? TRUSTED_PROMOTION_PUBLIC_KEY_SHA256 : undefined,
  };
}

export async function runControlledMutation(command, options = {}) {
  if (!["preflight", "handoff", "rollback"].includes(command)) {
    throw new Error(`unknown subcommand: ${command}`);
  }
  const layout = options.layout ?? createControlledMutationLayout();
  const runner = options.runner ?? productionLaunchctlRunner();
  const validateCandidate = options.validateCandidate ?? productionCandidateValidator();
  const now = options.now ?? (() => new Date());
  const context = {
    layout,
    runner,
    validateCandidate,
    now,
    crashAfterStep: options.crashAfterStep,
    step: 0,
  };
  const packageState = await validatePreflight(context, command);
  if (command === "preflight") return { state: "ready", promotionId: PROMOTION_ID };
  if (command === "handoff") return await handoff(context, packageState);
  return await rollback(context, packageState);
}

async function validatePreflight(context, command) {
  const { layout, now } = context;
  assertRegularOwnerOnly(layout.promotionPackage, layout.uid, 0o600, "promotion package");
  const envelope = JSON.parse(readFileSync(layout.promotionPackage, "utf8"));
  if (envelope?.payload?.version !== 1 || envelope.payload.promotionId !== PROMOTION_ID ||
      typeof envelope.signature !== "string") {
    throw new Error("invalid promotion package");
  }
  const payloadKeys = [
    "version", "promotionId", "issuedAt", "expiresAt",
    "promotionInputSha256", "release", "rollbackRef", "artifacts",
  ].sort();
  if (JSON.stringify(Object.keys(envelope.payload).sort()) !== JSON.stringify(payloadKeys)) {
    throw new Error("promotion package payload shape is not exact");
  }
  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  const current = now().getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("promotion timestamps are invalid");
  }
  if (issuedAt > current) throw new Error("promotion package is future-dated");
  if (expiresAt <= current) throw new Error("promotion package is expired");

  const promotion = loadCanonicalPromotionInput(layout.promotionInput);
  if (envelope.payload.promotionInputSha256 !== promotion.inputSha256 ||
      canonicalJson(envelope.payload.release) !== canonicalJson(promotion.release) ||
      envelope.payload.rollbackRef !== promotion.rollbackRef ||
      envelope.payload.issuedAt !== promotion.issuedAt ||
      envelope.payload.expiresAt !== promotion.expiresAt) {
    throw new Error("promotion package does not match the canonical promotion input");
  }
  const expectedPaths = Object.fromEntries(CONTROLLED_MUTATION_ARTIFACT_KEYS.map((key) => [
    key,
    key === "opsdBinary"
      ? join(promotion.release.dir, "plugins", "ops-agent", "lib", "bin", "opsd.js")
      : layout[key],
  ]));
  const artifacts = envelope.payload.artifacts;
  if (artifacts === null || typeof artifacts !== "object" ||
      JSON.stringify(Object.keys(artifacts).sort()) !==
        JSON.stringify([...CONTROLLED_MUTATION_ARTIFACT_KEYS].sort())) {
    throw new Error("promotion artifact set is not exact");
  }
  for (const key of CONTROLLED_MUTATION_ARTIFACT_KEYS) {
    const expectedPath = expectedPaths[key];
    const artifact = artifacts[key];
    if (artifact?.path !== expectedPath) throw new Error(`arbitrary artifact path refused: ${key}`);
    if (key === "activeConfig" && command !== "preflight") {
      assertLiveConfigIdentity(layout, artifacts);
      continue;
    }
    assertArtifact(artifact, key);
  }
  if (layout.expectedLegacyHashes !== undefined) {
    for (const [key, label] of [
      ["legacyRuntimePlist", LEGACY_RUNTIME_LABEL],
      ["legacyAfterDataLakePlist", LEGACY_AFTER_DATALAKE_LABEL],
    ]) {
      if (artifacts[key].sha256 !== layout.expectedLegacyHashes[label]) {
        throw new Error(`legacy plist hash does not match captured identity: ${label}`);
      }
    }
  }

  const publicKey = createPublicKey(readFileSync(layout.publicKey));
  if (layout.expectedPromotionKeySha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(layout.expectedPromotionKeySha256)) {
      throw new Error("promotion signing key is not commissioned");
    }
    if (sha256(layout.publicKey) !== layout.expectedPromotionKeySha256) {
      throw new Error("promotion signing key fingerprint mismatch");
    }
  }
  if (!verify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    publicKey,
    Buffer.from(envelope.signature, "base64"),
  )) {
    throw new Error("promotion package signature is invalid");
  }
  const candidate = JSON.parse(readFileSync(layout.candidateConfig, "utf8"));
  const expectedBundle = join(
    promotion.release.dir,
    "ops",
    "promotions",
    PROMOTION_ID,
  );
  if (candidate.mode !== "approve" || candidate.releaseDir !== promotion.release.dir ||
      candidate.promotionBundleDir !== expectedBundle ||
      candidate.authorityManifestPath !== layout.authorityManifest ||
      candidate.trustedKeyPath !== layout.publicKey) {
    throw new Error("candidate config is not strict approve mode");
  }
  const authority = JSON.parse(readFileSync(layout.authorityManifest, "utf8"));
  if (!Array.isArray(authority.entries) || authority.entries.length !== 1 ||
      authority.entries[0]?.sopId !== "trading-stack-container-reconcile" ||
      authority.promotion?.promotionId !== PROMOTION_ID ||
      authority.promotion?.inputSha256 !== promotion.inputSha256) {
    throw new Error("authority manifest does not grant the exact promotion SOP");
  }
  await context.validateCandidate({
    executable: expectedPaths.opsdBinary,
    configPath: layout.candidateConfig,
    releaseDir: promotion.release.dir,
  });
  const relevant = await relevantLabels(context);
  const extras = relevant.filter((label) =>
    label !== OPSD_LABEL && label !== LEGACY_RUNTIME_LABEL && label !== LEGACY_AFTER_DATALAKE_LABEL);
  if (extras.length > 0) throw new Error(`extra Colima controller labels: ${extras.join(",")}`);
  if (command === "preflight") {
    for (const required of [OPSD_LABEL, LEGACY_RUNTIME_LABEL, LEGACY_AFTER_DATALAKE_LABEL]) {
      if (!relevant.includes(required)) throw new Error(`required controller label is not loaded: ${required}`);
    }
    const active = JSON.parse(readFileSync(layout.activeConfig, "utf8"));
    if (active.mode !== "observe") throw new Error("preflight requires active observe config");
  }
  return { envelope, artifacts, promotion };
}

async function handoff(context, packageState) {
  const startedAt = context.now();
  await step(context, "durable-backup", async () => ensureBackup(context.layout, packageState));
  await step(context, `bootout:${LEGACY_RUNTIME_LABEL}`, async () =>
    bootoutIfLoaded(context, LEGACY_RUNTIME_LABEL));
  await step(context, `bootout:${LEGACY_AFTER_DATALAKE_LABEL}`, async () =>
    bootoutIfLoaded(context, LEGACY_AFTER_DATALAKE_LABEL));
  await step(context, "verify-legacy-absent", async () => {
    const labels = await relevantLabels(context);
    for (const label of [LEGACY_RUNTIME_LABEL, LEGACY_AFTER_DATALAKE_LABEL]) {
      if (labels.includes(label)) throw new Error(`legacy label remains loaded: ${label}`);
    }
  });
  await step(context, `bootout:${OPSD_LABEL}`, async () => bootoutIfLoaded(context, OPSD_LABEL));
  await step(context, "switch-approve-config", async () =>
    atomicReplace(context.layout.candidateConfig, context.layout.activeConfig, 0o600));
  await step(context, `bootstrap:${OPSD_LABEL}`, async () =>
    launchctl(context, ["bootstrap", domain(context.layout), context.layout.opsdPlist]));
  await step(context, "verify-approve-cycle", async () => {
    const labels = await relevantLabels(context);
    if (!labels.includes(OPSD_LABEL) || labels.includes(LEGACY_RUNTIME_LABEL) ||
        labels.includes(LEGACY_AFTER_DATALAKE_LABEL)) {
      throw new Error("approve handoff did not establish one controller");
    }
    verifyFreshZeroActionCycle(context.layout, startedAt, context.now());
  });
  return { state: "approve-ready", promotionId: PROMOTION_ID };
}

async function rollback(context, packageState) {
  if (!existsSync(context.layout.backupManifest)) {
    if (!existsSync(context.layout.journalPath)) {
      return { state: "not-started", promotionId: PROMOTION_ID };
    }
    throw new Error("rollback requires the durable backup");
  }
  validateBackup(context.layout, packageState);
  await step(context, `rollback-bootout:${OPSD_LABEL}`, async () =>
    bootoutIfLoaded(context, OPSD_LABEL));
  await step(context, "rollback-restore-observe-config", async () =>
    atomicReplace(context.layout.backupActiveConfig, context.layout.activeConfig, 0o600));
  await step(context, `rollback-bootstrap:${LEGACY_RUNTIME_LABEL}`, async () =>
    bootstrapIfAbsent(context, LEGACY_RUNTIME_LABEL, context.layout.legacyRuntimePlist));
  await step(context, `rollback-bootstrap:${LEGACY_AFTER_DATALAKE_LABEL}`, async () =>
    bootstrapIfAbsent(context, LEGACY_AFTER_DATALAKE_LABEL, context.layout.legacyAfterDataLakePlist));
  await step(context, `rollback-bootstrap:${OPSD_LABEL}`, async () =>
    bootstrapIfAbsent(context, OPSD_LABEL, context.layout.opsdPlist));
  await step(context, "rollback-verify", async () => {
    const active = JSON.parse(readFileSync(context.layout.activeConfig, "utf8"));
    if (active.mode !== "observe") throw new Error("rollback left residual approve authority");
    const labels = await relevantLabels(context);
    for (const required of [OPSD_LABEL, LEGACY_RUNTIME_LABEL, LEGACY_AFTER_DATALAKE_LABEL]) {
      if (!labels.includes(required)) throw new Error(`rollback did not restore label: ${required}`);
    }
  });
  return { state: "observe-restored", promotionId: PROMOTION_ID };
}

async function step(context, name, operation) {
  appendJournal(context.layout, { at: context.now().toISOString(), phase: "before", step: name });
  await operation();
  appendJournal(context.layout, { at: context.now().toISOString(), phase: "after", step: name });
  context.step += 1;
  if (context.crashAfterStep === context.step) {
    throw new Error(`injected crash after step ${context.step}`);
  }
}

function ensureBackup(layout, packageState) {
  if (existsSync(layout.backupManifest)) {
    validateBackup(layout, packageState);
    return;
  }
  mkdirPrivate(layout.backupRoot);
  const files = {};
  for (const key of CONTROLLED_MUTATION_ARTIFACT_KEYS) {
    const source = layout[key];
    const target = join(layout.backupRoot, `${key}.bin`);
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    // copyFile preserves contents; make the backup private regardless of the
    // source plist's mode.
    chmodSync(target, 0o600);
    fsyncFile(target);
    files[key] = { path: target, sha256: sha256(target) };
  }
  // The stable alias is what rollback consumes.
  if (files.activeConfig.path !== layout.backupActiveConfig) {
    throw new Error("backup active config path is not canonical");
  }
  writeFileSync(layout.backupManifest, `${JSON.stringify({ version: 1, files })}\n`, {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  fsyncDirectory(layout.backupRoot);
}

function validateBackup(layout, packageState) {
  assertRegularOwnerOnly(layout.backupManifest, layout.uid, 0o600, "backup manifest");
  const backup = JSON.parse(readFileSync(layout.backupManifest, "utf8"));
  if (backup.version !== 1) throw new Error("backup manifest version mismatch");
  for (const key of CONTROLLED_MUTATION_ARTIFACT_KEYS) {
    const row = backup.files?.[key];
    const expectedPath = join(layout.backupRoot, `${key}.bin`);
    if (row?.path !== expectedPath || row.sha256 !== sha256(expectedPath)) {
      throw new Error(`backup identity drift: ${key}`);
    }
    if (key === "activeConfig" && row.sha256 !== packageState.artifacts.activeConfig.sha256) {
      throw new Error("backup observe config does not match signed promotion package");
    }
  }
}

function assertLiveConfigIdentity(layout, artifacts) {
  const actual = sha256(layout.activeConfig);
  if (actual !== artifacts.activeConfig.sha256 && actual !== artifacts.candidateConfig.sha256) {
    throw new Error("active config identity drift");
  }
  const stat = safeRegularStat(layout.activeConfig, "active config");
  if (stat.uid !== artifacts.activeConfig.uid || (stat.mode & 0o777) !== artifacts.activeConfig.mode) {
    throw new Error("active config owner or mode mismatch");
  }
}

function assertArtifact(artifact, key) {
  if (artifact === null || typeof artifact !== "object" ||
      typeof artifact.sha256 !== "string" || !Number.isInteger(artifact.uid) ||
      !Number.isInteger(artifact.mode)) {
    throw new Error(`invalid artifact identity: ${key}`);
  }
  const stat = safeRegularStat(artifact.path, key);
  if (stat.uid !== artifact.uid) throw new Error(`${key} owner mismatch`);
  if ((stat.mode & 0o777) !== artifact.mode) throw new Error(`${key} mode mismatch`);
  if (sha256(artifact.path) !== artifact.sha256) throw new Error(`${key} hash mismatch`);
}

function assertRegularOwnerOnly(path, uid, mode, label) {
  const stat = safeRegularStat(path, label);
  if (stat.uid !== uid) throw new Error(`${label} owner mismatch`);
  if ((stat.mode & 0o777) !== mode) throw new Error(`${label} mode mismatch`);
}

function safeRegularStat(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

async function relevantLabels(context) {
  const result = await launchctl(context, ["list"]);
  const lines = result.stdout.split("\n").filter(Boolean);
  const body = lines[0] === "PID\tStatus\tLabel" ? lines.slice(1) : lines;
  const labels = body.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields[2] === "") throw new Error("launchctl list is unparseable");
    return fields[2];
  });
  return labels.filter((label) =>
    label === OPSD_LABEL || label.startsWith("com.moremeds.colima-"));
}

async function isLoaded(context, label) {
  const result = await context.runner.run("/bin/launchctl", ["print", `${domain(context.layout)}/${label}`]);
  return result.exitCode === 0;
}

async function bootoutIfLoaded(context, label) {
  if (!await isLoaded(context, label)) return;
  await launchctl(context, ["bootout", `${domain(context.layout)}/${label}`]);
}

async function bootstrapIfAbsent(context, label, plist) {
  if (await isLoaded(context, label)) return;
  await launchctl(context, ["bootstrap", domain(context.layout), plist]);
}

async function launchctl(context, argv) {
  const result = await context.runner.run("/bin/launchctl", argv);
  if (result.exitCode !== 0) throw new Error(`launchctl ${argv[0]} failed: ${result.exitCode}`);
  return result;
}

function domain(layout) {
  return `gui/${layout.uid}`;
}

function verifyFreshZeroActionCycle(layout, startedAt, now) {
  const lower = startedAt.getTime();
  const upper = now.getTime();
  let cycle = false;
  for (const line of readFileSync(layout.eventsPath, "utf8").split("\n").filter(Boolean)) {
    const value = JSON.parse(line);
    const record = value.record ?? value;
    const at = Date.parse(record.at);
    if (at > upper) throw new Error("future-dated ops event refused");
    if (at < lower) continue;
    if (record.type === "action-intent-recorded" || record.type === "action-receipt-recorded") {
      throw new Error("approve cycle was not zero-action");
    }
    if (record.type === "controller-cycle-recorded" && record.controllerId === OPSD_LABEL) {
      cycle = true;
    }
  }
  if (!cycle) throw new Error("approve opsd produced no fresh zero-action cycle");
}

function atomicReplace(source, target, mode) {
  const bytes = readFileSync(source);
  const staging = join(dirname(target), `.${PROMOTION_ID}.${process.pid}.tmp`);
  writeFileSync(staging, bytes, { mode, flag: "wx", flush: true });
  renameSync(staging, target);
  fsyncDirectory(dirname(target));
}

function appendJournal(layout, value) {
  mkdirPrivate(dirname(layout.journalPath));
  appendFileSync(layout.journalPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const fd = openSync(layout.journalPath, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dirname(layout.journalPath));
}

function mkdirPrivate(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`private directory invariant failed: ${path}`);
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncFile(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadCanonicalPromotionInput(path) {
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function productionLaunchctlRunner() {
  return {
    async run(executable, argv) {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(executable, argv, {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        });
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let settled = false;
        const absorb = (stream, chunk) => {
          bytes += chunk.length;
          if (bytes > 1_000_000) {
            child.kill("SIGKILL");
            return;
          }
          if (stream === "stdout") stdout += chunk.toString();
          else stderr += chunk.toString();
        };
        child.stdout.on("data", (chunk) => absorb("stdout", chunk));
        child.stderr.on("data", (chunk) => absorb("stderr", chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise(result);
        };
        child.once("error", rejectPromise);
        child.once("close", (code) => finish({
          exitCode: bytes > 1_000_000 ? 74 : code ?? 1,
          stdout,
          stderr,
        }));
      });
    },
  };
}

function productionCandidateValidator() {
  return async ({ executable, configPath, releaseDir }) => {
    const { spawn } = await import("node:child_process");
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [
        executable,
        "--check-config",
        configPath,
        "--release",
        releaseDir,
      ], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      let stderr = "";
      let bytes = 0;
      let settled = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64_000) child.kill("SIGKILL");
        else stderr += chunk.toString();
      });
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (code === 0 && bytes <= 64_000) finish();
        else finish(new Error(`candidate opsd config check failed: ${code ?? 1}: ${stderr.slice(-4_000)}`));
      });
    });
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = process.argv.slice(2);
  const running = cli.length === 1
    ? runControlledMutation(cli[0])
    : Promise.reject(new Error("usage: controlled-mutation.mjs preflight|handoff|rollback"));
  running.then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "controlled mutation refused"}\n`);
      process.exitCode = 1;
    },
  );
}
