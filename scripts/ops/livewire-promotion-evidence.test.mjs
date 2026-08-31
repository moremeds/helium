import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../packages/core/lib/index.js";
import {
  exportLivewirePromotionEvidence,
  verifyLivewirePromotionEvidence,
} from "./livewire-promotion-evidence.mjs";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-livewire-evidence-"));
  const release = join(root, "release");
  const promotion = join(root, "promotion");
  const sourceRoot = join(root, "livewire");
  const external = join(root, "runtime");
  for (const path of [release, promotion, sourceRoot, external]) mkdirSync(path, { recursive: true });
  mkdirSync(join(release, "plugins", "livewire-shepherd", "lib"), { recursive: true });
  mkdirSync(join(promotion, "components"), { recursive: true });
  mkdirSync(join(sourceRoot, "clients"), { recursive: true });

  const releaseFile = join(release, "plugins", "livewire-shepherd", "lib", "index.js");
  const node = join(external, "node");
  const python = join(external, "python");
  const component = join(promotion, "components", "livewire.yaml");
  const registered = join(promotion, "registered-probes.json");
  const nodeManifest = join(promotion, "node-runtime.sha256");
  const pythonManifest = join(promotion, "python-runtime.sha256");
  const sourceFile = join(sourceRoot, "clients", "shepherd_repair.py");
  const sourceManifest = join(root, "livewire-source.sha256");
  writeFileSync(releaseFile, "export const livewire = true;\n");
  writeFileSync(node, "node-runtime\n", { mode: 0o500 });
  writeFileSync(python, "python-runtime\n", { mode: 0o500 });
  writeFileSync(component, "version: 1\nid: livewire\n");
  writeFileSync(registered, '{"version":1,"probeIds":["livewire.repair-postcondition.v1"]}\n');
  writeFileSync(sourceFile, "def repair():\n    return True\n");
  writeFileSync(sourceManifest, `${sha256(sourceFile)}  clients/shepherd_repair.py\n`);
  const runtimeFiles = [
    { path: "plugins/livewire-shepherd/lib/index.js", sha256: sha256(releaseFile) },
    { path: node, sha256: sha256(node) },
  ];
  const pythonRuntimeFiles = [{ path: python, sha256: sha256(python) }];
  writeFileSync(nodeManifest, `${runtimeFiles.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`);
  writeFileSync(pythonManifest, `${pythonRuntimeFiles.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`);
  const unsigned = {
    version: 1,
    promotionId: "livewire-shepherd-targeted-repair",
    release: { dir: release, commit: "a".repeat(40) },
    nodeBinary: { path: node, sha256: sha256(node) },
    runtimeFiles,
    runtimeManifest: { path: nodeManifest, sha256: sha256(nodeManifest) },
    pythonBinary: { path: python, sha256: sha256(python) },
    pythonRuntimeFiles,
    pythonRuntimeManifest: { path: pythonManifest, sha256: sha256(pythonManifest) },
    bundleFiles: [{ path: "components/livewire.yaml", sha256: sha256(component) }],
    registeredProbes: {
      path: registered,
      sha256: sha256(registered),
      probeIds: ["livewire.repair-postcondition.v1"],
    },
    livewireSource: {
      root: sourceRoot,
      manifest: { path: sourceManifest, sha256: sha256(sourceManifest) },
      files: [{ path: "clients/shepherd_repair.py", sha256: sha256(sourceFile) }],
    },
    issuedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
    rollbackRef: "release://previous",
  };
  const input = { ...unsigned, inputSha256: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") };
  const promotionInput = join(promotion, "promotion-input.json");
  writeFileSync(promotionInput, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  return { root, release, promotion, sourceRoot, sourceFile, sourceManifest, promotionInput };
}

test("exports and verifies an exact content-addressed production-path evidence bundle", () => {
  const f = fixture();
  const output = join(f.root, "evidence");
  try {
    const manifest = exportLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      outputDir: output,
    });
    assert.equal(manifest.promotionInputSha256.length, 64);
    assert.ok(manifest.entries.some((row) => row.productionPath === f.sourceFile));
    assert.ok(manifest.entries.some((row) => row.productionPath.endsWith("plugins/livewire-shepherd/lib/index.js")));
    assert.equal(readdirSync(join(output, "blobs")).length, new Set(manifest.entries.map((row) => row.sha256)).size);
    assert.equal(statSync(join(output, "manifest.json")).mode & 0o077, 0);
    assert.deepEqual(verifyLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      evidenceDir: output,
      releaseCheckout: f.release,
      resolveReleaseCommit: () => "a".repeat(40),
      assertReleaseClean: () => {},
    }), manifest);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("refuses a tampered or extra content-addressed blob", () => {
  const f = fixture();
  const output = join(f.root, "evidence");
  try {
    const manifest = exportLivewirePromotionEvidence({ promotionInputPath: f.promotionInput, outputDir: output });
    const blob = join(output, "blobs", manifest.entries[0].sha256);
    chmodSync(blob, 0o600);
    writeFileSync(blob, "tampered\n");
    assert.throws(() => verifyLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      evidenceDir: output,
      releaseCheckout: f.release,
      resolveReleaseCommit: () => "a".repeat(40),
      assertReleaseClean: () => {},
    }), /evidence blob hash mismatch/);

    rmSync(output, { recursive: true, force: true });
    exportLivewirePromotionEvidence({ promotionInputPath: f.promotionInput, outputDir: output });
    writeFileSync(join(output, "blobs", "f".repeat(64)), "extra\n");
    assert.throws(() => verifyLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      evidenceDir: output,
      releaseCheckout: f.release,
      resolveReleaseCommit: () => "a".repeat(40),
      assertReleaseClean: () => {},
    }), /unexpected evidence blob/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("refuses source symlinks and refuses overwriting an evidence directory", () => {
  const f = fixture();
  const output = join(f.root, "evidence");
  try {
    const linked = join(f.sourceRoot, "clients", "linked.py");
    symlinkSync(f.sourceFile, linked);
    const input = JSON.parse(readFileSync(f.promotionInput, "utf8"));
    input.livewireSource.files.push({ path: "clients/linked.py", sha256: sha256(linked) });
    const { inputSha256: _old, ...unsigned } = input;
    input.inputSha256 = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
    writeFileSync(f.promotionInput, `${JSON.stringify(input, null, 2)}\n`);
    assert.throws(() => exportLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      outputDir: output,
    }), /symlink/);

    rmSync(linked);
    input.livewireSource.files.pop();
    const { inputSha256: _linked, ...restored } = input;
    input.inputSha256 = createHash("sha256").update(canonicalJson(restored)).digest("hex");
    writeFileSync(f.promotionInput, `${JSON.stringify(input, null, 2)}\n`);
    exportLivewirePromotionEvidence({ promotionInputPath: f.promotionInput, outputDir: output });
    assert.throws(() => exportLivewirePromotionEvidence({
      promotionInputPath: f.promotionInput,
      outputDir: output,
    }), /refusing to overwrite evidence directory/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
