import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import { runManifestSigner } from "./sign-authority-manifest.mjs";
import { hardwareIdentityHash } from "./signing-host-policy.mjs";

const dir = mkdtempSync(join(tmpdir(), "helium-sign-manifest-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const operatorIdentity = "fixture-operator-hardware";
const miniIdentity = "fixture-mini-hardware";
const signingHost = {
  hardwareIdentity: operatorIdentity,
  policy: {
    version: 1,
    allowedOperatorHostHashes: [hardwareIdentityHash(operatorIdentity)],
    forbiddenMiniHostHashes: [hardwareIdentityHash(miniIdentity)],
  },
};

function sop(authority = "approve") {
  const unsigned = {
    version: 1,
    id: "fixture-repair",
    componentId: "fixture",
    matches: { dimension: "integrity", failureClass: "failed" },
    authority,
    mutating: true,
    priority: 1,
    action: {
      executorId: "fixture",
      executable: { path: "/fixture", identity: { kind: "sha256", value: "b".repeat(64) } },
      argvSchemaId: "fixture-argv",
      cwdId: "fixture-cwd",
      environmentProfileId: "fixture-env",
      timeoutMs: 1_000,
    },
    preconditions: [],
    postconditions: ["fixture-check"],
    graceMs: 0,
    maxAttempts: 1,
    cooldownMs: 1_000,
  };
  return { ...unsigned, digest: `sha256:${"0".repeat(64)}` };
}

function certificationFixture(root, raw, executable) {
  const components = join(root, "components");
  const checks = join(root, "checks");
  const executors = join(root, "executors");
  for (const path of [components, checks, executors]) mkdirSync(path);
  const hash = createHash("sha256").update(readFileSync(executable)).digest("hex");
  raw.action.executable.path = executable;
  raw.action.executable.identity.value = hash;
  writeFileSync(join(components, "fixture.json"), JSON.stringify({
    version: 1,
    id: "fixture",
    kind: "fixture",
    dimensions: ["integrity"],
    mutationOwner: {
      owner: "opsd",
      competingLabels: [],
      changedAt: "2026-08-30T00:00:00.000Z",
      changeRef: "fixture",
    },
  }));
  writeFileSync(join(checks, "fixture.json"), JSON.stringify({
    id: "fixture-check",
    kind: "business",
    probe: { probeId: "fixture.v1", args: {} },
    expect: { dimension: "integrity", operator: "eq", value: true },
    onUnavailable: "unknown",
    timeoutMs: 1_000,
    owner: "fixture",
  }));
  writeFileSync(join(executors, "fixture.json"), JSON.stringify({
    executorId: "fixture",
    path: executable,
    identity: { kind: "sha256", value: hash },
    argvSchema: { id: "fixture-argv", params: [] },
    cwd: root,
    environmentProfile: {},
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    expectedOwnerUid: process.getuid?.() ?? 0,
  }));
  const registeredProbes = join(root, "registered-probes.json");
  writeFileSync(registeredProbes, JSON.stringify({ version: 1, probeIds: ["fixture.v1"] }));
  return { components, checks, executors, registeredProbes };
}

test("signs exact certified SOP id/version/digest/authority entries with Ed25519", async () => {
  const raw = sop();
  const executable = join(dir, "fixture-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const fixture = certificationFixture(dir, raw, executable);
  raw.digest = `sha256:${createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")))).digest("hex")}`;
  const sops = join(dir, "sops");
  mkdirSync(sops);
  writeFileSync(join(sops, "fixture.json"), JSON.stringify(raw));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = join(dir, "operator.pem");
  const output = join(dir, "manifest.json");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await runManifestSigner([
    "--sops-dir", sops,
    "--components-dir", fixture.components,
    "--checks-dir", fixture.checks,
    "--executors-dir", fixture.executors,
    "--registered-probes", fixture.registeredProbes,
    "--private-key", key,
    "--output", output,
  ], { signingHost });
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(manifest.entries, [
    { sopId: raw.id, version: 1, digest: raw.digest, authority: "approve" },
  ]);
  assert.equal(
    verify(null, Buffer.from(canonicalJson(manifest.entries)), publicKey, Buffer.from(manifest.signature, "base64")),
    true,
  );
});

test("refuses a registered mini, an exposed key, and a stale declared digest", async () => {
  const raw = sop();
  const executable = join(dir, "refusal-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const root = join(dir, "refusal-fixture");
  mkdirSync(root);
  const fixture = certificationFixture(root, raw, executable);
  raw.digest = `sha256:${createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")))).digest("hex")}`;
  const sops = join(dir, "refusal-sops");
  mkdirSync(sops);
  const sopPath = join(sops, "fixture.json");
  writeFileSync(sopPath, JSON.stringify(raw));
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = join(dir, "refusal.pem");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const args = [
    "--sops-dir", sops,
    "--components-dir", fixture.components,
    "--checks-dir", fixture.checks,
    "--executors-dir", fixture.executors,
    "--registered-probes", fixture.registeredProbes,
    "--private-key", key,
    "--output", join(dir, "refused.json"),
  ];

  await assert.rejects(
    runManifestSigner(args, { signingHost: { ...signingHost, hardwareIdentity: miniIdentity } }),
    /registered mini/,
  );

  chmodSync(key, 0o644);
  await assert.rejects(runManifestSigner(args, { signingHost }), /group- or world-accessible/);
  chmodSync(key, 0o600);

  writeFileSync(sopPath, JSON.stringify({ ...raw, priority: raw.priority + 1 }));
  await assert.rejects(runManifestSigner(args, { signingHost }), /digest does not match/);
});

test("refuses a structurally uncertified SOP before signing", async () => {
  const root = join(dir, "uncertified-fixture");
  mkdirSync(root);
  const executable = join(root, "fixture-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const raw = sop();
  const fixture = certificationFixture(root, raw, executable);
  const componentPath = join(fixture.components, "fixture.json");
  const component = JSON.parse(readFileSync(componentPath, "utf8"));
  component.mutationOwner.owner = "external";
  component.mutationOwner.externalOwnerLabel = "legacy-watchdog";
  writeFileSync(componentPath, JSON.stringify(component));
  raw.digest = `sha256:${createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")))).digest("hex")}`;
  const sops = join(root, "sops");
  mkdirSync(sops);
  writeFileSync(join(sops, "fixture.json"), JSON.stringify(raw));
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = join(root, "operator.pem");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await assert.rejects(
    runManifestSigner([
      "--sops-dir", sops,
      "--components-dir", fixture.components,
      "--checks-dir", fixture.checks,
      "--executors-dir", fixture.executors,
      "--registered-probes", fixture.registeredProbes,
      "--private-key", key,
      "--output", join(root, "manifest.json"),
    ], { signingHost }),
    /mutation-owner-not-opsd:external/,
  );
});

test("refuses unresolved executable ownership, release assertions, and unregistered probes", async () => {
  const root = join(dir, "identity-probe-refusals");
  mkdirSync(root);
  const executable = join(root, "fixture-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const raw = sop();
  const fixture = certificationFixture(root, raw, executable);
  const sops = join(root, "sops");
  mkdirSync(sops);
  const sopPath = join(sops, "fixture.json");
  const refreshSop = () => {
    raw.digest = `sha256:${createHash("sha256").update(canonicalJson(
      Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")),
    )).digest("hex")}`;
    writeFileSync(sopPath, JSON.stringify(raw));
  };
  refreshSop();
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = join(root, "operator.pem");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const args = [
    "--sops-dir", sops,
    "--components-dir", fixture.components,
    "--checks-dir", fixture.checks,
    "--executors-dir", fixture.executors,
    "--registered-probes", fixture.registeredProbes,
    "--private-key", key,
    "--output", join(root, "manifest.json"),
  ];
  const executorPath = join(fixture.executors, "fixture.json");
  const executor = JSON.parse(readFileSync(executorPath, "utf8"));

  const { expectedOwnerUid: _owner, ...ownerless } = executor;
  writeFileSync(executorPath, JSON.stringify(ownerless));
  await assert.rejects(runManifestSigner(args, { signingHost }), /expectedOwnerUid/);

  executor.identity = { kind: "release", value: "release-42" };
  writeFileSync(executorPath, JSON.stringify(executor));
  raw.action.executable.identity = { ...executor.identity };
  refreshSop();
  await assert.rejects(runManifestSigner(args, { signingHost }), /release-identity-unverifiable/);

  executor.identity = {
    kind: "sha256",
    value: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
  writeFileSync(executorPath, JSON.stringify(executor));
  raw.action.executable.identity = { ...executor.identity };
  refreshSop();
  writeFileSync(fixture.registeredProbes, JSON.stringify({ version: 1, probeIds: [] }));
  await assert.rejects(runManifestSigner(args, { signingHost }), /unregistered probe/);
});
