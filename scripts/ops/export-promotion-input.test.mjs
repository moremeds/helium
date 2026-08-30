import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportPromotionInput } from "./export-promotion-input.mjs";

const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-promotion-input-"));
  roots.push(root);
  const promotionDir = join(root, "promotion");
  cpSync(join(repo, "ops/promotions/trading-stack-reconcile"), promotionDir, { recursive: true });
  const registeredProbesPath = join(root, "registered-probes.json");
  cpSync(join(repo, "ops/registered-probes.json"), registeredProbesPath);
  const output = join(root, "promotion-input.json");
  const input = {
    releaseDir: repo,
    releaseCommit: "fixture-commit",
    promotionDir,
    registeredProbesPath,
    wrapperSourcePath: join(repo, "scripts/ops/actions/trading-stack-reconcile.mjs"),
    issuedAt: "2026-08-30T03:00:00.000Z",
    expiresAt: "2026-08-30T05:00:00.000Z",
    rollbackRef: "rollback://observe-config-and-two-legacy-plists",
    output,
  };
  return { root, promotionDir, registeredProbesPath, output, input };
}

const options = { resolveReleaseCommit: () => "fixture-commit" };

test("exports one canonical exact promotion input with private output semantics", () => {
  const f = fixture();
  const payload = exportPromotionInput(f.input, options);
  const written = JSON.parse(readFileSync(f.output, "utf8"));

  assert.deepEqual(written, payload);
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
  assert.equal(payload.promotionId, "trading-stack-reconcile");
  assert.deepEqual(payload.release, { dir: repo, commit: "fixture-commit" });
  assert.equal(payload.registeredProbes.probeIds.length, 7);
  assert.equal(payload.componentOwner.owner, "opsd");
  assert.equal(payload.executor.executorId, "trading-stack-reconcile");
  assert.equal(payload.sop.id, "trading-stack-container-reconcile");
  assert.equal(payload.sop.maxAttempts, 1);
  assert.match(payload.inputSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => exportPromotionInput(f.input, options), /refusing to overwrite/);
});

test("rejects release, probe, owner, SOP, and executor drift", () => {
  const release = fixture();
  assert.throws(
    () => exportPromotionInput({ ...release.input, releaseCommit: "wrong" }, options),
    /release commit mismatch/,
  );

  const probes = fixture();
  writeFileSync(probes.registeredProbesPath, JSON.stringify({ version: 1, probeIds: [] }));
  assert.throws(() => exportPromotionInput(probes.input, options), /unregistered probe/);

  const owner = fixture();
  const componentPath = join(owner.promotionDir, "components/colima.yaml");
  writeFileSync(
    componentPath,
    readFileSync(componentPath, "utf8").replace("owner: opsd", "owner: external"),
  );
  assert.throws(() => exportPromotionInput(owner.input, options), /owner must be opsd/);

  const sop = fixture();
  const sopPath = join(sop.promotionDir, "sops/trading-stack-container-reconcile.yaml");
  writeFileSync(sopPath, readFileSync(sopPath, "utf8").replace("maxAttempts: 1", "maxAttempts: 2"));
  assert.throws(() => exportPromotionInput(sop.input, options), /SOP digest mismatch/);

  const executor = fixture();
  const executorPath = join(executor.promotionDir, "executors/trading-stack-reconcile.yaml");
  writeFileSync(
    executorPath,
    readFileSync(executorPath, "utf8").replace(/value: "[0-9a-f]{64}"/, `value: "${"0".repeat(64)}"`),
  );
  assert.throws(() => exportPromotionInput(executor.input, options), /wrapper source hash/);
});
