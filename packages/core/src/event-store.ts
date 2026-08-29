/**
 * Generic append-only event store: append with an fsync boundary, a content
 * hash per record, snapshot, truncated-line recovery, and replay over a
 * caller-supplied record schema.
 *
 * This is NEW code, not a rename of `jsonl.ts`. That module does one
 * `appendFileSync` per record and has no fsync, no content hash, no snapshot
 * and no replay; `state.ts` has only tmp-write-then-rename. It lives here
 * rather than under `src/operations/` because it is not an operations concept
 * -- the durable team kernel and the operations substrate both consume it, and
 * the one that runs first must not depend on the one that runs second.
 *
 * The log is always authoritative. A snapshot is an optimization that is
 * discarded whenever it cannot be proven to describe this log.
 * @module @helium/core/event-store
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

const LOG_VERSION = 1;
const SNAPSHOT_VERSION = 1;

/**
 * Deterministic JSON: object keys sorted at every depth, so a record hashes
 * the same however its keys were ordered when it was built. Array order is
 * meaningful and is left alone.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export interface AppendedEvent {
  seq: number;
  hash: string;
}

export interface SnapshotInfo {
  lastSeq: number;
  lastHash: string;
}

export interface EventStore<T> {
  readonly logPath: string;
  readonly snapshotPath: string;
  append(record: T): AppendedEvent;
  replay(): T[];
  snapshot(): SnapshotInfo;
  contentHash(record: T): string;
}

interface Envelope {
  v: number;
  seq: number;
  hash: string;
  record: unknown;
}

export interface EventStoreOptions<T> {
  schema: z.ZodType<T>;
  /** The fsync boundary, injectable so a test can observe that it is crossed. */
  sync?: (fd: number) => void;
}

export function openEventStore<T>(
  dir: string,
  options: EventStoreOptions<T>,
): EventStore<T> {
  const { schema, sync = fsyncSync } = options;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0) {
    throw new Error(`${dir}: event-store directory must be owner-only (0700)`);
  }
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
    throw new Error(`${dir}: event-store directory has a different owner`);
  }
  const logPath = join(dir, "events.jsonl");
  const snapshotPath = join(dir, "snapshot.json");
  for (const path of [logPath, snapshotPath]) {
    if (!existsSync(path)) continue;
    const file = statSync(path);
    if (!file.isFile() || (file.mode & 0o077) !== 0) {
      throw new Error(`${path}: event-store file must be owner-only (0600)`);
    }
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
      throw new Error(`${path}: event-store file has a different owner`);
    }
  }

  const contentHash = (record: T): string =>
    `sha256:${createHash("sha256").update(canonicalJson(record)).digest("hex")}`;

  /**
   * Read the log, dropping a torn final line.
   *
   * A file that does not end in a newline had its last append interrupted, so
   * that fragment is dropped -- never parsed leniently and never repaired. Any
   * OTHER unreadable line is corruption in the middle of the log and is fatal:
   * silently skipping it would hand the caller a history that never happened.
   */
  const readLog = (): Envelope[] => {
    if (!existsSync(logPath)) return [];
    const raw = readFileSync(logPath, "utf8");
    if (raw === "") return [];
    const lines = raw.split("\n");
    const tail = lines.pop();
    if (tail !== "") {
      // Torn write: no terminating newline. Drop it.
    }
    return lines.map((line, i) => {
      let parsed: Envelope;
      try {
        parsed = JSON.parse(line) as Envelope;
      } catch {
        throw new Error(`${logPath}: unreadable record at line ${i + 1}`);
      }
      if (parsed.v !== LOG_VERSION) {
        throw new Error(
          `${logPath}: unsupported record version ${parsed.v} at line ${i + 1}`,
        );
      }
      if (parsed.seq !== i + 1) {
        throw new Error(
          `${logPath}: sequence mismatch at line ${i + 1}: expected ${i + 1}, got ${parsed.seq}`,
        );
      }
      const record = schema.parse(parsed.record);
      if (parsed.hash !== contentHash(record)) {
        throw new Error(`${logPath}: content hash mismatch at line ${i + 1}`);
      }
      parsed.record = record;
      return parsed;
    });
  };

  let seq = readLog().length;

  const readSnapshot = (log: Envelope[]): { lastSeq: number; records: T[] } | undefined => {
    if (!existsSync(snapshotPath)) return undefined;
    let snap: { v?: number; lastSeq?: number; lastHash?: string; records?: unknown[] };
    try {
      snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch {
      return undefined;
    }
    if (snap.v !== SNAPSHOT_VERSION) return undefined;
    if (typeof snap.lastSeq !== "number" || !Array.isArray(snap.records)) {
      return undefined;
    }
    if (snap.records.length !== snap.lastSeq) return undefined;
    const anchor = log.find((e) => e.seq === snap.lastSeq);
    if (anchor === undefined || anchor.hash !== snap.lastHash) return undefined;
    const records = snap.records.map((record) => schema.parse(record));
    if (records.some((record, index) => log[index]?.hash !== contentHash(record))) {
      return undefined;
    }
    return {
      lastSeq: snap.lastSeq,
      records,
    };
  };

  return {
    logPath,
    snapshotPath,
    contentHash,

    append(record: T): AppendedEvent {
      const validated = schema.parse(record);
      const next = seq + 1;
      const hash = contentHash(validated);
      const envelope: Envelope = {
        v: LOG_VERSION,
        seq: next,
        hash,
        record: validated,
      };
      const fd = openSync(logPath, "a", 0o600);
      try {
        chmodSync(logPath, 0o600);
        writeSync(fd, `${canonicalJson(envelope)}\n`);
        sync(fd);
      } finally {
        closeSync(fd);
      }
      seq = next;
      return { seq: next, hash };
    },

    replay(): T[] {
      const log = readLog();
      const snap = readSnapshot(log);
      if (snap === undefined) {
        return log.map((e) => schema.parse(e.record));
      }
      return [
        ...snap.records,
        ...log.filter((e) => e.seq > snap.lastSeq).map((e) => schema.parse(e.record)),
      ];
    },

    snapshot(): SnapshotInfo {
      const log = readLog();
      const last = log.at(-1);
      if (last === undefined) throw new Error(`${logPath}: nothing to snapshot`);
      const body = {
        v: SNAPSHOT_VERSION,
        lastSeq: last.seq,
        lastHash: last.hash,
        records: log.map((e) => e.record),
      };
      // tmp-then-rename: a half-written snapshot must never be readable, and
      // the log stays authoritative if this fails outright.
      const tmp = `${snapshotPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      renameSync(tmp, snapshotPath);
      chmodSync(snapshotPath, 0o600);
      return { lastSeq: last.seq, lastHash: last.hash };
    },
  };
}
