import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSuggestConfig } from "./configure-suggest-only.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-suggest-config-"));
  const release = join(root, "release");
  const config = join(root, "ops", "config", "opsd.json");
  const authorityManifest = join(root, "signed", "authority-manifest.json");
  const trustedKey = join(root, "signed", "authority.pub.pem");
  mkdirSync(join(release, "plugins", "ops-agent", "lib", "bin"), { recursive: true });
  mkdirSync(join(release, "ops", "promotions", "trading-stack-reconcile"), { recursive: true });
  mkdirSync(join(root, "ops", "config"), { recursive: true });
  mkdirSync(join(root, "signed"), { recursive: true });
  writeFileSync(join(release, "plugins", "ops-agent", "lib", "bin", "opsd.js"), "fixture\n");
  writeFileSync(authorityManifest, "{}\n", { mode: 0o600 });
  writeFileSync(trustedKey, "fixture-key\n", { mode: 0o600 });
  const original = {
    version: 1,
    mode: "observe",
    releaseDir: release,
    componentsDir: "ops/components",
    dependenciesDir: "ops/dependencies",
    checksDir: "ops/checks",
    sopsDir: "ops/sops",
    executorsDir: "ops/executors",
    authorityManifestPath: join(release, "ops", "authority-manifest.json"),
    trustedKeyPath: join(release, "ops", "authority-manifest.pub.pem"),
    stateDir: join(root, "ops", "state"),
    socketPath: join(root, "ops", "run", "opsd.sock"),
    intervalMs: 60_000,
    maxFiles: 500,
    maxComponents: 200,
    maxSops: 200,
    maxChecks: 500,
    maxFileBytes: 1_000_000,
  };
  writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  const input = { config, release, authorityManifest, trustedKey };
  const validated = [];
  const deps = {
    isLoaded: () => false,
    validateCandidate: (path) => validated.push(JSON.parse(readFileSync(path, "utf8"))),
  };
  return { root, original, input, deps, validated };
}

test("preflight validates the signed suggest candidate without changing active config", () => {
  const f = fixture();
  try {
    const result = runSuggestConfig("preflight", f.input, f.deps);
    assert.equal(result.mode, "suggest");
    assert.deepEqual(JSON.parse(readFileSync(f.input.config, "utf8")), f.original);
    assert.equal(f.validated.length, 1);
    assert.equal(f.validated[0].mode, "suggest");
    assert.equal(
      f.validated[0].promotionBundleDir,
      join(f.input.release, "ops", "promotions", "trading-stack-reconcile"),
    );
    assert.equal(f.validated[0].authorityManifestPath, f.input.authorityManifest);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply and restore round-trip the exact observe config", () => {
  const f = fixture();
  try {
    runSuggestConfig("apply", f.input, f.deps);
    const active = JSON.parse(readFileSync(f.input.config, "utf8"));
    assert.equal(active.mode, "suggest");
    assert.equal(active.componentsDir, "components");
    assert.equal(active.executorsDir, "executors");
    assert.throws(() => runSuggestConfig("apply", f.input, f.deps), /already exists|requires observe/);

    const restored = runSuggestConfig("restore", f.input, f.deps);
    assert.equal(restored.mode, "observe");
    assert.deepEqual(JSON.parse(readFileSync(f.input.config, "utf8")), f.original);
    assert.equal(f.validated.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("refuses a loaded daemon and a tampered backup", () => {
  const loaded = fixture();
  try {
    assert.throws(
      () => runSuggestConfig("apply", loaded.input, { ...loaded.deps, isLoaded: () => true }),
      /must be unloaded/,
    );
  } finally {
    rmSync(loaded.root, { recursive: true, force: true });
  }

  const tampered = fixture();
  try {
    runSuggestConfig("apply", tampered.input, tampered.deps);
    writeFileSync(`${tampered.input.config}.pre-p4-suggest`, "{}\n");
    assert.throws(
      () => runSuggestConfig("restore", tampered.input, tampered.deps),
      /backup hash mismatch/,
    );
    assert.equal(JSON.parse(readFileSync(tampered.input.config, "utf8")).mode, "suggest");
  } finally {
    rmSync(tampered.root, { recursive: true, force: true });
  }
});

test("rejects unknown commands and non-absolute paths", () => {
  const f = fixture();
  try {
    assert.throws(() => runSuggestConfig("enable", f.input, f.deps), /unknown command/);
    assert.throws(
      () => runSuggestConfig("preflight", { ...f.input, config: "relative.json" }, f.deps),
      /absolute/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
