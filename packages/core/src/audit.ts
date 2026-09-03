/**
 * The audit table (design §5). Doctrine 4: token and context sense is built
 * in, not bolted on.
 *
 * One SQLite file, because the question is an aggregation with `WHERE run_id`
 * and SQLite answers it with zero infrastructure, real indexes, and readers
 * concurrent with a live run. Field names are the OpenAI-Agents-SDK span
 * names, so the shape is borrowed rather than invented.
 *
 * A row is a PROJECTION folded from the session log (`fold.ts`), never a
 * second source of truth: the log is truth, this table is a rebuildable index
 * over it. In particular it is never folded from a chars/token pressure
 * heuristic -- that is a context-pressure gauge, not billing data, and a
 * number that looks like accounting but is not would be worse than none.
 * @module @helium/core/audit
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Span {
  runId: string;
  spanId: string;
  parentSpanId?: string;
  tenant: string;
  role: string;
  /** The plugin id that ran the step. Opaque to core. */
  provider: string;
  /** The exact model route, as the plugin reported it. Opaque to core. */
  model: string;
  /**
   * Which build produced this row: the short commit sha of the deployed tree,
   * or `"unknown"` when nothing could name it. Provenance is the whole point --
   * a report nobody can tie back to a commit cannot be debugged.
   */
  codeVersion: string;
  stepNo: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextSize: number;
  latencyMs: number;
  costUsd: number;
  toolName?: string;
  toolOutputBytes?: number;
  summarised: boolean;
  ts: string;
}

