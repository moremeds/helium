#!/usr/bin/env node
/** Sign exact above-observe SOP grants on an operator workstation. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, closeSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
import { ScriptRegistry } from "../../plugins/ops-agent/lib/index.js";
import { assertTrustedSigningHost } from "./signing-host-policy.mjs";

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
]);
const requiredFlags = new Set([...flags].filter((flag) => flag !== "--promotion-input"));

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
  return {
    sopsDir: values.get("--sops-dir"),
    componentsDir: values.get("--components-dir"),
    checksDir: values.get("--checks-dir"),
    executorsDir: values.get("--executors-dir"),
    registeredProbes: values.get("--registered-probes"),
    privateKey: values.get("--private-key"),
    output: values.get("--output"),
    promotionInput: values.get("--promotion-input"),
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

function assertCertifiable(sop, components, checks, scripts) {
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
  const identity = scripts.verifyIdentity(script);
  if (!identity.ok) {
    throw new Error(`SOP ${sop.id} executor identity is not certified: ${identity.reason}`);
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

  const entries = readdirSync(parsed.sopsDir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => SopDefinitionSchema.parse(loadSop(join(parsed.sopsDir, name))))
    .filter((sop) => sop.authority === "approve" || sop.authority === "auto")
    .map((sop) => {
      assertCertifiable(sop, components, checks, scripts);
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
        componentValues,
        parsedChecks,
        scripts,
        testOptions?.resolveReleaseCommit,
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
  componentValues,
  parsedChecks,
  scripts,
  resolveReleaseCommit,
) {
  const { inputSha256, ...unsigned } = value;
  const actualInputHash = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  if (inputSha256 !== actualInputHash) throw new Error("promotion input hash mismatch");
  const actualCommit = resolveReleaseCommit === undefined
    ? execFileSync("git", ["-C", value.release?.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : resolveReleaseCommit(value.release?.dir);
  if (actualCommit !== value.release?.commit) throw new Error("promotion release differs from signing checkout");
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
  return { promotionId: value.promotionId, inputSha256 };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runManifestSigner(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "manifest signing failed"}\n`);
    process.exitCode = 1;
  });
}
