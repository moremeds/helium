import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRADING_STACK_RECONCILE_CONTRACT,
  runTradingStackReconcile,
} from "./trading-stack-reconcile.mjs";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureTarget(root, body = "printf '%s\\n' \"$@\" > \"$HELIUM_TEST_CAPTURE\"\n") {
  const target = join(root, "reconcile.sh");
  writeFileSync(target, `#!/bin/sh\n${body}`, { mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}

function options(root, target, overrides = {}) {
  return {
    target,
    expectedSha256: sha256(target),
    expectedOwnerUid: process.getuid?.() ?? 0,
    cwd: root,
    environment: {
      PATH: "/usr/bin:/bin",
      HELIUM_TEST_CAPTURE: join(root, "argv.txt"),
    },
    ...overrides,
  };
}

test("pins the production target, identity, socket, and bounded environment", () => {
  assert.deepEqual(TRADING_STACK_RECONCILE_CONTRACT, {
    target: "/Users/moremeds/trading-stack/scripts/reconcile.sh",
    expectedSha256:
      "3da35c87a76a90a55669c5e86db038e92fb21f6ff737526a0a1d6dc1c613da2e",
    expectedOwnerUid: 501,
    cwd: "/Users/moremeds/trading-stack",
    environment: {
      DOCKER_HOST: "unix:///Users/moremeds/.colima/default/docker.sock",
      HOME: "/Users/moremeds",
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TRADING_STACK_ROOT: "/Users/moremeds/trading-stack",
    },
  });
});

test("translates the certified container-only contract to the legacy interface", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-container-reconcile-"));
  try {
    const capture = join(root, "argv.txt");
    const target = fixtureTarget(root);

    const exitCode = await runTradingStackReconcile(
      ["--scope", "containers", "--pull", "false"],
      options(root, target),
    );

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(capture, "utf8"), "--containers\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses every argv shape outside the certified contract", async () => {
  for (const argv of [
    [],
    ["--scope", "containers"],
    ["--scope", "all", "--pull", "false"],
    ["--scope", "containers", "--pull", "true"],
    ["--pull", "false", "--scope", "containers"],
    ["--scope", "containers", "--pull", "false", "--boot", "true"],
  ]) {
    await assert.rejects(
      runTradingStackReconcile(argv),
      /accepts only --scope containers --pull false/,
    );
  }
});

test("refuses drifted, writable, wrongly owned, and symlinked legacy targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-container-reconcile-"));
  const argv = ["--scope", "containers", "--pull", "false"];
  try {
    const target = fixtureTarget(root);
    await assert.rejects(
      runTradingStackReconcile(argv, options(root, target, { expectedSha256: "0".repeat(64) })),
      /hash does not match/,
    );

    await assert.rejects(
      runTradingStackReconcile(
        argv,
        options(root, target, {
          expectedOwnerUid: (process.getuid?.() ?? 0) + 1,
        }),
      ),
      /owner does not match/,
    );

    chmodSync(target, 0o722);
    await assert.rejects(
      runTradingStackReconcile(argv, options(root, target)),
      /writable by group or world/,
    );
    chmodSync(target, 0o700);

    const link = join(root, "reconcile-link.sh");
    symlinkSync(target, link);
    await assert.rejects(
      runTradingStackReconcile(
        argv,
        options(root, target, {
          target: link,
          expectedSha256: sha256(target),
        }),
      ),
      /not a file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns the legacy process exit code without treating it as recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-container-reconcile-"));
  try {
    const target = fixtureTarget(root, "exit 17\n");
    assert.equal(
      await runTradingStackReconcile(
        ["--scope", "containers", "--pull", "false"],
        options(root, target),
      ),
      17,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
