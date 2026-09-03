/**
 * Which commit is running. The deploy tar carries a `RELEASE` file at the tree
 * root (`<sha>\n`) because the mini has no git checkout and must not need one;
 * a developer checkout has the repo instead and no `RELEASE`. Everything else
 * is `"unknown"`, which is a fact about the deploy, not an error.
 * @module @helium/cli/code-version
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/packages/cli` — this file is `<pkg>/{src,lib}/code-version.js`. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

let cached: string | undefined;

/**
 * Resolved once per process: it cannot change under a running node, and an
 * audit row per step must not cost a subprocess each.
 */
export function codeVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (cached !== undefined) return cached;
  cached = resolveCodeVersion(env);
  return cached;
}

function resolveCodeVersion(env: NodeJS.ProcessEnv): string {
  const override = env.HELIUM_CODE_VERSION;
  if (override !== undefined && override.trim() !== "") return override.trim();
  try {
    const release = readFileSync(join(repoRoot, "RELEASE"), "utf8").trim();
    if (release !== "") return release;
  } catch {
    // No RELEASE file: a developer checkout, not a deployed release.
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha !== "") return sha;
  } catch {
    // No repository, or no such binary: "unknown" is the honest answer.
  }
  return "unknown";
}
