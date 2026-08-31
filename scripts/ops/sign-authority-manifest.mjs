#!/usr/bin/env node
/** Sign exact above-observe SOP grants on an operator workstation. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, closeSync, lstatSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  CheckDefinitionSchema,
  CheckRegistry,
  ComponentSpecSchema,
  SopDefinitionSchema,
  canonicalJson,
  certifySop,
  manifestSigningPayload,
} from "../../packages/core/lib/index.js";
import {
  ScriptRegistry,
  automaticAuthorityInputDigest,
  livewireRuntimeFiles,
} from "../../plugins/ops-agent/lib/index.js";
import { assertTrustedSigningHost } from "./signing-host-policy.mjs";
import { discoverPythonRuntimeFiles } from "./prepare-livewire-shepherd-promotion.mjs";
import { verifyLivewirePromotionEvidence } from "./livewire-promotion-evidence.mjs";

const requireFromOpsPlugin = createRequire(
  new URL("../../plugins/ops-agent/package.json", import.meta.url),
);
const { parse } = requireFromOpsPlugin("yaml");

const flags = new Set([
  "--sops-dir",
  "--components-dir",
  "--checks-dir",
  "--executors-dir",
  "--registered-probes",
  "--private-key",
  "--output",
  "--promotion-input",
  "--release-checkout",
  "--executor-source",
  "--verification-executor-source",
  "--offline-evidence",
]);
const requiredFlags = new Set([
  "--sops-dir",
  "--components-dir",
  "--checks-dir",
  "--executors-dir",
  "--registered-probes",
  "--private-key",
  "--output",
]);

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flags.has(flag)) throw new Error(`unknown manifest signer flag: ${flag ?? "<missing>"}`);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`duplicate manifest signer flag: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of requiredFlags) {
    if (!values.has(flag)) throw new Error(`sign-authority-manifest requires ${flag}`);
  }
  const promotionFlags = ["--promotion-input", "--release-checkout", "--executor-source"];
  const promotionCount = promotionFlags.filter((flag) => values.has(flag)).length;
  if (promotionCount !== 0 && promotionCount !== promotionFlags.length) {
    throw new Error("promotion signing requires --promotion-input, --release-checkout, and --executor-source together");
  }
  if (values.has("--offline-evidence") && promotionCount !== promotionFlags.length) {
    throw new Error("offline promotion evidence requires promotion signing inputs");
  }
  return {
    sopsDir: values.get("--sops-dir"),
    componentsDir: values.get("--components-dir"),
    checksDir: values.get("--checks-dir"),
    executorsDir: values.get("--executors-dir"),
    registeredProbes: values.get("--registered-probes"),
    privateKey: values.get("--private-key"),
    output: values.get("--output"),
    promotionInput: values.get("--promotion-input"),
    releaseCheckout: values.get("--release-checkout"),
    executorSource: values.get("--executor-source"),
    verificationExecutorSource: values.get("--verification-executor-source"),
    offlineEvidence: values.get("--offline-evidence"),
  };
}

function loadRegisteredProbeIds(path) {
  const value = loadDocument(path);
  if (value.version !== 1 || !Array.isArray(value.probeIds) ||
      value.probeIds.some((id) => typeof id !== "string" || id === "")) {
    throw new Error(`${path}: registered probe inventory must be version 1 with probeIds`);
  }
  const ids = [...new Set(value.probeIds)];
  if (ids.length !== value.probeIds.length) {
    throw new Error(`${path}: duplicate registered probe id`);
  }
  return ids.sort();
}

function loadDocument(path) {
  const text = readFileSync(path, "utf8");
  const value = extname(path) === ".json"
    ? JSON.parse(text)
    : parse(text, { strict: true, uniqueKeys: true });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: document must be an object`);
  }
  return value;
}

function loadDirectory(path) {
  return readdirSync(path)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => loadDocument(join(path, name)));
}

function loadSop(path) {
  const value = loadDocument(path);
  for (const key of ["id", "version", "digest", "authority"]) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path}: SOP is missing ${key}`);
  }
  const { digest, ...unsigned } = value;
  const actual = `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
  if (digest !== actual) throw new Error(`${path}: declared digest does not match SOP content`);
  return value;
}

function assertCertifiable(sop, components, checks, scripts, executorSource = undefined) {
  const component = components.get(sop.componentId);
  if (component === undefined) {
    throw new Error(`SOP ${sop.id} names unknown component: ${sop.componentId}`);
  }
  const certification = certifySop(sop, checks, component);
  if (!certification.certified) {
    throw new Error(`SOP ${sop.id} is not certifiable: ${certification.reasons.join(", ")}`);
  }

  const script = scripts.get(sop.action.executorId);
  if (script === undefined) {
    throw new Error(`SOP ${sop.id} names unknown executor: ${sop.action.executorId}`);
  }
  if (script.path !== sop.action.executable.path ||
      script.identity.kind !== sop.action.executable.identity?.kind ||
      script.identity.value !== sop.action.executable.identity?.value ||
      script.argvSchema.id !== sop.action.argvSchemaId ||
      script.timeoutMs < sop.action.timeoutMs) {
    throw new Error(`SOP ${sop.id} action does not match its registered executor`);
  }
  if (executorSource === undefined) {
    const identity = scripts.verifyIdentity(script);
    if (!identity.ok) {
      throw new Error(`SOP ${sop.id} executor identity is not certified: ${identity.reason}`);
    }
  } else {
    const sourceStat = lstatSync(executorSource);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`SOP ${sop.id} executor source must be a regular non-symlink file`);
    }
    if ((sourceStat.mode & 0o022) !== 0) {
      throw new Error(`SOP ${sop.id} executor source is group- or world-writable`);
    }
    const sourceHash = createHash("sha256").update(readFileSync(executorSource)).digest("hex");
    if (script.identity.kind !== "sha256" || script.identity.value !== sourceHash) {
      throw new Error(`SOP ${sop.id} executor source differs from production identity`);
    }
  }
}

export async function runManifestSigner(argv, testOptions = undefined) {
  assertTrustedSigningHost(testOptions?.signingHost);
  const parsed = parseArgs(argv);
  const keyStat = statSync(parsed.privateKey);
  if (!keyStat.isFile()) throw new Error("authority private key is not a file");
  if ((keyStat.mode & 0o077) !== 0) {
    throw new Error("authority private key must not be group- or world-accessible");
  }
  const privateKey = createPrivateKey(readFileSync(parsed.privateKey));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("authority private key must be Ed25519");
  }
  const componentValues = loadDirectory(parsed.componentsDir);
  const components = new Map(
    componentValues.map((value) => {
      const component = ComponentSpecSchema.parse(value);
      return [component.id, component];
    }),
  );
  if (components.size !== componentValues.length) {
    throw new Error("duplicate component id in signing input");
  }
  const checkValues = loadDirectory(parsed.checksDir);
  const parsedChecks = checkValues.map((value) => CheckDefinitionSchema.parse(value));
  // The inventory is exported from the host's actual probe registry. Never
  // derive it from the submitted checks: doing so would let every declared
  // postcondition certify itself without a runnable implementation.
  const checks = CheckRegistry.load(parsedChecks, loadRegisteredProbeIds(parsed.registeredProbes));
  const scripts = ScriptRegistry.load(loadDirectory(parsed.executorsDir));

  const grantedSops = readdirSync(parsed.sopsDir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => SopDefinitionSchema.parse(loadSop(join(parsed.sopsDir, name))))
    .filter((sop) => sop.authority === "approve" || sop.authority === "auto");
  const entries = grantedSops
    .map((sop) => {
      assertCertifiable(sop, components, checks, scripts, parsed.executorSource);
      return {
        sopId: sop.id,
        version: sop.version,
        digest: sop.digest,
        authority: sop.authority,
      };
    });
  const promotion = parsed.promotionInput === undefined
    ? undefined
    : validatePromotionInput(
        loadDocument(parsed.promotionInput),
        parsed,
        entries,
        grantedSops,
        componentValues,
        parsedChecks,
        scripts,
        testOptions?.resolveReleaseCommit,
        testOptions?.assertReleaseClean,
        testOptions?.resolveRuntimeFiles,
        testOptions?.resolvePythonRuntimeFiles,
      );
  const manifest = {
    entries,
    ...(promotion === undefined ? {} : { promotion }),
    signature: sign(null, manifestSigningPayload(entries, promotion), privateKey).toString("base64"),
  };

  let fd;
  try {
    fd = openSync(parsed.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flush: true,
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to overwrite authority manifest: ${parsed.output}`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return manifest;
}

function validatePromotionInput(
  value,
  parsed,
  entries,
  grantedSops,
  componentValues,
  parsedChecks,
  scripts,
  resolveReleaseCommit,
  assertReleaseClean,
  resolveRuntimeFiles,
  resolvePythonRuntimeFiles,
) {
  const { inputSha256, ...unsigned } = value;
  if (typeof inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(inputSha256)) {
    throw new Error("promotion input hash is invalid");
  }
  const actualFullInputHash = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  if (inputSha256 !== actualFullInputHash) throw new Error("promotion input hash mismatch");
  const actualCommit = resolveReleaseCommit === undefined
    ? execFileSync("git", ["-C", parsed.releaseCheckout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : resolveReleaseCommit(parsed.releaseCheckout);
  if (actualCommit !== value.release?.commit) throw new Error("promotion release differs from signing checkout");
  (assertReleaseClean ?? assertCleanRelease)(parsed.releaseCheckout);
  const offlineEvidence = parsed.offlineEvidence === undefined
    ? undefined
    : verifyLivewirePromotionEvidence({
        promotionInputPath: parsed.promotionInput,
        evidenceDir: parsed.offlineEvidence,
        releaseCheckout: parsed.releaseCheckout,
        ...(resolveReleaseCommit === undefined ? {} : { resolveReleaseCommit }),
        ...(assertReleaseClean === undefined ? {} : { assertReleaseClean }),
      });
  const offlineBytes = (productionPath) => {
    if (offlineEvidence === undefined) return undefined;
    const entry = offlineEvidence.entries.find((candidate) => candidate.productionPath === productionPath);
    if (entry === undefined) throw new Error(`offline promotion evidence omits ${productionPath}`);
    return readFileSync(join(parsed.offlineEvidence, "blobs", entry.sha256));
  };
  if (value.promotionId === "livewire-shepherd-targeted-repair" &&
      (typeof value.nodeBinary?.path !== "string" ||
       typeof value.nodeBinary?.sha256 !== "string" ||
       typeof value.runtimeManifest?.path !== "string" ||
       typeof value.runtimeManifest?.sha256 !== "string")) {
    throw new Error("Livewire promotion is missing its signed Node runtime closure");
  }
  const actualRuntimeFiles = offlineEvidence === undefined
    ? (resolveRuntimeFiles ?? livewireRuntimeFiles)(parsed.releaseCheckout, value.nodeBinary?.path)
    : value.runtimeFiles;
  if (JSON.stringify(value.runtimeFiles) !== JSON.stringify(actualRuntimeFiles)) {
    throw new Error("promotion runtime bytes differ from signing checkout");
  }
  if (value.runtimeManifest !== undefined) {
    const runtimeManifestBytes = `${actualRuntimeFiles
      .map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
    const actualManifestBytes = offlineBytes(value.runtimeManifest.path) ?? readFileSync(value.runtimeManifest.path);
    const nodeBytes = offlineBytes(value.nodeBinary.path) ?? readFileSync(value.nodeBinary.path);
    if (value.nodeBinary.sha256 !== createHash("sha256").update(nodeBytes).digest("hex") ||
        value.runtimeManifest.sha256 !== createHash("sha256").update(actualManifestBytes).digest("hex") ||
        !actualManifestBytes.equals(Buffer.from(runtimeManifestBytes))) {
      throw new Error("promotion Node runtime manifest differs from signing input");
    }
  }
  if (value.promotionId === "livewire-shepherd-targeted-repair") {
    if (typeof value.pythonBinary?.path !== "string" || typeof value.pythonBinary?.sha256 !== "string" ||
        typeof value.pythonRuntimeManifest?.path !== "string" ||
        typeof value.pythonRuntimeManifest?.sha256 !== "string" ||
        !Array.isArray(value.pythonRuntimeFiles)) {
      throw new Error("Livewire promotion is missing its signed Python runtime closure");
    }
    const actualPythonRuntimeFiles = offlineEvidence === undefined
      ? (resolvePythonRuntimeFiles ?? discoverPythonRuntimeFiles)(value.pythonBinary.path)
      : value.pythonRuntimeFiles;
    const expectedPythonManifest = `${actualPythonRuntimeFiles
      .map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
    const actualPythonManifest = offlineBytes(value.pythonRuntimeManifest.path) ??
      readFileSync(value.pythonRuntimeManifest.path);
    const pythonBytes = offlineBytes(value.pythonBinary.path) ?? readFileSync(value.pythonBinary.path);
    if (JSON.stringify(value.pythonRuntimeFiles) !== JSON.stringify(actualPythonRuntimeFiles) ||
        value.pythonBinary.sha256 !== createHash("sha256").update(pythonBytes).digest("hex") ||
        value.pythonRuntimeManifest.sha256 !== createHash("sha256").update(actualPythonManifest).digest("hex") ||
        !actualPythonManifest.equals(Buffer.from(expectedPythonManifest))) {
      throw new Error("promotion Python runtime manifest differs from signing input");
    }
  }
  const registeredBytes = readFileSync(parsed.registeredProbes);
  if (value.registeredProbes?.sha256 !== createHash("sha256").update(registeredBytes).digest("hex") ||
      JSON.stringify(value.registeredProbes?.probeIds) !==
        JSON.stringify(loadRegisteredProbeIds(parsed.registeredProbes))) {
    throw new Error("promotion registered probes differ from signing input");
  }
  if (componentValues.length !== 1 || value.componentOwner?.componentId !== componentValues[0].id ||
      value.componentOwner?.owner !== componentValues[0].mutationOwner?.owner ||
      value.componentOwner?.owner !== "opsd") {
    throw new Error("promotion owner differs from signing input");
  }
  if (entries.length !== 1 || value.sop?.id !== entries[0].sopId ||
      value.sop?.version !== entries[0].version || value.sop?.digest !== entries[0].digest ||
      value.sop?.authority !== entries[0].authority || value.sop?.maxAttempts !== 1) {
    throw new Error("promotion SOP differs from signing input");
  }
  const script = scripts.get(value.executor?.executorId);
  if (script === undefined || script.path !== value.executor.path ||
      script.identity.kind !== value.executor.identity?.kind ||
      script.identity.value !== value.executor.identity?.value ||
      script.expectedOwnerUid !== value.executor.expectedOwnerUid ||
      JSON.stringify(script.argvSchema) !== JSON.stringify(value.executor.argvSchema)) {
    throw new Error("promotion executor differs from signing input");
  }
  const promotionRoot = dirname(parsed.componentsDir);
  const actualBundleFiles = [
    ["components", parsed.componentsDir],
    ["checks", parsed.checksDir],
    ["executors", parsed.executorsDir],
    ["sops", parsed.sopsDir],
  ].flatMap(([section, dir]) => readdirSync(dir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return {
        path: relative(promotionRoot, path),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    }));
  if (JSON.stringify(value.bundleFiles) !== JSON.stringify(actualBundleFiles)) {
    throw new Error("promotion bundle hashes differ from signing input");
  }
  // Check definitions were parsed and registered above; retaining the read
  // prevents a future refactor from validating only the hash list.
  if (parsedChecks.length === 0) throw new Error("promotion has no checks");
  const grantedSop = grantedSops[0];
  if (grantedSop?.authority === "auto") {
    if (value.automaticAuthority === undefined) {
      throw new Error("automatic promotion is missing its exact authority cap");
    }
    const checksById = new Map(parsedChecks.map((check) => [check.id, check]));
    const signedChecks = [...grantedSop.preconditions, ...grantedSop.postconditions]
      .map((id) => checksById.get(id));
    if (signedChecks.some((check) => check === undefined)) {
      throw new Error("automatic promotion check set is incomplete");
    }
    const verifier = scripts.get(value.verificationExecutor?.executorId);
    if (verifier === undefined || value.automaticAuthority?.kind !== "manifest-argv-v1" ||
        JSON.stringify(value.automaticAuthority.verificationExecutor) !==
          JSON.stringify(value.verificationExecutor) ||
        verifier.path !== value.verificationExecutor.path ||
        JSON.stringify(verifier.identity) !== JSON.stringify(value.verificationExecutor.identity) ||
        verifier.expectedOwnerUid !== value.verificationExecutor.expectedOwnerUid ||
        JSON.stringify(verifier.argvSchema) !== JSON.stringify(value.verificationExecutor.argvSchema) ||
        verifier.executorId === script.executorId) {
      throw new Error("automatic postcondition executor differs from signing input");
    }
    if (parsed.verificationExecutorSource === undefined) {
      throw new Error("automatic promotion requires --verification-executor-source");
    }
    const verifierSourceStat = lstatSync(parsed.verificationExecutorSource);
    const verifierSourceHash = createHash("sha256")
      .update(readFileSync(parsed.verificationExecutorSource)).digest("hex");
    if (!verifierSourceStat.isFile() || verifierSourceStat.isSymbolicLink() ||
        (verifierSourceStat.mode & 0o022) !== 0 || verifier.identity.kind !== "sha256" ||
        verifier.identity.value !== verifierSourceHash) {
      throw new Error("automatic postcondition executor source is not certified");
    }
    const actualAuthorityDigest = automaticAuthorityInputDigest({
      cap: value.automaticAuthority,
      component: componentValues[0],
      sop: grantedSop,
      checks: signedChecks,
      executor: script,
      verificationExecutor: verifier,
    });
    if (value.automaticAuthorityDigest !== actualAuthorityDigest) {
      throw new Error("automatic authority digest mismatch");
    }
  }
  return { promotionId: value.promotionId, inputSha256 };
}

function assertCleanRelease(releaseDir) {
  const dirty = execFileSync("git", ["-C", releaseDir, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (dirty !== "") throw new Error("release checkout must be clean before signing");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runManifestSigner(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "manifest signing failed"}\n`);
    process.exitCode = 1;
  });
}
