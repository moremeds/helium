import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { composeLivewireOpsDaemon } from "../../plugins/livewire-shepherd/lib/bin/livewire-opsd.js";
import { loadShepherdRuntimeConfig } from "../../plugins/livewire-shepherd/lib/config.js";
import { loadOpsdRuntimeConfig } from "../../plugins/ops-agent/lib/index.js";
import { prepareLivewireShepherdPromotion } from "./prepare-livewire-shepherd-promotion.mjs";
import { exportLivewirePromotionEvidence } from "./livewire-promotion-evidence.mjs";
import { runManifestSigner } from "./sign-authority-manifest.mjs";
import { hardwareIdentityHash } from "./signing-host-policy.mjs";

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("prepares, signs, installs, and validates one exact automatic Livewire repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-livewire-promotion-"));
  roots.push(root);
  const release = process.cwd();
  const releaseCommit = execFileSync("git", ["-C", release, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const livewire = join(root, "livewire");
  const moduleDir = join(livewire, "livewire_scripts");
  const clientsDir = join(livewire, "clients");
  const installHome = mkdtempSync("/tmp/lws-home-");
  roots.push(installHome);
  const installRoot = join(installHome, ".helium", "livewire-shepherd");
  const ready = join(root, "ready");
  const lake = join(root, "lake");
  const shepherdState = join(root, "shepherd-state");
  const promotion = join(root, "promotion");
  const configDir = join(root, "config-source");
  for (const path of [moduleDir, clientsDir, ready, lake, shepherdState, configDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(moduleDir, "__init__.py"), "", { mode: 0o600 });
  writeFileSync(join(moduleDir, "shepherd_repair.py"), "print('fixture')\n", { mode: 0o600 });
  writeFileSync(join(clientsDir, "shepherd_repair.py"), "# fixture mutator\n", { mode: 0o600 });
  const sourceManifest = join(root, "livewire.sha256");
  writeFileSync(sourceManifest, [
    `${sha(join(moduleDir, "__init__.py"))}  livewire_scripts/__init__.py`,
    `${sha(join(moduleDir, "shepherd_repair.py"))}  livewire_scripts/shepherd_repair.py`,
    `${sha(join(clientsDir, "shepherd_repair.py"))}  clients/shepherd_repair.py`,
    "",
  ].join("\n"), { mode: 0o600 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKey = join(root, "authority.pub.pem");
  const privateKeyPath = join(root, "authority.pem");
  writeFileSync(trustedKey, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 });
  writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const opsConfigPath = join(configDir, "ops.json");
  const shepherdConfigPath = join(configDir, "shepherd.json");
  const fixturePythonRuntime = [{ path: process.execPath, sha256: sha(process.execPath) }];
  const prepared = prepareLivewireShepherdPromotion({
    releaseDir: release,
    releaseCommit,
    livewireRoot: livewire,
    pythonBin: process.execPath,
    nodeBin: realpathSync(process.execPath),
    sourceManifest,
    readyDir: ready,
    dataLakeRoot: lake,
    installRoot,
    promotionDir: promotion,
    trustedKey,
    shepherdStateRoot: shepherdState,
    outputOpsConfig: opsConfigPath,
    outputShepherdConfig: shepherdConfigPath,
    issuedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    rollbackRef: "git:fixture-parent",
    verifyReleaseClean: () => {},
    resolvePythonRuntimeFiles: () => fixturePythonRuntime,
  });
  const preparedInput = JSON.parse(readFileSync(prepared.promotionInputPath, "utf8"));
  assert.equal(preparedInput.registeredProbes.path, prepared.registeredProbesPath);
  assert.equal(preparedInput.livewireSource.root, livewire);
  assert.deepEqual(preparedInput.livewireSource.files.map((row) => row.path), [
    "clients/shepherd_repair.py",
    "livewire_scripts/__init__.py",
    "livewire_scripts/shepherd_repair.py",
  ]);
  const operatorIdentity = "fixture-operator";
  const evidenceDir = join(root, "offline-evidence");
  exportLivewirePromotionEvidence({
    promotionInputPath: prepared.promotionInputPath,
    outputDir: evidenceDir,
  });
  const operatorInput = join(root, "operator-promotion-input.json");
  writeFileSync(operatorInput, readFileSync(prepared.promotionInputPath), { mode: 0o600 });
  await runManifestSigner([
    "--sops-dir", join(promotion, "sops"),
    "--components-dir", join(promotion, "components"),
    "--checks-dir", join(promotion, "checks"),
    "--executors-dir", join(promotion, "executors"),
    "--registered-probes", prepared.registeredProbesPath,
    "--private-key", privateKeyPath,
    "--output", join(promotion, "authority-manifest.json"),
    "--promotion-input", operatorInput,
    "--release-checkout", release,
    "--executor-source", prepared.stagedTransaction,
    "--verification-executor-source", prepared.stagedPostcondition,
    "--offline-evidence", evidenceDir,
  ], {
    signingHost: {
      hardwareIdentity: operatorIdentity,
      policy: {
        version: 1,
        allowedOperatorHostHashes: [hardwareIdentityHash(operatorIdentity)],
        forbiddenMiniHostHashes: [hardwareIdentityHash("fixture-mini")],
      },
    },
    resolveReleaseCommit: () => releaseCommit,
    assertReleaseClean: () => {},
    resolveRuntimeFiles: () => { throw new Error("offline signer read production Node runtime"); },
    resolvePythonRuntimeFiles: () => { throw new Error("offline signer executed production Python runtime"); },
  });

  const launchdRoot = join(installHome, "Library", "LaunchAgents");
  const installArgs = [
    join(release, "scripts", "ops", "install-livewire-shepherd.sh"),
    "--release", release,
    "--root", installRoot,
    "--launchd-root", launchdRoot,
    "--promotion-dir", promotion,
    "--ops-config", opsConfigPath,
    "--shepherd-config", shepherdConfigPath,
  ];
  const installResults = await Promise.all([
    runProcess("/bin/bash", installArgs, { ...process.env, HELIUM_NODE_BIN: process.execPath }),
    runProcess("/bin/bash", installArgs, { ...process.env, HELIUM_NODE_BIN: process.execPath }),
  ]);
  assert.deepEqual(
    installResults.map((result) => result.code).sort((a, b) => a - b),
    [0, 73],
    JSON.stringify(installResults),
  );
  assert.match(
    readFileSync(join(launchdRoot, "com.helium.livewire-opsd.plist"), "utf8"),
    /com\.helium\.livewire-opsd/,
  );
  assert.deepEqual(readdirSync(shepherdState), [], "check-config must not open or mutate Shepherd state");
  const secondHome = mkdtempSync("/tmp/lws-home-");
  roots.push(secondHome);
  const secondRoot = join(secondHome, ".helium", "livewire-shepherd");
  assert.throws(() => execFileSync("/bin/bash", [
    join(release, "scripts", "ops", "install-livewire-shepherd.sh"),
    "--release", release,
    "--root", secondRoot,
    "--launchd-root", join(secondHome, "Library", "LaunchAgents"),
    "--promotion-dir", promotion,
    "--ops-config", opsConfigPath,
    "--shepherd-config", shepherdConfigPath,
  ], { env: { ...process.env, HELIUM_NODE_BIN: process.execPath }, stdio: "pipe" }));
  assert.equal(existsSync(secondRoot), false);

  const daemon = composeLivewireOpsDaemon(
    loadOpsdRuntimeConfig(opsConfigPath),
    loadShepherdRuntimeConfig(shepherdConfigPath),
  );
  assert.ok(daemon);

  const shepherdConfigBytes = readFileSync(shepherdConfigPath);
  const widenedShepherdConfig = JSON.parse(shepherdConfigBytes.toString("utf8"));
  widenedShepherdConfig.livewire.changedPathRoots = [root];
  writeFileSync(shepherdConfigPath, `${JSON.stringify(widenedShepherdConfig)}\n`);
  assert.throws(() => composeLivewireOpsDaemon(
    loadOpsdRuntimeConfig(opsConfigPath),
    loadShepherdRuntimeConfig(shepherdConfigPath),
  ), /signed.*config|config.*signed/i);
  writeFileSync(shepherdConfigPath, shepherdConfigBytes);

  const runtimePath = join(release, "plugins", "livewire-shepherd", "lib", "bin", "livewire-opsd.js");
  const runtimeBytes = readFileSync(runtimePath);
  const installerExecutionMarker = join(root, "drifted-runtime-executed");
  try {
    writeFileSync(runtimePath, runtimeBytes.toString("utf8").replace(
      "\n",
      `\nimport { writeFileSync as __markDrift } from "node:fs"; __markDrift(${JSON.stringify(installerExecutionMarker)}, "executed");\n`,
    ));
    const driftHome = mkdtempSync("/tmp/lws-home-");
    roots.push(driftHome);
    assert.throws(() => execFileSync("/bin/bash", [
      join(release, "scripts", "ops", "install-livewire-shepherd.sh"),
      "--release", release,
      "--root", join(driftHome, ".helium", "livewire-shepherd"),
      "--launchd-root", join(driftHome, "Library", "LaunchAgents"),
      "--promotion-dir", promotion,
      "--ops-config", opsConfigPath,
      "--shepherd-config", shepherdConfigPath,
    ], { env: { ...process.env, HELIUM_NODE_BIN: process.execPath }, stdio: "pipe" }));
    assert.equal(existsSync(installerExecutionMarker), false, "installer executed changed release code before hash validation");
    assert.throws(() => composeLivewireOpsDaemon(
      loadOpsdRuntimeConfig(opsConfigPath),
      loadShepherdRuntimeConfig(shepherdConfigPath),
    ), /runtime hashes differ/i);
  } finally {
    writeFileSync(runtimePath, runtimeBytes);
  }

  const signedPromotion = JSON.parse(readFileSync(prepared.promotionInputPath, "utf8"));
  const dependency = signedPromotion.runtimeFiles.find((file) =>
    file.path.includes("node_modules") && file.path.endsWith("package.json"));
  assert.ok(dependency, "fixture must bind at least one external Node dependency");
  const dependencyBytes = readFileSync(dependency.path);
  try {
    writeFileSync(dependency.path, Buffer.concat([dependencyBytes, Buffer.from("\n")]))
    assert.throws(() => composeLivewireOpsDaemon(
      loadOpsdRuntimeConfig(opsConfigPath),
      loadShepherdRuntimeConfig(shepherdConfigPath),
    ), /runtime hashes differ/i);
  } finally {
    writeFileSync(dependency.path, dependencyBytes);
  }

  const runtimeManifestBytes = readFileSync(signedPromotion.runtimeManifest.path);
  writeFileSync(signedPromotion.runtimeManifest.path, Buffer.concat([runtimeManifestBytes, Buffer.from("# drift\n")]));
  assert.throws(() => execFileSync("/bin/bash", [join(release, "scripts", "ops", "run-livewire-opsd.sh")], {
    env: {
      ...process.env,
      HELIUM_NODE_BIN: process.execPath,
      HELIUM_NODE_RUNTIME_MANIFEST: signedPromotion.runtimeManifest.path,
      HELIUM_NODE_RUNTIME_MANIFEST_SHA256: signedPromotion.runtimeManifest.sha256,
      HELIUM_LIVEWIRE_OPS_CONFIG: opsConfigPath,
      HELIUM_SHEPHERD_CONFIG: shepherdConfigPath,
    },
    stdio: "pipe",
  }), /runtime manifest changed/i);
  writeFileSync(signedPromotion.runtimeManifest.path, runtimeManifestBytes);

  const actions = join(installRoot, "actions");
  const postconditionInstalled = join(actions, "livewire-repair-postcondition");
  const postconditionBytes = readFileSync(postconditionInstalled);
  chmodSync(postconditionInstalled, 0o700);
  writeFileSync(postconditionInstalled, "drift\n");
  chmodSync(postconditionInstalled, 0o500);
  assert.throws(() => composeLivewireOpsDaemon(
    loadOpsdRuntimeConfig(opsConfigPath),
    loadShepherdRuntimeConfig(shepherdConfigPath),
  ), /postcondition executor identity|script-drift/i);
  chmodSync(postconditionInstalled, 0o700);
  writeFileSync(postconditionInstalled, postconditionBytes);
  chmodSync(postconditionInstalled, 0o500);

  const promotionInputBytes = readFileSync(prepared.promotionInputPath);
  const widenedPromotion = JSON.parse(promotionInputBytes.toString("utf8"));
  widenedPromotion.rollbackRef = "git:attacker-changed";
  writeFileSync(prepared.promotionInputPath, `${JSON.stringify(widenedPromotion)}\n`);
  assert.throws(() => composeLivewireOpsDaemon(
    loadOpsdRuntimeConfig(opsConfigPath),
    loadShepherdRuntimeConfig(shepherdConfigPath),
  ), /complete runtime bundle/);
  writeFileSync(prepared.promotionInputPath, promotionInputBytes);

  chmodSync(join(actions, "livewire-repair-transaction"), 0o700);
  writeFileSync(join(actions, "livewire-repair-transaction"), "drift\n");
  chmodSync(join(actions, "livewire-repair-transaction"), 0o500);
  assert.throws(() => composeLivewireOpsDaemon(
    loadOpsdRuntimeConfig(opsConfigPath),
    loadShepherdRuntimeConfig(shepherdConfigPath),
  ), /executor identity|script-drift/i);
});

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runProcess(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env, stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}
