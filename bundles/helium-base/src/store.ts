/**
 * One SQLite file per state root holds every queryable record: runs, the
 * per-step token spans, the decision ledger and delivery outcomes.
 * "Where did the tokens go" is one query over `spans` (doctrine 4).
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** `$HELIUM_STATE_ROOT`, else `<DSH_HOME>/helium`. A test that points
 *  DSH_HOME at a temp dir gets an isolated store without extra wiring. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIUM_STATE_ROOT ?? join(env.DSH_HOME ?? join(homedir(), ".dsh"), "helium");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, bundle TEXT NOT NULL, phase TEXT, as_of TEXT NOT NULL,
  code TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS spans (
  run_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, label TEXT,
  step INTEGER NOT NULL, model TEXT, input INTEGER NOT NULL, output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, context INTEGER NOT NULL,
  wall_ms INTEGER, cost_usd REAL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, bundle TEXT NOT NULL, run_id TEXT NOT NULL, key TEXT NOT NULL,
  as_of TEXT NOT NULL, due TEXT NOT NULL, payload TEXT NOT NULL,
  outcome TEXT, settled_run TEXT);
CREATE INDEX IF NOT EXISTS ledger_open ON ledger(bundle, due) WHERE outcome IS NULL;
CREATE TABLE IF NOT EXISTS deliveries (
  run_id TEXT NOT NULL, channel TEXT NOT NULL, state TEXT NOT NULL,
  detail TEXT, at TEXT NOT NULL);
`;

export function openStore(root: string = stateRoot()): DatabaseSync {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "helium.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export interface LedgerEntry {
  id: string;
  bundle: string;
  runId: string;
  key: string;
  asOf: string;
  due: string;
  payload: unknown;
}

export function openEntries(db: DatabaseSync, bundle: string, asOf: string): LedgerEntry[] {
  const rows = db
    .prepare(
      "SELECT id, bundle, run_id, key, as_of, due, payload FROM ledger WHERE bundle = ? AND outcome IS NULL AND due <= ? ORDER BY due, id",
    )
    .all(bundle, asOf) as Record<string, string>[];
  return rows.map((r) => ({
    id: r.id!,
    bundle: r.bundle!,
    runId: r.run_id!,
    key: r.key!,
    asOf: r.as_of!,
    due: r.due!,
    payload: JSON.parse(r.payload!),
  }));
}

/** Per-role totals for one run: the answer `helium audit <run>` prints. */
export function auditRows(db: DatabaseSync, runId: string): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT role, COALESCE(label, role) AS label, model, COUNT(*) AS steps,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write, MAX(context) AS max_context,
        SUM(wall_ms) AS wall_ms, ROUND(SUM(cost_usd), 6) AS cost_usd
       FROM spans WHERE run_id = ? GROUP BY role, label, model ORDER BY MIN(at)`,
    )
    .all(runId) as Record<string, unknown>[];
}
