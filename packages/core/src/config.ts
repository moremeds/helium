import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The operator's machine-local configuration file: credentials, and the egress
 * proxy the machine needs to reach anything outside itself. Not in the repo,
 * and not the same on two machines — the laptop's shell exports a proxy, the
 * mini's launchd job has none, and that difference is what hid a months-long
 * production failure (design §3.1).
 *
 * `process.loadEnvFile` is the runtime half of node's `--env-file`: it parses
 * the file and fills `process.env`, but never overwrites a key already set. So
 * an explicit `export` still wins, and a test can set a value without the file
 * silently replacing it.
 * @module @helium/core/config
 */
export function operatorEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIUM_ENV_FILE ?? resolve(homedir(), ".config/helium/helium.env");
}

/**
 * Loads it if it is there. A missing file is normal — a dev checkout has none,
 * and every consumer already reports the specific value it could not find far
 * more usefully than "no config file" would.
 *
 * @returns the path loaded, or undefined if there was nothing to load.
 */
export function loadOperatorEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = operatorEnvPath(env);
  try {
    process.loadEnvFile(path);
    return path;
  } catch {
    return undefined;
  }
}
