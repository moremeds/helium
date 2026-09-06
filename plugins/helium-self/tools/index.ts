/**
 * The check half of the loop: settle an experiment commitment from argon's own
 * Postgres, deterministically. No model is involved in settlement, and no
 * threshold is hardcoded here — every number the verdict turns on is read back
 * out of the payload that was written at mint time.
 *
 * This tenant ships no tools: its one model step has `tools: []`, because a
 * step that could reach the database could also talk itself into a verdict.
 * @module dsh-plugin-tenant-helium-self/tools
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  Commitment,
  Receipt,
  Settler,
  ToolVocabularyEntry,
} from "@helium/core";

const execFileAsync = promisify(execFile);

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map();

export function buildTools(_cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
}): [] {
  return [];
}

/** One `SELECT`, already wrapped in `json_agg` by the caller. */
export type Query = (sql: string) => Promise<unknown[]>;

/**
 * The two metric keys the verdict reads, verified against
 * `uw_scan.backtest_sweep_results` run_id=3 on 2026-09-06: a cell is
 * `config = {"h": ..., "origin": ...}` and `metrics` is a flat object holding,
 * among ~50 others, `pinball_ratio_q05` (model pinball at q05 over the EWMA
 * baseline's) and `pinball_mean` (the model's own mean pinball, not a ratio).
 */
const RATIO_KEY = "pinball_ratio_q05";
const MEAN_KEY = "pinball_mean";

/** The pooled-horizon cell. Stored as the STRING "all" beside integer h
 *  values in the same jsonb column, so `config->>'h'` is the comparison that
 *  works for both. */
const POOLED_H = "all";

interface Cell {
  id: number;
  run_id: number;
  origin: string;
  h: string;
  ratio: number;
  mean: number;
}

interface Thresholds {
  improveIfDeltaAtMost: number;
  regressIfDeltaAbove: number;
}

/** A jsonb string that will be pasted into a single `-c` statement. Rejects
 *  rather than escapes: every value this settler interpolates comes from a
 *  committed payload, so anything outside this alphabet is a corrupted
 *  declaration, not an input to be sanitised. */
function literal(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw))
    throw new Error(`${field}: ${JSON.stringify(raw)} is not a value this settler will pass on`);
  return `'${raw}'`;
}

function integer(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error(`${field}: ${JSON.stringify(raw)} is not a run id`);
  return raw;
}

