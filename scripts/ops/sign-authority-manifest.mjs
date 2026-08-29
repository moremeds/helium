#!/usr/bin/env node
/** Sign exact above-observe SOP grants on an operator workstation. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { constants, closeSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  CheckDefinitionSchema,
  CheckRegistry,
  ComponentSpecSchema,
  SopDefinitionSchema,
  canonicalJson,
  certifySop,
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
  for (const flag of flags) {
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
  const manifest = {
    entries,
    signature: sign(null, Buffer.from(canonicalJson(entries)), privateKey).toString("base64"),
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runManifestSigner(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "manifest signing failed"}\n`);
    process.exitCode = 1;
  });
}