/** One row of the design §5 query. */
export interface RunCostRow {
  role: string;
  provider: string;
  model: string;
  toolName: string | null;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usd: number;
  seconds: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS span (
  run_id TEXT NOT NULL,
  span_id TEXT NOT NULL, parent_span_id TEXT,
  tenant TEXT NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  code_version TEXT NOT NULL DEFAULT 'unknown',
  step_no INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, context_size INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL, cost_usd REAL NOT NULL,
  tool_name TEXT, tool_output_bytes INTEGER, summarised INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL, PRIMARY KEY (run_id, span_id));
CREATE INDEX IF NOT EXISTS span_tenant_ts ON span(tenant, ts);
`;

/** The design §5 "one query", verbatim. */
const RUN_COST_QUERY = `
SELECT role, provider, model, tool_name,
       COUNT(*) spans, SUM(input_tokens) tin, SUM(output_tokens) tout,
       SUM(cache_read_tokens) cache, SUM(cost_usd) usd, SUM(latency_ms)/1000.0 sec
FROM span WHERE run_id = ?
GROUP BY role, provider, model, tool_name
ORDER BY usd DESC`;

/**
 * `$HELIUM_AUDIT_DB`, else `~/.helium/audit.db`. Outside the deploy unit on
 * purpose: a rollback must not take the cost history with it, and the table
 * refolds from the session logs either way.
 */
export function auditDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIUM_AUDIT_DB ?? join(homedir(), ".helium", "audit.db");
}

export class AuditStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
    // audit.db outlives releases on purpose (see auditDbPath), so a database
    // written before code_version existed is the normal case, not an edge one.
    // CREATE TABLE IF NOT EXISTS silently leaves such a table alone; only an
    // ALTER adds the column, and only a table_info check keeps that ALTER from
    // throwing on every subsequent open.
    const columns = this.#db
      .prepare("PRAGMA table_info(span)")
      .all() as unknown as Array<Record<string, unknown>>;
    if (!columns.some((column) => String(column.name) === "code_version")) {
      this.#db.exec(
        "ALTER TABLE span ADD COLUMN code_version TEXT NOT NULL DEFAULT 'unknown'",
      );
    }
  }

  static open(env: NodeJS.ProcessEnv = process.env): AuditStore {
    return new AuditStore(auditDbPath(env));
  }

  /**
   * Append one step. Idempotent on `(run_id, span_id)` so re-folding a session
   * log that has grown since the last fold rewrites rather than duplicates --
   * that is what makes the table rebuildable.
   */
  append(span: Span): void {
    this.#db
      .prepare(
        `INSERT INTO span (run_id, span_id, parent_span_id, tenant, role, provider,
           model, code_version, step_no, input_tokens, output_tokens,
           cache_read_tokens,
           context_size, latency_ms, cost_usd, tool_name, tool_output_bytes,
           summarised, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, span_id) DO UPDATE SET
           parent_span_id=excluded.parent_span_id, tenant=excluded.tenant,
           role=excluded.role, provider=excluded.provider, model=excluded.model,
           code_version=excluded.code_version,
           step_no=excluded.step_no, input_tokens=excluded.input_tokens,
           output_tokens=excluded.output_tokens,
           cache_read_tokens=excluded.cache_read_tokens,
           context_size=excluded.context_size, latency_ms=excluded.latency_ms,
           cost_usd=excluded.cost_usd, tool_name=excluded.tool_name,
           tool_output_bytes=excluded.tool_output_bytes,
           summarised=excluded.summarised, ts=excluded.ts`,
      )
      .run(
        span.runId,
        span.spanId,
        span.parentSpanId ?? null,
        span.tenant,
        span.role,
        span.provider,
        span.model,
        span.codeVersion,
        span.stepNo,
        span.inputTokens,
        span.outputTokens,
        span.cacheReadTokens,
        span.contextSize,
        span.latencyMs,
        span.costUsd,
        span.toolName ?? null,
        span.toolOutputBytes ?? null,
        span.summarised ? 1 : 0,
        span.ts,
      );
  }

  appendAll(spans: Iterable<Span>): void {
    for (const span of spans) this.append(span);
  }

  /** The design §5 aggregation, as a function. */
  runCost(runId: string): RunCostRow[] {
    return (
      this.#db.prepare(RUN_COST_QUERY).all(runId) as unknown as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      role: String(row.role),
      provider: String(row.provider),
      model: String(row.model),
      toolName: row.tool_name === null ? null : String(row.tool_name),
      spans: Number(row.spans),
      inputTokens: Number(row.tin ?? 0),
      outputTokens: Number(row.tout ?? 0),
      cacheReadTokens: Number(row.cache ?? 0),
      usd: Number(row.usd ?? 0),
      seconds: Number(row.sec ?? 0),
    }));
  }

  /** Every raw span of one run, in step order. Used by the runner and tests. */
  spans(runId: string): Span[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM span WHERE run_id = ? ORDER BY step_no, span_id",
        )
        .all(runId) as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      runId: String(row.run_id),
      spanId: String(row.span_id),
      ...(row.parent_span_id === null
        ? {}
        : { parentSpanId: String(row.parent_span_id) }),
      tenant: String(row.tenant),
      role: String(row.role),
      provider: String(row.provider),
      model: String(row.model),
      codeVersion: String(row.code_version ?? "unknown"),
      stepNo: Number(row.step_no),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      contextSize: Number(row.context_size),
      latencyMs: Number(row.latency_ms),
      costUsd: Number(row.cost_usd),
      ...(row.tool_name === null ? {} : { toolName: String(row.tool_name) }),
      ...(row.tool_output_bytes === null
        ? {}
        : { toolOutputBytes: Number(row.tool_output_bytes) }),
      summarised: Number(row.summarised) === 1,
      ts: String(row.ts),
    }));
  }

  /**
   * The distinct code versions that wrote a run's rows. Normally one; more
   * than one means a deploy landed mid-run, which is exactly what this column
   * exists to make visible.
   */
  codeVersions(runId: string): string[] {
    return (
      this.#db
        .prepare(
          "SELECT DISTINCT code_version FROM span WHERE run_id = ? ORDER BY code_version",
        )
        .all(runId) as unknown as Array<Record<string, unknown>>
    ).map((row) => String(row.code_version));
  }

  /** Total USD and tokens spent so far by one run; what budget checks read. */
  spent(runId: string): { usd: number; tokens: number } {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) usd,
                COALESCE(SUM(input_tokens + output_tokens),0) tokens
         FROM span WHERE run_id = ?`,
      )
      .get(runId) as unknown as Record<string, unknown>;
    return { usd: Number(row.usd), tokens: Number(row.tokens) };
  }

  close(): void {
    this.#db.close();
  }
}
