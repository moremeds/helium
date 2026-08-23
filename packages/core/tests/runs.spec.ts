import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlWriter } from "../src/jsonl.js";
import { RunLedger, type RunRecord } from "../src/runs.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "helium-runs-"));
}

/** Every row in the `runs` stream for one UTC day. */
function rows(dir: string, date: string): RunRecord[] {
  return readFileSync(join(dir, `runs-${date}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunRecord);
}

describe("RunLedger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start writes run_started and returns the runId", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    const runId = new RunLedger(new JsonlWriter(dir)).start(
      "macro-watch",
      "triage",
    );
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows(dir, "2026-08-23")).toEqual([
      {
        ts: "2026-08-23T10:00:00.000Z",
        runId,
        job: "macro-watch",
        tier: "triage",
        phase: "run_started",
      },
    ]);
  });

  it("finish writes the outcome row with its detail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    const ledger = new RunLedger(new JsonlWriter(dir));
    const runId = ledger.start("macro-watch", "senior");
    ledger.finish(runId, "macro-watch", "senior", "run_completed", {
      latencyMs: 2400,
    });
    expect(rows(dir, "2026-08-23")[1]).toEqual({
      ts: "2026-08-23T10:00:00.000Z",
      runId,
      job: "macro-watch",
      tier: "senior",
      phase: "run_completed",
      detail: { latencyMs: 2400 },
    });
  });

  it("reconcileStartup marks dangling run_started rows from today and yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    writeFileSync(
      join(dir, "runs-2026-08-22.jsonl"),
      `${JSON.stringify({ ts: "2026-08-22T23:50:00.000Z", runId: "r-old", job: "macro-watch", tier: "triage", phase: "run_started" })}\n`,
    );
    writeFileSync(
      join(dir, "runs-2026-08-23.jsonl"),
      [
        {
          ts: "2026-08-23T01:00:00.000Z",
          runId: "r-done",
          job: "macro-watch",
          tier: "triage",
          phase: "run_started",
        },
        {
          ts: "2026-08-23T01:00:05.000Z",
          runId: "r-done",
          job: "macro-watch",
          tier: "triage",
          phase: "run_completed",
        },
        {
          ts: "2026-08-23T02:00:00.000Z",
          runId: "r-hung",
          job: "macro-watch",
          tier: "senior",
          phase: "run_started",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const ledger = new RunLedger(new JsonlWriter(dir));
    expect(ledger.reconcileStartup()).toBe(2);
    const interrupted = rows(dir, "2026-08-23").filter(
      (row) => row.phase === "interrupted",
    );
    expect(interrupted.map((row) => row.runId).sort()).toEqual([
      "r-hung",
      "r-old",
    ]);
    expect(interrupted.map((row) => row.tier).sort()).toEqual([
      "senior",
      "triage",
    ]);
  });

  it("is idempotent — a second reconcile marks nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    writeFileSync(
      join(dir, "runs-2026-08-23.jsonl"),
      `${JSON.stringify({ ts: "2026-08-23T02:00:00.000Z", runId: "r-hung", job: "macro-watch", tier: "senior", phase: "run_started" })}\n`,
    );
    const ledger = new RunLedger(new JsonlWriter(dir));
    expect(ledger.reconcileStartup()).toBe(1);
    expect(ledger.reconcileStartup()).toBe(0);
    expect(
      rows(dir, "2026-08-23").filter((row) => row.phase === "interrupted"),
    ).toHaveLength(1);
  });

  it("ignores a torn final line instead of inventing a dangling run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    writeFileSync(
      join(dir, "runs-2026-08-23.jsonl"),
      '{"runId":"r-torn","phase":"run_st',
    );
    expect(new RunLedger(new JsonlWriter(dir)).reconcileStartup()).toBe(0);
  });
});
