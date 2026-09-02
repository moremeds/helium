/**
 * Durable, append-only team case log.
 *
 * One JSONL file per case partition. An event is validated, reduced against
 * the current projection, then written and fsynced BEFORE the in-memory
 * projection moves — so an accepted event can never exist only in memory.
 * The log is authoritative and is replayed on open; a torn final line (a
 * crash mid-write) is discarded and overwritten by the next append.
 *
 * There is no hash chain and no snapshot file: the v2 harness keeps no claims
 * ledger, and the dsh session log is the tamper-evident record.
 * @module @helium/core/team/store
 */
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TeamEventSchema, type TeamEvent } from "./events.js";
import { reduceTeam, type TeamState } from "./reducer.js";

const LOG_VERSION = 1;

export interface TeamStoreOptions {
  sync?: (fd: number) => void;
}

/** The position an accepted event took in the log. */
export interface AppendedEvent {
  seq: number;
}

export interface TeamStore {
  readonly caseId: string;
  readonly logPath: string;
  readonly artifactRoot: string;
  append(event: TeamEvent): AppendedEvent;
  events(): TeamEvent[];
  load(): TeamState;
}

interface Envelope {
  v: number;
  seq: number;
  record: unknown;
}

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Read the log, dropping only a torn final line, and return both the events
 * and the byte offset the next append may start from.
 */
function replayLog(logPath: string): { events: TeamEvent[]; size: number } {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { events: [], size: 0 };
  }
  const lines = raw.split("\n");
  // A trailing newline yields a final empty element; anything else in that
  // slot is a partial record from an interrupted write.
  const last = lines.pop();
  const torn = last !== undefined && last !== "";
  const events: TeamEvent[] = [];
  let seq = 0;
  for (const line of lines) {
    if (line === "") continue;
    const envelope = JSON.parse(line) as Envelope;
    if (envelope.v !== LOG_VERSION) {
      throw new Error(`unsupported team log version: ${String(envelope.v)}`);
    }
    seq += 1;
    if (envelope.seq !== seq) {
      throw new Error(`team log out of sequence at ${String(envelope.seq)}`);
    }
    events.push(TeamEventSchema.parse(envelope.record));
  }
  const size = torn
    ? raw.length - Buffer.byteLength(last, "utf8")
    : Buffer.byteLength(raw, "utf8");
  return { events, size };
}

export function openTeamStore(
  root: string,
  caseId: string,
  options: TeamStoreOptions = {},
): TeamStore {
  if (!PARTITION_ID.test(caseId)) {
    throw new Error(`invalid team case partition: ${caseId}`);
  }
  const sync = options.sync ?? fsyncSync;
  const dir = join(root, "cases", encodeURIComponent(caseId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, "events.jsonl");

  const replayed = replayLog(logPath);
  let seq = replayed.events.length;
  let projection = reduceTeam(replayed.events);
  // Discard a torn final record so the next append starts from a whole line.
  if (existsSize(logPath) !== replayed.size) {
    const fd = openSync(logPath, "r+");
    try {
      ftruncateSync(fd, replayed.size);
      sync(fd);
    } finally {
      closeSync(fd);
    }
  }

  const artifactRoot = join(dirname(logPath), "artifacts");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });

  return {
    caseId,
    logPath,
    artifactRoot,

    append(event: TeamEvent): AppendedEvent {
      const validated = TeamEventSchema.parse(event);
      if (validated.caseId !== caseId) {
        throw new Error(
          `event case ${validated.caseId} does not match partition ${caseId}`,
        );
      }
      const next = reduceTeam([validated], projection);
      const envelope: Envelope = { v: LOG_VERSION, seq: seq + 1, record: validated };
      const fd = openSync(logPath, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(envelope)}\n`);
        sync(fd);
      } finally {
        closeSync(fd);
      }
      seq += 1;
      projection = next;
      return { seq };
    },

    events(): TeamEvent[] {
      return replayLog(logPath).events;
    },

    load(): TeamState {
      const replay = replayLog(logPath);
      projection = reduceTeam(replay.events);
      return projection;
    },
  };
}

function existsSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
