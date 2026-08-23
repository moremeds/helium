/**
 * Secrets-safe `KEY=VAL` env-file reader for the senior lane's child process
 * environment (spec §12). Never log the returned values.
 * @module dsh-plugin-helium/envfile
 */
import { readFileSync } from "node:fs";

/** Reads a 0600 `KEY=VAL` secrets file. Never log the returned values. */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
