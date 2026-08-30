#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CERTIFIED_ARGV = ["--scope", "containers", "--pull", "false"];
const LEGACY_ARGV = ["--containers"];

export const TRADING_STACK_RECONCILE_CONTRACT = {
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
};

function assertCertifiedArgv(argv) {
  if (
    argv.length !== CERTIFIED_ARGV.length ||
    argv.some((value, index) => value !== CERTIFIED_ARGV[index])
  ) {
    throw new Error(
      "trading-stack-reconcile accepts only --scope containers --pull false",
    );
  }
}

function assertTargetIdentity({ target, expectedOwnerUid, expectedSha256 }) {
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error("legacy reconcile target is not a file");
  if ((stat.mode & 0o022) !== 0) {
    throw new Error("legacy reconcile target is writable by group or world");
  }
  if (stat.uid !== expectedOwnerUid) {
    throw new Error("legacy reconcile target owner does not match certification");
  }
  const actual = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  if (actual !== expectedSha256) {
    throw new Error("legacy reconcile target hash does not match certification");
  }
}

function spawnTarget(target, cwd, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(target, LEGACY_ARGV, {
      cwd,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`legacy reconcile terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runTradingStackReconcile(
  argv,
  options = TRADING_STACK_RECONCILE_CONTRACT,
) {
  assertCertifiedArgv(argv);
  assertTargetIdentity(options);
  return spawnTarget(options.target, options.cwd, options.environment);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTradingStackReconcile(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "container reconcile refused"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
