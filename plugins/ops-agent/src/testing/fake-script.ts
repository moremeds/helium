/**
 * A scriptable stand-in for a certified repair script.
 *
 * It is a real executable file with a real shebang, spawned as a real child
 * process, because the properties under test -- process groups, environment
 * isolation, owned cwd, descendant reaping -- are properties of a real spawn
 * and cannot be observed against a stub.
 * @module dsh-plugin-ops-agent/testing/fake-script
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeScriptOptions {
  /** Exit with this code after doing whatever else was asked. */
  exitCode?: number;
  /** Echo the argv the child actually received, one per line. */
  reportArgv?: boolean;
  /** Echo the child's environment keys, sorted, one per line. */
  reportEnvKeys?: boolean;
  /** Echo the child's working directory. */
  reportCwd?: boolean;
  /** Write this many bytes to stdout before exiting. */
  emitBytes?: number;
  /** Spawn a long-lived descendant, then sleep past the executor's deadline. */
  spawnDescendant?: boolean;
  /** Sleep this long before exiting. */
  sleepMs?: number;
}

/**
 * Write a fake script into `dir` and return its path.
 *
 * @param descendantMarker - a file path the descendant touches while alive, so
 * a test can prove the descendant was reaped rather than merely orphaned.
 */
export function writeFakeScript(
  dir: string,
  options: FakeScriptOptions = {},
  descendantMarker?: string,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-repair.mjs");
  const body = `#!/usr/bin/env node
const opts = ${JSON.stringify(options)};
const marker = ${JSON.stringify(descendantMarker ?? null)};
if (opts.reportArgv) {
  for (const a of process.argv.slice(2)) process.stdout.write("ARG:" + a + "\\n");
}
if (opts.reportEnvKeys) {
  for (const k of Object.keys(process.env).sort()) process.stdout.write("ENV:" + k + "\\n");
}
if (opts.reportCwd) process.stdout.write("CWD:" + process.cwd() + "\\n");
if (opts.emitBytes) process.stdout.write("x".repeat(opts.emitBytes) + "\\n");
if (opts.spawnDescendant && marker) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e",
    "const fs=require('node:fs');" +
    "setInterval(()=>fs.writeFileSync(" + JSON.stringify(marker) + ", String(Date.now())), 25);"
  ], { stdio: "ignore" });
  child.unref();
}
if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
process.exit(opts.exitCode ?? 0);
`;
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
