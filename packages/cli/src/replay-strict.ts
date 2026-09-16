import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJson, parseStrictJson } from "@helium/core";
import { argsKey, sha256, type RecordingIndex, type ToolCallRecord } from "./tool-io.js";

/** Frozen source world, ordered by occurrence within each exact query. No latest-value fallback. */
export function loadSnapshotRecordings(dir: string): RecordingIndex & {
  inputHash: string;
  issues(): string[];
  persist(dir: string): void;
} {
  const records = new Map<string, ToolCallRecord[]>();
  const names = new Set<string>();
  const files: Array<[string, string]> = [];
  const frozenFiles: Array<[string, Buffer]> = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json.gz")) continue;
    const path = join(dir, name);
    if (!lstatSync(path).isFile()) throw new Error(`Replay input is not a regular file: ${name}`);
    const bytes = readFileSync(path);
    const raw = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8");
    const r = parseStrictJson(raw) as ToolCallRecord;
    if (!r || typeof r.tool !== "string" || !r.args || Array.isArray(r.args) || typeof r.args !== "object" ||
        typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at)) ||
        (typeof r.raw !== "string" && r.raw !== null) ||
        (r.raw === null && (typeof r.error !== "string" || r.rawSha256 !== null || r.rawBytes !== 0)) ||
        (typeof r.raw === "string" && (sha256(r.raw) !== r.rawSha256 || Buffer.byteLength(r.raw) !== r.rawBytes)))
      throw new Error(`Invalid or corrupted replay record: ${name}`);
    const key = argsKey(r.tool, r.args);
    const entries = records.get(key) ?? [];
    entries.push(r);
    records.set(key, entries);
    names.add(r.tool);
    files.push([name, sha256(raw)]);
    frozenFiles.push([name, bytes]);
  }
  if (files.length === 0) throw new Error("Frozen source world has no records");
  const positions = new Map<string, number>();
  const used = new Set<string>();
  const issues: string[] = [];
  return {
    size: files.length,
    inputHash: sha256(canonicalJson(files)),
    has: (tool) => names.has(tool),
    served: () => [...used].sort(),
    issues: () => [...issues],
    persist(dir) {
      mkdirSync(dir, { recursive: true });
      for (const [name, bytes] of frozenFiles)
        writeFileSync(join(dir, name), bytes, { flag: "wx" });
    },
    lookup(tool, args) {
      const key = argsKey(tool, args);
      const position = positions.get(key) ?? 0;
      const record = records.get(key)?.[position];
      if (record === undefined) {
        const issue = `NOT_COMPARABLE: no frozen occurrence ${position + 1} for ${key}`;
        issues.push(issue);
        throw new Error(issue);
      }
      positions.set(key, position + 1);
      used.add(tool);
      if (record.raw === null) throw new Error(`Recorded source failure: ${record.error}`);
      return record.raw;
    },
  };
}
