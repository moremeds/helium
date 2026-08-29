import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalJson } from "../../packages/core/lib/event-store.js";
import { runManifestSigner } from "./sign-authority-manifest.mjs";

const dir = mkdtempSync(join(tmpdir(), "helium-sign-manifest-"));
after(() => rmSync(dir, { recursive: true, force: true }));

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

test("signs exact SOP id/version/digest/authority entries with Ed25519", async () => {
  const { createHash } = await import("node:crypto");
  const raw = sop();
  raw.digest = `sha256:${createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")))).digest("hex")}`;
  const sops = join(dir, "sops");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sops);
  writeFileSync(join(sops, "fixture.json"), JSON.stringify(raw));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = join(dir, "operator.pem");
  const output = join(dir, "manifest.json");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  process.env.HELIUM_OPS_SIGNING_ALLOWED = "1";
  try {
    await runManifestSigner(["--sops-dir", sops, "--private-key", key, "--output", output]);
  } finally {
    delete process.env.HELIUM_OPS_SIGNING_ALLOWED;
  }
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(manifest.entries, [
    { sopId: raw.id, version: 1, digest: raw.digest, authority: "approve" },
  ]);
  assert.equal(
    verify(null, Buffer.from(canonicalJson(manifest.entries)), publicKey, Buffer.from(manifest.signature, "base64")),
    true,
  );
});

test("refuses the mini role, an exposed key, and a stale declared digest", async () => {
  const { createHash } = await import("node:crypto");
  const raw = sop();
  raw.digest = `sha256:${createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest")))).digest("hex")}`;
  const sops = join(dir, "refusal-sops");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sops);
  const sopPath = join(sops, "fixture.json");
  writeFileSync(sopPath, JSON.stringify(raw));
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = join(dir, "refusal.pem");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const args = ["--sops-dir", sops, "--private-key", key, "--output", join(dir, "refused.json")];

  process.env.HELIUM_OPS_SIGNING_ALLOWED = "1";
  process.env.HELIUM_HOST_ROLE = "mini";
  await assert.rejects(runManifestSigner(args), /refuses to run on the mini/);
  delete process.env.HELIUM_HOST_ROLE;

  chmodSync(key, 0o644);
  await assert.rejects(runManifestSigner(args), /group- or world-accessible/);
  chmodSync(key, 0o600);

  writeFileSync(sopPath, JSON.stringify({ ...raw, priority: raw.priority + 1 }));
  await assert.rejects(runManifestSigner(args), /digest does not match/);
  delete process.env.HELIUM_OPS_SIGNING_ALLOWED;
});
