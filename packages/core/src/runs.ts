/**
 * Two-phase run accounting (spec §8): `run_started` then exactly one outcome.
 * Startup reconciliation turns rows left dangling by a kill or a sleep into
 * `interrupted`, which is what makes the §13 kill-test mechanically possible.
 * @module @helium/core/runs
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlWriter, jsonlFileName } from "./jsonl.js";

export type RunOutcome =
  "run_completed" | "run_failed" | "timed_out" | "interrupted";

export interface RunRecord {
  runId: string;
  job: string;
  tier: "triage" | "senior";
  phase: "run_started" | RunOutcome;
  ts: string;
  detail?: Record<string, unknown>;
}

/** The stream every run row lands in. */
const RUNS_STREAM = "runs";

/** Phases that close a run. `interrupted` closes it too, which is what makes reconcile idempotent. */
const TERMINAL: ReadonlySet<string> = new Set<RunOutcome>([
  "run_completed",
  "run_failed",
  "timed_out",
  "interrupted",
]);

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Appends run rows to the `runs` JSONL stream and reconciles them at startup. */
export class RunLedger {
  private readonly writer: JsonlWriter;

  constructor(writer: JsonlWriter) {
    this.writer = writer;
  }

  /**
   * Open a run.
   * @param job - the job name.
   * @param tier - which lane is running.
   * @returns the new run id.
   */
  start(job: string, tier: "triage" | "senior"): string {
    const runId = randomUUID();
    this.writer.append(RUNS_STREAM, {
      runId,
      job,
      tier,
      phase: "run_started",
    });
    return runId;
  }

  /**
   * Close a run with its outcome.
   * @param runId - the id `start()` returned.
   * @param job - the job name.
   * @param tier - which lane ran.
   * @param outcome - how the run ended.
   * @param detail - optional structured context (never secrets).
   */
  finish(
    runId: string,
    job: string,
    tier: "triage" | "senior",
    outcome: RunOutcome,
    detail?: Record<string, unknown>,
  ): void {
    this.writer.append(
      RUNS_STREAM,
      detail === undefined
        ? { runId, job, tier, phase: outcome }
        : { runId, job, tier, phase: outcome, detail },
    );
  }

  /**
   * Close every run left open by a kill, a crash, or a machine sleep.
   * @returns how many runs were marked `interrupted`.
   */
  reconcileStartup(): number {
    const open = new Map<string, RunRecord>();
    for (const record of this.recentRuns()) {
      if (record.phase === "run_started") {
        open.set(record.runId, record);
        continue;
      }
      if (TERMINAL.has(record.phase)) open.delete(record.runId);
    }
    for (const record of open.values()) {
      this.writer.append(RUNS_STREAM, {
        runId: record.runId,
        job: record.job,
        tier: record.tier,
        phase: "interrupted",
        detail: { startedAt: record.ts },
      });
    }
    return open.size;
  }

  /** Every parsable run row from yesterday's and today's UTC files, in order. */
  private recentRuns(): RunRecord[] {
    const now = Date.now();
    const records: RunRecord[] = [];
    for (const at of [new Date(now - DAY_MS), new Date(now)]) {
      let text: string;
      try {
        text = readFileSync(
          join(this.writer.dir, jsonlFileName(RUNS_STREAM, at)),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let record: RunRecord;
        try {
          record = JSON.parse(line) as RunRecord;
        } catch {
          // A torn final line is an incomplete write, not a dangling run.
          continue;
        }
        if (
          typeof record.runId === "string" &&
          typeof record.phase === "string"
        ) {
          records.push(record);
        }
      }
    }
    return records;
  }
}
