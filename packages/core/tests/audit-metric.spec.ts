/**
 * The `metric` table: one row per run per named number. Core never learns
 * what a name means — the whole point of the table is that a tenant can add
 * a number without a core edit.
 * @module core/tests/audit-metric
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AuditStore } from "../src/audit.js";

const ts = "2026-09-05T20:15:00.000Z";
const day = "2026-09-04";
// The RUN label, not the display key: `metric.label` names which of the day's
// runs wrote the number.
const label = "premarket";

describe("AuditStore metrics", () => {
  it("stores and reads back one row per name", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 3,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "beta",
      value: 0.107,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([
      { name: "alpha", value: 3 },
      { name: "beta", value: 0.107 },
    ]);
    store.close();
  });

  it("stores a null value as NULL and reads it back as null", () => {
    // "not computable this run" is a real answer and must not become 0: a
    // zero similarity and a missing prior report are different facts.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "gamma",
      value: null,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "gamma", value: null }]);
    store.close();
  });

  it("is idempotent on (run_id, name), so a second write overwrites", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 3,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 4,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "alpha", value: 4 }]);
    store.close();
  });

  it("keeps runs apart", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-2",
      name: "alpha",
      value: 2,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "alpha", value: 1 }]);
    expect(store.metrics("run-2")).toEqual([{ name: "alpha", value: 2 }]);
    store.close();
  });

  it("returns nothing for a run that wrote no metric", () => {
    const store = new AuditStore(":memory:");
    expect(store.metrics("run-nothing")).toEqual([]);
    store.close();
  });
});

describe("AuditStore metricsFor", () => {
  it("reads a day and a run label back without knowing the run id", () => {
    // The whole reason the two columns exist: a UUID is not a question anyone
    // asks, and "how did premarket score on the 4th" is.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "beta",
      value: null,
      ts,
      day,
      label,
    });
    expect(store.metricsFor(day, label)).toEqual([
      { name: "alpha", value: 1 },
      { name: "beta", value: null },
    ]);
    store.close();
  });

  it("returns only the NEWEST run when one (day, label) ran twice", () => {
    // A re-run of premarket is normal — a failed provider, a replay under a
    // different variant. Two runs' numbers averaged together are one number
    // that describes neither.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-old",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day,
      label,
    });
    store.appendMetric({
      runId: "run-new",
      name: "alpha",
      value: 9,
      ts: "2026-09-04T13:00:00.000Z",
      day,
      label,
    });
    expect(store.metricsFor(day, label)).toEqual([{ name: "alpha", value: 9 }]);
    store.close();
  });

  it("keeps two run labels on one day apart", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-2",
      name: "alpha",
      value: 2,
      ts,
      day,
      label: "close",
    });
    expect(store.metricsFor(day, "close")).toEqual([
      { name: "alpha", value: 2 },
    ]);
    store.close();
  });

  it("returns nothing for a (day, label) that never ran", () => {
    const store = new AuditStore(":memory:");
    expect(store.metricsFor("2026-01-01", "premarket")).toEqual([]);
    store.close();
  });
});

describe("AuditStore metricsBetween", () => {
  function seed(store: AuditStore): void {
    for (const [d, l, v] of [
      ["2026-08-31", "premarket", 1],
      ["2026-09-01", "close", 2],
      ["2026-09-04", "premarket", 3],
      ["2026-09-04", "close", 4],
      ["2026-09-08", "premarket", 5],
    ] as Array<[string, string, number]>)
      store.appendMetric({
        runId: `run-${d}-${l}`,
        name: "alpha",
        value: v,
        ts: `${d}T12:00:00.000Z`,
        day: d,
        label: l,
      });
  }

  it("returns the range inclusively, ordered by day then label then name", () => {
    const store = new AuditStore(":memory:");
    seed(store);
    expect(
      store
        .metricsBetween("2026-08-31", "2026-09-04")
        .map((row) => [row.day, row.label, row.value]),
    ).toEqual([
      ["2026-08-31", "premarket", 1],
      ["2026-09-01", "close", 2],
      ["2026-09-04", "close", 4],
      ["2026-09-04", "premarket", 3],
    ]);
    store.close();
  });

  it("takes only the newest run of each (day, label) in the range", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-a",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    store.appendMetric({
      runId: "run-b",
      name: "alpha",
      value: 7,
      ts: "2026-09-04T14:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    expect(store.metricsBetween("2026-09-04", "2026-09-04")).toEqual([
      { day: "2026-09-04", label: "premarket", name: "alpha", value: 7 },
    ]);
    store.close();
  });

  it("returns nothing for a range with no runs in it", () => {
    const store = new AuditStore(":memory:");
    seed(store);
    expect(store.metricsBetween("2026-09-05", "2026-09-07")).toEqual([]);
    store.close();
  });

  // The mini's audit.db predates this table. AuditStore runs SCHEMA on every
  // open (packages/core/src/audit.ts constructor), so an old file must gain
  // the table on first open with its span rows untouched.
  it("adds the metric table to a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-metric-"));
    const path = join(dir, "audit.db");
    const old = new DatabaseSync(path);
    // `tenant` and `ts` are here only because SCHEMA's span index names them;
    // the test's job is the metric table, not a faithful old span schema.
    old.exec(
      "CREATE TABLE span (run_id TEXT NOT NULL, span_id TEXT NOT NULL, tenant TEXT, ts TEXT, code_version TEXT NOT NULL DEFAULT 'unknown')",
    );
    old.exec("INSERT INTO span (run_id, span_id) VALUES ('legacy', 's1')");
    old.close();
    const store = new AuditStore(path);
    store.appendMetric({
      runId: "legacy",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    expect(store.metrics("legacy")).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
