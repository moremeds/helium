#!/usr/bin/env node
/** Sign exact above-observe SOP grants on an operator workstation. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { constants, closeSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { canonicalJson } from "../../packages/core/lib/event-store.js";

const requireFromOpsPlugin = createRequire(
  new URL("../../plugins/ops-agent/package.json", import.meta.url),
);
const { parse } = requireFromOpsPlugin("yaml");

const flags = new Set(["--sops-dir", "--private-key", "--output"]);

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
    privateKey: values.get("--private-key"),
    output: values.get("--output"),
  };
}

function loadSop(path) {
  const text = readFileSync(path, "utf8");
  const value = extname(path) === ".json" ? JSON.parse(text) : parse(text, { strict: true, uniqueKeys: true });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: SOP must be an object`);
  }
  for (const key of ["id", "version", "digest", "authority"]) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path}: SOP is missing ${key}`);
  }
  const { digest, ...unsigned } = value;
  const actual = `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
  if (digest !== actual) throw new Error(`${path}: declared digest does not match SOP content`);
  return value;
}

export async function runManifestSigner(argv) {
  if (process.env.HELIUM_HOST_ROLE === "mini") {
    throw new Error("authority manifest signer refuses to run on the mini");
  }
  if (process.env.HELIUM_OPS_SIGNING_ALLOWED !== "1") {
    throw new Error("set HELIUM_OPS_SIGNING_ALLOWED=1 only on the trusted operator workstation");
  }
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
  const entries = readdirSync(parsed.sopsDir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => loadSop(join(parsed.sopsDir, name)))
    .filter((sop) => sop.authority === "approve" || sop.authority === "auto")
    .map((sop) => ({
      sopId: sop.id,
      version: sop.version,
      digest: sop.digest,
      authority: sop.authority,
    }));
  const manifest = {
    entries,
    signature: sign(null, Buffer.from(canonicalJson(entries)), privateKey).toString("base64"),
  };

  let fd;
  try {
    fd = openSync(parsed.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
