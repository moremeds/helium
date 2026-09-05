/**
 * Every tool call a run made, on disk, so the next replay can be served from
 * them instead of refused.
 *
 * The audit table stores `toolOutputBytes` and nothing else, which is why
 * fourteen live-only tools could never be replayed and pit coverage sat at
 * 10/24. A byte count is not history. This is: args, the instant, the raw
 * response, its sha256 and its length.
 *
 * `context` is the text that actually entered the model context when it
 * differs from `raw` — the summariser doctrine 4 calls for does not exist yet
 * (see packages/cli/src/runner.ts, where every span is written
 * `summarised: false`), so today it is always `null` and the field is here so
 * that a recording made after the summariser lands is still self-describing.
 *
 * Nothing in this file knows what a tool IS. It stores strings under a name.
 * @module @helium/cli/tool-io
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  /** ISO instant the call was made at — real time, not the replayed clock. */
  at: string;
  /** The tool's return, verbatim. `null` when the call threw. */
  raw: string | null;
  rawSha256: string | null;
  rawBytes: number;
  /** What entered the model context, when it is not `raw`. */
  context: string | null;
  /** Present instead of a response when the call threw. */
  error?: string;
}

/** `<stateRoot>/runs/<runId>/tool-io`. */
export function recordingsDir(stateRoot: string, runId: string): string {
  return join(stateRoot, "runs", runId, "tool-io");
}

/** Key order must not decide whether a replay hits. Recursive because a
 *  tool's arguments nest — `{ window: { days: 5 } }` is one call, however the
 *  two keys happened to be serialised. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort())
    out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

export function argsKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${createHash("sha256")
    .update(JSON.stringify(canonical(args)))
    .digest("hex")}`;
}

/** File-name-safe, and it does not have to round-trip: the record inside
 *  carries the real tool name, and the name in the file is for a human
 *  reading `ls`. */
function safeName(tool: string): string {
  return tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

export function writeRecording(
  dir: string,
  seq: number,
  record: ToolCallRecord,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(
      dir,
      `${String(seq).padStart(5, "0")}-${safeName(record.tool)}.json.gz`,
    ),
    gzipSync(Buffer.from(JSON.stringify(record), "utf8")),
  );
}

/** The sha256 of a response, for the record. Exported so a caller can compare
 *  a served answer against the one that was recorded without decompressing
 *  twice. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface RecordingIndex {
  /** Whether this run recorded ANY successful call to the tool. */
  has(tool: string): boolean;
  lookup(tool: string, args: Record<string, unknown>): string | undefined;
  /** Tool names that have actually answered from this index, sorted. */
  served(): string[];
  size: number;
}

/**
 * Every recording in one directory, keyed by tool and canonical args.
 *
 * File name order IS call order (a zero-padded sequence), so a later call
 * overwrites an earlier one for the same key: a tool called twice in a run
 * should replay as its last answer, which is the state the rest of the run
 * saw. An ERROR record is not indexed — replaying a failure as if it were a
 * response is the one outcome worse than refusing.
 */
export function loadRecordings(dir: string): RecordingIndex {
  const byKey = new Map<string, string>();
  const tools = new Set<string>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json.gz")) continue;
      let record: ToolCallRecord;
      try {
        record = JSON.parse(
          gunzipSync(readFileSync(join(dir, name))).toString("utf8"),
        ) as ToolCallRecord;
      } catch {
        continue;
      }
      if (typeof record.raw !== "string") continue;
      byKey.set(argsKey(record.tool, record.args ?? {}), record.raw);
      tools.add(record.tool);
    }
  }
  const hit = new Set<string>();
  return {
    has: (tool) => tools.has(tool),
    lookup(tool, args) {
      const found = byKey.get(argsKey(tool, args));
      if (found !== undefined) hit.add(tool);
      return found;
    },
    served: () => [...hit].sort((a, b) => a.localeCompare(b, "en")),
    size: byKey.size,
  };
}

/**
 * Delete run directories older than `days` natural days.
 *
 * Thirty by default: a 21-trading-day lookback plus holidays. One directory
 * walk and no index — an index of what is on disk is a second source of truth
 * about what is on disk.
 *
 * `keep` is the caller's, and it is the only way anything survives its age.
 * This module reads no ledger, no database and no config: whoever knows that a
 * run is still cited passes a predicate that says so.
 */
export function pruneRecordings(
  stateRoot: string,
  options: {
    now?: Date;
    days?: number;
    keep?: (runId: string) => boolean;
  } = {},
): string[] {
  const root = join(stateRoot, "runs");
  if (!existsSync(root)) return [];
  const cutoff =
    (options.now ?? new Date()).getTime() -
    (options.days ?? 30) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const runId of readdirSync(root).sort()) {
    if (options.keep?.(runId) === true) continue;
    const dir = join(root, runId);
    try {
      if (statSync(dir).mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(runId);
    } catch {
      // A directory that vanished under us, or one we may not stat, is not a
      // reason to abandon the rest of the prune.
    }
  }
  return removed;
}
