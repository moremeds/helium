import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECONCILE_WRAPPER_SHA256,
  installTradingStackReconcileWrapper,
} from "./install-action-wrapper.mjs";

const repo = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const source = join(repo, "scripts/ops/actions/trading-stack-reconcile.mjs");
const uid = process.getuid?.() ?? 0;

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "helium-action-install-"));
  const root = join(temp, "home/.helium/ops");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return { temp, root };
}

test("stages exact wrapper bytes at an idempotent content-addressed path", () => {
  const { temp, root } = fixture();
  try {
    const first = installTradingStackReconcileWrapper({
      release: repo,
      root,
      expectedOwnerUid: uid,
    });
    const second = installTradingStackReconcileWrapper({
      release: repo,
      root,
      expectedOwnerUid: uid,
    });

    assert.equal(first, second);
    assert.equal(
      first,
      join(
        root,
        "actions",
        `sha256-${RECONCILE_WRAPPER_SHA256}`,
        "trading-stack-reconcile.mjs",
      ),
    );
    assert.deepEqual(readFileSync(first), readFileSync(source));
    assert.equal(lstatSync(first).mode & 0o777, 0o500);
    assert.equal(lstatSync(first).uid, uid);
    assert.equal(lstatSync(dirname(first)).mode & 0o777, 0o700);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("refuses source drift, insecure roots, and symlinked action directories", () => {
  const { temp, root } = fixture();
  try {
    const fakeRelease = join(temp, "release");
    const fakeSource = join(
      fakeRelease,
      "scripts/ops/actions/trading-stack-reconcile.mjs",
    );
    mkdirSync(dirname(fakeSource), { recursive: true });
    writeFileSync(fakeSource, "drifted\n", { mode: 0o500 });
    assert.throws(
      () =>
        installTradingStackReconcileWrapper({
          release: fakeRelease,
          root,
          expectedOwnerUid: uid,
        }),
      /source hash does not match/,
    );

    chmodSync(root, 0o755);
    assert.throws(
      () =>
        installTradingStackReconcileWrapper({
          release: repo,
          root,
          expectedOwnerUid: uid,
        }),
      /root must be private/,
    );
    chmodSync(root, 0o700);

    const outside = join(temp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "actions"));
    assert.throws(
      () =>
        installTradingStackReconcileWrapper({
          release: repo,
          root,
          expectedOwnerUid: uid,
        }),
      /actions directory must not be a symlink/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("refuses an existing content path whose bytes do not match", () => {
  const { temp, root } = fixture();
  try {
    const target = join(
      root,
      "actions",
      `sha256-${RECONCILE_WRAPPER_SHA256}`,
      "trading-stack-reconcile.mjs",
    );
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, "not the wrapper\n", { mode: 0o500 });
    assert.throws(
      () =>
        installTradingStackReconcileWrapper({
          release: repo,
          root,
          expectedOwnerUid: uid,
        }),
      /existing wrapper does not match/,
    );
    assert.equal(readFileSync(target, "utf8"), "not the wrapper\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
