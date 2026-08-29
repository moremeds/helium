/**
 * Append-only daily JSONL files — helium's canonical audit record (spec §8).
 * One file per stream per UTC day; rotation is the file name, retention is
 * `prune()`.
 * @module @helium/core/jsonl
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The UTC calendar date (`YYYY-MM-DD`) an instant belongs to. */
export function utcDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** The file one stream's records for a UTC day land in. */
export function jsonlFileName(stream: string, at: Date = new Date()): string {
  return `${stream}-${utcDate(at)}.jsonl`;
}

/** Files `prune()` is allowed to consider: exactly the ones this writer names. */
const DATED_FILE = /^.+-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Writes append-only daily JSONL streams under one directory. */
export class JsonlWriter {
  /** The directory the daily files live in. */
  readonly dir: string;

  /** The one clock both the file name and the record timestamp are read from. */
  private readonly clock: () => Date;

  /**
   * @param dir - the directory the daily files live in.
   * @param clock - the instant source; injectable so a caller's clock and this
   *   writer's cannot disagree about which UTC day a record belongs to.
   */
  constructor(dir: string, clock: () => Date = () => new Date()) {
    this.dir = dir;
    this.clock = clock;
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one record to `<stream>-<UTC date>.jsonl`.
   * @param stream - the stream name, e.g. `runs`.
   * @param record - the record; a `ts` it already carries is preserved.
   */
  append(stream: string, record: Record<string, unknown>): void {
    // One clock read: the file the row lands in and the row's own `ts` can
    // never straddle a UTC midnight boundary.
    const at = this.clock();
    const line = JSON.stringify({ ts: at.toISOString(), ...record });
    appendFileSync(join(this.dir, jsonlFileName(stream, at)), `${line}\n`);
  }

  /**
   * Delete date-stamped stream files older than the retention window.
   * Files this writer did not name are never touched.
   * @param retentionDays - days of history to keep.
   */
  prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * DAY_MS;
    for (const entry of readdirSync(this.dir)) {
      const match = DATED_FILE.exec(entry);
      if (match === null) continue;
      const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;
      rmSync(join(this.dir, entry));
    }
  }
}