function number(raw: unknown, field: string): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field}: ${JSON.stringify(raw)} is not a number`);
  return value;
}

function thresholds(payload: Record<string, unknown>): Thresholds {
  const metrics = payload.metrics;
  if (metrics === null || typeof metrics !== "object")
    throw new Error("payload.metrics missing");
  const block = metrics as Record<string, Record<string, unknown>>;
  return {
    improveIfDeltaAtMost: number(
      block.q05PinballRatio?.improveIfDeltaAtMost,
      "metrics.q05PinballRatio.improveIfDeltaAtMost",
    ),
    regressIfDeltaAbove: number(
      block.meanPinball?.regressIfDeltaAbove,
      "metrics.meanPinball.regressIfDeltaAbove",
    ),
  };
}

/**
 * improved / flat / regressed, from the payload's own thresholds.
 *
 * The regression trigger for the ratio is the MAGNITUDE of the improvement
 * threshold, because the declaration states one number and applies it in both
 * directions ("drops by >= 0.03" / "rises by > 0.03"); reading it off the same
 * field is what keeps the two halves of the rule from drifting apart.
 */
export function verdict(
  deltaRatio: number,
  deltaMean: number,
  rule: Thresholds,
): "improved" | "flat" | "regressed" {
  const band = Math.abs(rule.improveIfDeltaAtMost);
  if (deltaRatio > band || deltaMean > rule.regressIfDeltaAbove)
    return "regressed";
  if (deltaRatio <= rule.improveIfDeltaAtMost && deltaMean <= rule.regressIfDeltaAbove)
    return "improved";
  return "flat";
}

function cellOf(rows: readonly unknown[], runId: number): Cell | undefined {
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    if (integer(record.run_id, "run_id") !== runId) continue;
    return {
      id: integer(record.id, "id"),
      run_id: runId,
      origin: String(record.origin),
      h: String(record.h),
      ratio: number(record.ratio, RATIO_KEY),
      mean: number(record.mean, MEAN_KEY),
    };
  }
  return undefined;
}

/** sha256 over the exact cells the verdict used, key-sorted and run-ordered, so
 *  a later repair of either sweep row is detectable from the receipt alone. */
export function evidenceHash(cells: readonly Cell[]): string {
  const canonical = [...cells]
    .sort((a, b) => a.id - b.id)
    .map((cell) => ({
      h: cell.h,
      id: cell.id,
      mean: cell.mean,
      origin: cell.origin,
      ratio: cell.ratio,
      run_id: cell.run_id,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function pending(id: string, now: Date, detail: string): Receipt {
  return {
    commitmentId: id,
    runId: "",
    settledAt: now.toISOString(),
    // The ONE word core understands: the commitment stays outstanding and the
    // next run is offered it again.
    status: "pending",
    scores: {},
    detail: { reason: detail },
  };
}

export async function settleCommitment(
  commitment: Commitment,
  now: Date,
  query: Query,
): Promise<Receipt> {
  const payload = commitment.payload as Record<string, unknown>;
  const baselineRun = integer(payload.baselineSweepRun, "baselineSweepRun");
  const holdout = (payload.holdout ?? {}) as Record<string, unknown>;
  const origin = literal(holdout.origin, "holdout.origin");
  const rule = thresholds(payload);

  let candidateRun: number;
  if (payload.candidateSweepRun === null || payload.candidateSweepRun === undefined) {
    const strategy = literal(
      payload.candidateSweepStrategy,
      "candidateSweepStrategy",
    );
    const found = await query(
      `SELECT id FROM uw_scan.backtest_sweep_runs WHERE strategy = ${strategy} ORDER BY id DESC LIMIT 1`,
    );
    const first = found[0] as Record<string, unknown> | undefined;
    if (first === undefined)
      return pending(
        commitment.id,
        now,
        `no sweep run with strategy ${strategy}; the change has not been run yet`,
      );
    candidateRun = integer(first.id, "candidate run id");
  } else {
    candidateRun = integer(payload.candidateSweepRun, "candidateSweepRun");
  }

  const rows = await query(
    `SELECT id, run_id, config->>'origin' AS origin, config->>'h' AS h,` +
      ` (metrics->>'${RATIO_KEY}')::float8 AS ratio,` +
      ` (metrics->>'${MEAN_KEY}')::float8 AS mean` +
      ` FROM uw_scan.backtest_sweep_results` +
      ` WHERE run_id IN (${String(baselineRun)}, ${String(candidateRun)})` +
      ` AND config->>'origin' = ${origin} AND config->>'h' = '${POOLED_H}'` +
      ` ORDER BY id`,
  );
  const baseline = cellOf(rows, baselineRun);
  const candidate = cellOf(rows, candidateRun);
  if (baseline === undefined || candidate === undefined) {
    return pending(
      commitment.id,
      now,
      `holdout cell (origin=${origin}, h=${POOLED_H}) missing for run ` +
        `${baseline === undefined ? String(baselineRun) : String(candidateRun)}`,
    );
  }

  const deltaRatio = candidate.ratio - baseline.ratio;
  const deltaMean = candidate.mean - baseline.mean;
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: verdict(deltaRatio, deltaMean, rule),
    scores: {
      deltaQ05PinballRatio: deltaRatio,
      deltaMeanPinball: deltaMean,
      baselineQ05PinballRatio: baseline.ratio,
      candidateQ05PinballRatio: candidate.ratio,
      baselineMeanPinball: baseline.mean,
      candidateMeanPinball: candidate.mean,
    },
    evidenceHash: evidenceHash([baseline, candidate]),
    detail: {
      baselineRun,
      candidateRun,
      rowIds: [baseline.id, candidate.id],
    },
  };
}

/**
 * Read-only query against argon's Postgres through psql — the same shape
 * option-wizard's `pgJson` uses, and for the same reason: a handful of SELECTs
 * a day does not earn a driver and a connection pool. `ON_ERROR_STOP` plus
 * `--single-transaction` makes a broken query fail instead of returning a
 * partial set, and the libpq URL keeps the credential in the environment.
 */
function psqlQuery(env: Record<string, string | undefined>): Query {
  return async (sql: string): Promise<unknown[]> => {
    const url = env.OW_ARGON_PG_URL;
    if (url === undefined || url === "")
      throw new Error("OW_ARGON_PG_URL is unset; cannot settle");
    const { stdout } = await execFileAsync(
      env.OW_PSQL_BIN ?? "psql",
      [
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "-At",
        "-c",
        `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q`,
        url,
      ],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  };
}

/** The experiment kind this settler knows. Anything else in the ledger belongs
 *  to a different promise and is left outstanding untouched. */
const KIND = "argon-sweep-compare";

export function buildSettler(
  cfg: {
    stateRoot: string;
    env: Record<string, string | undefined>;
    variant: string;
    asOf?: Date;
    calendar?: { weekdaysOnly: boolean; closed: string[] };
  },
  query: Query = psqlQuery(cfg.env),
): Settler {
  return {
    async settle(open: Commitment[], now: Date): Promise<Receipt[]> {
      const receipts: Receipt[] = [];
      for (const commitment of open) {
        const payload = commitment.payload as Record<string, unknown> | null;
        if (payload === null || payload.kind !== KIND) continue;
        try {
          receipts.push(await settleCommitment(commitment, now, query));
        } catch (error: unknown) {
          // One unsettleable promise must not cost the others their turn: the
          // runner records a thrown settler as a skipped settlement for the
          // WHOLE run, which would hide every verdict behind one bad row.
          receipts.push(
            pending(
              commitment.id,
              now,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
      return receipts;
    },
  };
}
