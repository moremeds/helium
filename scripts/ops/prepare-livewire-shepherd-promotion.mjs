#!/usr/bin/env node
/** Build the exact, unsigned Livewire repair promotion and runtime configs. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/core/lib/index.js";
import {
  automaticAuthorityInputDigest,
  livewireRuntimeFiles,
  nativeRuntimeFiles,
} from "../../plugins/ops-agent/lib/index.js";
import { execFileSync } from "node:child_process";

const FLAGS = new Set([
  "--release-dir", "--release-commit", "--livewire-root", "--python-bin", "--node-bin",
  "--source-manifest", "--ready-dir", "--data-lake-root", "--install-root",
  "--promotion-dir", "--trusted-key", "--shepherd-state-root",
  "--output-ops-config", "--output-shepherd-config", "--issued-at", "--expires-at",
  "--rollback-ref",
]);

export function prepareLivewireShepherdPromotion(raw) {
  const input = validate(raw);
  const transactionTimeoutMs = 600_000;
  (raw.verifyReleaseClean ?? assertCleanRelease)(input.releaseDir);
  const dirs = Object.fromEntries(
    ["components", "checks", "dependencies", "executors", "sops", "actions"]
      .map((name) => [name, join(input.promotionDir, name)]),
  );
  mkdirSync(input.promotionDir, { recursive: false, mode: 0o700 });
  for (const path of Object.values(dirs)) mkdirSync(path, { mode: 0o700 });

  const template = readFileSync(
    join(input.releaseDir, "scripts/ops/actions/livewire-repair-wrapper.sh.template"),
    "utf8",
  );
  const sourceManifestSha = sha256(input.sourceManifest);
  const livewireSourceFiles = validateSourceManifestCoverage(input.livewireRoot, input.sourceManifest);
  const pythonRuntimeFiles = (raw.resolvePythonRuntimeFiles ?? discoverPythonRuntimeFiles)(input.pythonBin);
  const pythonRuntimeManifestPath = join(input.promotionDir, "python-runtime.sha256");
  const pythonRuntimeManifestBytes = `${pythonRuntimeFiles
    .map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
  writeTextExclusive(pythonRuntimeManifestPath, pythonRuntimeManifestBytes, 0o600);
  const common = {
    __READY_DIR__: input.readyDir,
    __PYTHON_BIN__: input.pythonBin,
    __PYTHON_SHA256__: sha256(input.pythonBin),
    __LIVEWIRE_ROOT__: input.livewireRoot,
    __SOURCE_MANIFEST__: input.sourceManifest,
    __SOURCE_MANIFEST_SHA256__: sourceManifestSha,
    __PYTHON_RUNTIME_MANIFEST__: pythonRuntimeManifestPath,
    __PYTHON_RUNTIME_MANIFEST_SHA256__: sha256(pythonRuntimeManifestPath),
    __DATA_LAKE_ROOT__: input.dataLakeRoot,
    __CHILD_TIMEOUT_SECONDS__: String(Math.ceil(transactionTimeoutMs / 1_000)),
  };
  const stagedTransaction = join(dirs.actions, "livewire-repair-transaction");
  const stagedPostcondition = join(dirs.actions, "livewire-repair-postcondition");
  renderWrapper(template, { ...common, __COMMAND__: "transaction" }, stagedTransaction);
  renderWrapper(template, { ...common, __COMMAND__: "postcondition" }, stagedPostcondition);

  const transactionPath = join(input.installRoot, "actions", "livewire-repair-transaction");
  const postconditionPath = join(input.installRoot, "actions", "livewire-repair-postcondition");
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  const component = {
    version: 1,
    id: "livewire",
    kind: "data-service",
    dimensions: ["integrity"],
    mutationOwner: {
      owner: "opsd",
      competingLabels: [],
      changedAt: input.issuedAt,
      changeRef: `promotion://livewire-shepherd-targeted-repair/${input.releaseCommit}`,
    },
  };
  const check = {
    id: "livewire-repair-verified",
    kind: "business",
    probe: { probeId: "livewire.repair-postcondition.v1", args: {} },
    expect: { dimension: "repair", operator: "eq", value: true },
    onUnavailable: "unknown",
    timeoutMs: transactionTimeoutMs,
    owner: "ops",
  };
  const manifestPattern = `${escapeRegex(input.readyDir)}/sha256:[0-9a-f]{64}\\.json`;
  const transaction = {
    executorId: "livewire-repair-transaction",
    path: transactionPath,
    identity: { kind: "sha256", value: sha256(stagedTransaction) },
    argvSchema: {
      id: "livewire-repair-transaction-v1",
      params: [{ flag: "--manifest", valuePattern: manifestPattern, required: true }],
    },
    cwd: input.livewireRoot,
    environmentProfile: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeoutMs: 600_000,
    maxOutputBytes: 262_144,
    expectedOwnerUid: owner,
  };
  const postcondition = {
    ...transaction,
    executorId: "livewire-repair-postcondition",
    path: postconditionPath,
    identity: { kind: "sha256", value: sha256(stagedPostcondition) },
    argvSchema: {
      id: "livewire-repair-postcondition-v1",
      params: [{ flag: "--manifest", valuePattern: manifestPattern, required: true }],
    },
  };
  const unsignedSop = {
    version: 1,
    id: "livewire-shepherd-targeted-repair",
    componentId: "livewire",
    matches: { dimension: "integrity", failureClass: "failed" },
    authority: "auto",
    mutating: true,
    priority: 100,
    action: {
      executorId: transaction.executorId,
      executable: { path: transaction.path, identity: transaction.identity },
      argvSchemaId: transaction.argvSchema.id,
      cwdId: "livewire-workdir",
      environmentProfileId: "ops-minimal",
      timeoutMs: transaction.timeoutMs,
    },
    preconditions: [],
    postconditions: [check.id],
    exclusiveGroup: "livewire-target-repair",
    graceMs: 0,
    maxAttempts: 1,
    cooldownMs: 3_600_000,
  };
  const sop = {
    ...unsignedSop,
    digest: `sha256:${createHash("sha256").update(canonicalJson(unsignedSop)).digest("hex")}`,
  };
  const documents = [
    [join(dirs.components, "livewire.yaml"), component],
    [join(dirs.checks, "livewire-repair-verified.yaml"), check],
    [join(dirs.executors, "livewire-repair-postcondition.yaml"), postcondition],
    [join(dirs.executors, "livewire-repair-transaction.yaml"), transaction],
    [join(dirs.sops, "livewire-shepherd-targeted-repair.yaml"), sop],
  ];
  for (const [path, value] of documents) writeExclusive(path, value);
  const registeredProbesPath = join(input.promotionDir, "registered-probes.json");
  const registeredProbes = { version: 1, probeIds: [check.probe.probeId] };
  writeExclusive(registeredProbesPath, registeredProbes);

  const cap = {
    kind: "manifest-argv-v1",
    sopId: sop.id,
    componentId: component.id,
    executorId: transaction.executorId,
    postconditionIds: [check.id],
    manifestRoot: input.readyDir,
    verificationExecutor: {
      executorId: postcondition.executorId,
      path: postcondition.path,
      identity: postcondition.identity,
      expectedOwnerUid: postcondition.expectedOwnerUid,
      argvSchema: postcondition.argvSchema,
    },
  };
  const automaticAuthorityDigest = automaticAuthorityInputDigest({
    cap,
    component,
    sop,
    checks: [check],
    executor: transaction,
    verificationExecutor: postcondition,
  });
  const bundleFiles = documents.map(([path]) => ({
    path: relative(input.promotionDir, path),
    sha256: sha256(path),
  }));
  const nodeBinary = {
    path: realpathSync(input.nodeBin),
    sha256: sha256(realpathSync(input.nodeBin)),
  };
  const runtimeFiles = livewireRuntimeFiles(input.releaseDir, nodeBinary.path);
  const runtimeManifestPath = join(input.promotionDir, "node-runtime.sha256");
  const runtimeManifestBytes = `${runtimeFiles.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
  writeTextExclusive(runtimeManifestPath, runtimeManifestBytes, 0o600);
  const opsConfig = {
    version: 1,
    mode: "auto",
    releaseDir: input.releaseDir,
    promotionBundleDir: input.promotionDir,
    automaticAuthority: cap,
    componentsDir: "components",
    dependenciesDir: "dependencies",
    checksDir: "checks",
    sopsDir: "sops",
    executorsDir: "executors",
    authorityManifestPath: join(input.promotionDir, "authority-manifest.json"),
    trustedKeyPath: input.trustedKey,
    stateDir: join(input.installRoot, "ops-state"),
    socketPath: join(input.installRoot, "run", "livewire-opsd.sock"),
    intervalMs: 60_000,
    maxFiles: 50,
    maxComponents: 10,
    maxSops: 10,
    maxChecks: 20,
    maxFileBytes: 1_000_000,
  };
  const shepherdConfig = {
    version: 1,
    stateRoot: input.shepherdStateRoot,
    appendLockRoot: join(input.installRoot, "append-locks"),
    intervalMs: 60_000,
    providerRetryMs: 300_000,
    livewire: {
      executorId: postcondition.executorId,
      changedPathRoots: [input.dataLakeRoot],
      repair: {
        executorId: transaction.executorId,
        postconditionExecutorId: postcondition.executorId,
        readyDir: input.readyDir,
        dataLakeRoots: [input.dataLakeRoot],
      },
    },
    scripts: [transaction, postcondition],
  };
  const unsignedPromotionInput = {
    version: 1,
    promotionId: "livewire-shepherd-targeted-repair",
    release: { dir: input.releaseDir, commit: input.releaseCommit },
    nodeBinary,
    runtimeFiles,
    runtimeManifest: {
      path: runtimeManifestPath,
      sha256: sha256(runtimeManifestPath),
    },
    pythonBinary: {
      path: input.pythonBin,
      sha256: sha256(input.pythonBin),
    },
    pythonRuntimeFiles,
    pythonRuntimeManifest: {
      path: pythonRuntimeManifestPath,
      sha256: sha256(pythonRuntimeManifestPath),
    },
    opsConfig,
    shepherdConfig,
    bundleFiles,
    registeredProbes: {
      path: registeredProbesPath,
      sha256: sha256(registeredProbesPath),
      probeIds: registeredProbes.probeIds,
    },
    livewireSource: {
      root: input.livewireRoot,
      manifest: {
        path: input.sourceManifest,
        sha256: sourceManifestSha,
      },
      files: livewireSourceFiles,
    },
    componentOwner: {
      componentId: component.id,
      owner: component.mutationOwner.owner,
      competingLabels: component.mutationOwner.competingLabels,
      changeRef: component.mutationOwner.changeRef,
    },
    executor: {
      executorId: transaction.executorId,
      path: transaction.path,
      identity: transaction.identity,
      expectedOwnerUid: transaction.expectedOwnerUid,
      argvSchema: transaction.argvSchema,
    },
    verificationExecutor: {
      executorId: postcondition.executorId,
      path: postcondition.path,
      identity: postcondition.identity,
      expectedOwnerUid: postcondition.expectedOwnerUid,
      argvSchema: postcondition.argvSchema,
    },
    sop: {
      id: sop.id,
      version: sop.version,
      digest: sop.digest,
      authority: sop.authority,
      maxAttempts: sop.maxAttempts,
    },
    automaticAuthority: cap,
    automaticAuthorityDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    rollbackRef: input.rollbackRef,
  };
  const promotionInput = {
    ...unsignedPromotionInput,
    inputSha256: createHash("sha256").update(canonicalJson(unsignedPromotionInput)).digest("hex"),
  };
  const promotionInputPath = join(input.promotionDir, "promotion-input.json");
  writeExclusive(promotionInputPath, promotionInput);

  writeExclusive(input.outputOpsConfig, opsConfig);
  writeExclusive(input.outputShepherdConfig, shepherdConfig);
  return {
    promotionInputPath,
    registeredProbesPath,
    stagedTransaction,
    stagedPostcondition,
    opsConfig,
    shepherdConfig,
  };
}

function assertCleanRelease(releaseDir) {
  const dirty = execFileSync("git", ["-C", releaseDir, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (dirty !== "") throw new Error("release checkout must be clean before promotion packaging");
}

function validateSourceManifestCoverage(livewireRoot, sourceManifest) {
  const declaredRows = readFileSync(sourceManifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
      if (match === null) throw new Error("Livewire source manifest row is invalid");
      const path = match[2];
      if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("/../") ||
          (!path.startsWith("clients/") && !path.startsWith("livewire_scripts/")) ||
          !path.endsWith(".py")) {
        throw new Error(`Livewire source manifest path is unsafe: ${path}`);
      }
      return { path, sha256: match[1] };
    });
  const declared = new Set(declaredRows.map((row) => row.path));
  if (declared.size !== declaredRows.length) throw new Error("Livewire source manifest has duplicate paths");
  const pythonFiles = [];
  for (const entry of readdirSync(livewireRoot, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".py")) {
      throw new Error(`unsafe Python import shadow at Livewire root: ${entry.name}`);
    }
  }
  const visit = (relativeDir) => {
    const absoluteDir = join(livewireRoot, relativeDir);
    const rootStat = lstatSync(absoluteDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Livewire source root is unsafe: ${relativeDir}`);
    }
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const child = join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Livewire Python runtime contains a symlink: ${child}`);
      if (entry.isDirectory() && entry.name === "__pycache__") {
        throw new Error(`Livewire Python runtime contains unsigned bytecode: ${child}`);
      }
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo"))) {
        throw new Error(`Livewire Python runtime contains unsigned bytecode: ${child}`);
      }
      else if (entry.isFile() && entry.name.endsWith(".py")) pythonFiles.push(child);
    }
  };
  for (const root of ["livewire_scripts", "clients"]) visit(root);
  const missing = pythonFiles.sort().filter((path) => !declared.has(path));
  if (missing.length > 0) {
    throw new Error(`Livewire source manifest omits Python runtime files: ${missing.join(", ")}`);
  }
  const extra = declaredRows.map((row) => row.path).filter((path) => !pythonFiles.includes(path));
  if (extra.length > 0) {
    throw new Error(`Livewire source manifest names unknown Python runtime files: ${extra.join(", ")}`);
  }
  for (const row of declaredRows) {
    const path = join(livewireRoot, row.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(path) !== row.sha256) {
      throw new Error(`Livewire source manifest hash differs from runtime: ${row.path}`);
    }
  }
  return declaredRows.sort((left, right) => left.path.localeCompare(right.path));
}

export function discoverPythonRuntimeFiles(pythonBin) {
  const metadata = JSON.parse(execFileSync(pythonBin, [
    "-I", "-B", "-s", "-E", "-c",
    "import json,sys,sysconfig; print(json.dumps({'stdlib':sysconfig.get_path('stdlib'),'purelib':sysconfig.get_path('purelib'),'platlib':sysconfig.get_path('platlib')}))",
  ], { encoding: "utf8", timeout: 30_000 }));
  const paths = [pythonBin, realpathSync(pythonBin)];
  const visitedDirectories = new Set();
  const visit = (directory) => {
    const resolvedDirectory = realpathSync(directory);
    if (visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    const rootStat = lstatSync(resolvedDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`unsafe Python runtime root: ${directory}`);
    }
    for (const entry of readdirSync(resolvedDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(resolvedDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(child);
        const targetStat = lstatSync(target);
        if (targetStat.isDirectory()) visit(target);
        else if (targetStat.isFile()) paths.push(child, target);
        continue;
      }
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) paths.push(child);
    }
  };
  for (const root of [...new Set([metadata.stdlib, metadata.purelib, metadata.platlib])]) visit(root);
  const nativeSeeds = paths.filter((path) =>
    path === pythonBin || path === realpathSync(pythonBin) || /\.(?:so|dylib|bundle)$/.test(path));
  paths.push(...nativeRuntimeFiles(nativeSeeds));
  return [...new Set(paths)].sort().map((path) => {
    if (path.includes("\n") || path.includes("\r")) throw new Error("Python runtime path contains a newline");
    return { path, sha256: sha256(path) };
  });
}

function validate(raw) {
  for (const key of [
    "releaseDir", "livewireRoot", "pythonBin", "nodeBin", "sourceManifest", "readyDir",
    "dataLakeRoot", "installRoot", "promotionDir", "trustedKey", "shepherdStateRoot",
    "outputOpsConfig", "outputShepherdConfig",
  ]) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key])) {
      throw new Error(`${key} must be an absolute path`);
    }
    if (raw[key].includes("'")) throw new Error(`${key} cannot contain an apostrophe`);
  }
  for (const key of ["releaseCommit", "issuedAt", "expiresAt", "rollbackRef"]) {
    if (typeof raw[key] !== "string" || raw[key] === "") throw new Error(`${key} is required`);
  }
  if (Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt)) {
    throw new Error("promotion expiry must be after issue time");
  }
  return raw;
}

function renderWrapper(template, replacements, target) {
  let body = template;
  for (const [key, value] of Object.entries(replacements)) body = body.replaceAll(key, value);
  if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved Livewire wrapper placeholder");
  writeFileSync(target, body, { mode: 0o500, flag: "wx" });
  chmodSync(target, 0o500);
}

function writeExclusive(path, value) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
  } finally {
    closeSync(fd);
  }
}

function writeTextExclusive(path, value, mode) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    writeFileSync(fd, value, { encoding: "utf8", flush: true });
  } finally {
    closeSync(fd);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || value === undefined) throw new Error(`invalid promotion argument: ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (values[key] !== undefined) throw new Error(`duplicate promotion argument: ${flag}`);
    values[key] = value;
  }
  if (Object.keys(values).length !== FLAGS.size) throw new Error("all Livewire promotion flags are required");
  return values;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = prepareLivewireShepherdPromotion(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "promotion preparation failed"}\n`);
    process.exitCode = 1;
  }
}
