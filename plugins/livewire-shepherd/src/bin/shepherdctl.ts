#!/usr/bin/env node
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { loadShepherdRuntimeConfig } from "../config.js";
import { composeShepherdDaemon } from "./shepherdd.js";

type Command = "check-config" | "tick";

export interface ShepherdctlArgs {
  command: Command;
  configPath: string;
}

export function parseShepherdctlArgs(argv: readonly string[]): ShepherdctlArgs {
  const command = argv[0];
  const configPath = argv[2];
  if ((command !== "check-config" && command !== "tick") ||
      argv.length !== 3 || argv[1] !== "--config" || configPath === undefined) {
    throw new Error("usage: shepherdctl (check-config|tick) --config ABSOLUTE_PATH");
  }
  if (!isAbsolute(configPath)) throw new Error("Shepherd config path must be absolute");
  return { command, configPath };
}

export async function runShepherdctl(
  argv: readonly string[],
  deps: {
    load?: typeof loadShepherdRuntimeConfig;
    compose?: typeof composeShepherdDaemon;
  } = {},
): Promise<{ ok: true; command: Command; result?: unknown }> {
  const parsed = parseShepherdctlArgs(argv);
  assertPrivateConfig(parsed.configPath);
  (deps.load ?? loadShepherdRuntimeConfig)(parsed.configPath);
  if (parsed.command === "check-config") return { ok: true, command: parsed.command };
  const daemon = (deps.compose ?? composeShepherdDaemon)(parsed.configPath);
  const result = await daemon.tickOnce();
  return { ok: true, command: parsed.command, result };
}

function assertPrivateConfig(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Shepherd config must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("Shepherd config must be owner-only (0600)");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Shepherd config must be owned by the daemon user");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runShepherdctl(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error: unknown) => {
      process.stderr.write(`[shepherdctl] ${error instanceof Error ? error.message : "unknown failure"}\n`);
      process.exitCode = 1;
    },
  );
}
