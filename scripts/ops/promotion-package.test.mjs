import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createControlledMutationLayout } from "./controlled-mutation.mjs";
import {
  exportPromotionPackage,
  signPromotionPackage,
} from "./promotion-package.mjs";
import { hardwareIdentityHash } from "./signing-host-policy.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-promotion-package-"));
  roots.push(root);
  const releaseDir = join(root, "release");
  const base = createControlledMutationLayout(root, process.getuid?.() ?? 0);
  const layout = {
    ...base,
    opsdBinary: join(releaseDir, "plugins", "ops-agent", "lib", "bin", "opsd.js"),
    opsdRunner: join(releaseDir, "scripts", "ops", "run-opsd.sh"),
    controlledMutation: join(releaseDir, "scripts", "ops", "controlled-mutation.mjs"),
  };
  const write = (path, value = `${path}\n`, mode = 0o600) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode });
    chmodSync(path, mode);
  };
  const unsignedPromotion = {
    version: 1,
    promotionId: "trading-stack-reconcile",
    issuedAt: "2026-08-30T03:00:00.000Z",
    expiresAt: "2026-08-30T05:00:00.000Z",
    release: { dir: releaseDir, commit: "fixture-commit" },
    bundleFiles: [],
    registeredProbes: { sha256: "a".repeat(64), probeIds: [] },
    componentOwner: { componentId: "colima", owner: "opsd", competingLabels: [], changeRef: "fixture" },
    executor: { executorId: "fixture" },
    sop: { id: "trading-stack-container-reconcile", version: 1, digest: `sha256:${"b".repeat(64)}`, authority: "approve", maxAttempts: 1 },
    rollbackRef: "rollback://observe-config-and-two-legacy-plists",
  };
  const promotion = {
    ...unsignedPromotion,
    inputSha256: createHash("sha256").update(canonical(unsignedPromotion)).digest("hex"),
  };
  write(layout.promotionInput, `${JSON.stringify(promotion)}\n`);
  for (const path of [
    layout.activeConfig,
    layout.candidateConfig,
    layout.authorityManifest,
    layout.publicKey,
    layout.wrapper,
    layout.delegate,
    layout.opsdBinary,
    layout.opsdRunner,
    layout.controlledMutation,
    layout.opsdPlist,
    layout.candidateOpsdPlist,
    layout.legacyRuntimePlist,
    layout.legacyAfterDataLakePlist,
  ]) write(path, `${path}\n`, path.includes("wrapper") || path.includes("opsd.js") ? 0o500 : 0o600);
  const unsignedPackagePath = join(root, "unsigned-package.json");
  const signedPackagePath = join(root, "signed-package.json");
  const privateKeyPath = join(root, "operator-private.pem");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  write(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
  return {
    root,
    layout,
    promotion,
    publicKey,
    privateKeyPath,
    unsignedPackagePath,
    signedPackagePath,
  };
}

test("exports exact host identities and signs the same canonical promotion binding", () => {
  const f = fixture();
  const payload = exportPromotionPackage({
    layout: f.layout,
    promotionInputPath: f.layout.promotionInput,
    output: f.unsignedPackagePath,
  });
  assert.equal(payload.promotionInputSha256, f.promotion.inputSha256);
  assert.equal(payload.release.dir, f.promotion.release.dir);
  assert.equal(payload.artifacts.opsdBinary.path, f.layout.opsdBinary);
  assert.equal(payload.artifacts.opsdRunner.path, f.layout.opsdRunner);
  assert.equal(payload.artifacts.controlledMutation.path, f.layout.controlledMutation);
  assert.equal(Object.keys(payload.artifacts).length, 14);
  assert.equal(lstatSync(f.unsignedPackagePath).mode & 0o777, 0o600);

  const envelope = signPromotionPackage({
    unsignedPackagePath: f.unsignedPackagePath,
    promotionInputPath: f.layout.promotionInput,
    privateKeyPath: f.privateKeyPath,
    output: f.signedPackagePath,
  }, { signingHost });
  assert.equal(lstatSync(f.signedPackagePath).mode & 0o777, 0o600);
  assert.equal(verify(
    null,
    Buffer.from(canonical(envelope.payload)),
    f.publicKey,
    Buffer.from(envelope.signature, "base64"),
  ), true);
});

test("refuses input drift, artifact ambiguity, overwrite, and signing on the mini", () => {
  const f = fixture();
  exportPromotionPackage({
    layout: f.layout,
    promotionInputPath: f.layout.promotionInput,
    output: f.unsignedPackagePath,
  });
  assert.throws(() => exportPromotionPackage({
    layout: f.layout,
    promotionInputPath: f.layout.promotionInput,
    output: f.unsignedPackagePath,
  }), /refusing to overwrite/);

  const payload = JSON.parse(readFileSync(f.unsignedPackagePath, "utf8"));
  payload.rollbackRef = "rollback://different";
  writeFileSync(f.unsignedPackagePath, `${JSON.stringify(payload)}\n`);
  assert.throws(() => signPromotionPackage({
    unsignedPackagePath: f.unsignedPackagePath,
    promotionInputPath: f.layout.promotionInput,
    privateKeyPath: f.privateKeyPath,
    output: f.signedPackagePath,
  }, { signingHost }), /does not match/);

  const g = fixture();
  exportPromotionPackage({
    layout: g.layout,
    promotionInputPath: g.layout.promotionInput,
    output: g.unsignedPackagePath,
  });
  assert.throws(() => signPromotionPackage({
    unsignedPackagePath: g.unsignedPackagePath,
    promotionInputPath: g.layout.promotionInput,
    privateKeyPath: g.privateKeyPath,
    output: g.signedPackagePath,
  }, {
    signingHost: { ...signingHost, hardwareIdentity: miniIdentity },
  }), /registered mini/);
});
