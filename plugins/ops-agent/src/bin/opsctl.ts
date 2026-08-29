#!/usr/bin/env node
/** Submit signed operator envelopes to the owner-only opsd socket. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { OpsControlClient } from "../ipc.js";

export interface OpsctlArgs {
  command: "approve" | "record-intervention";
  socketPath: string;
  envelopePath: string;
}

export function parseOpsctlArgs(argv: readonly string[]): OpsctlArgs {
  const command = argv[0];
  if (command !== "approve" && command !== "record-intervention") {
    throw new Error(`unknown opsctl command: ${command ?? "<missing>"}`);
  }
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--socket" && flag !== "--envelope") {
      throw new Error(`unknown opsctl flag: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) throw new Error(`duplicate opsctl flag: ${flag}`);
    if (value === undefined) throw new Error(`opsctl flag ${flag} requires a value`);
    values.set(flag, value);
  }
  const socketPath = values.get("--socket");
  const envelopePath = values.get("--envelope");
  if (socketPath === undefined || envelopePath === undefined) {
    throw new Error("opsctl requires --socket and --envelope");
  }
  return { command, socketPath, envelopePath };
}

export async function runOpsctl(argv: readonly string[]): Promise<unknown> {
  const parsed = parseOpsctlArgs(argv);
  const envelope = JSON.parse(readFileSync(parsed.envelopePath, "utf8"));
  return await new OpsControlClient(parsed.socketPath).request({
    type: parsed.command,
    envelope,
  });
}

async function main(): Promise<void> {
  const response = await runOpsctl(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "opsctl failed"}\n`);
    process.exitCode = 1;
  });
}
