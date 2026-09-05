/**
 * The weekly review's data. Every number in it is read off a file or off the
 * audit table; the model that reads the result computes nothing.
 * @module dsh-plugin-tenant-option-wizard/tests/tools-review-window
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "@helium/core";
import { describe, expect, it } from "vitest";
import { buildTools, isClosedDay, openDaysBack } from "../tools/index.js";

// Labor Day 2026 and the NYSE list this tenant declares.
const CALENDAR = { weekdaysOnly: true, closed: ["2026-09-07"] };

/** A throwaway audit database the tool will find through cfg.env. */
function auditDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ow-review-db-")), "audit.db");
}

function seedMetrics(
  dbPath: string,
  day: string,
  label: string,
  values: Record<string, number | null>,
): void {
  const store = new AuditStore(dbPath);
  for (const [name, value] of Object.entries(values))
    store.appendMetric({
      runId: `run-${day}-${label}`,
      name,
      value,
      ts: `${day}T20:00:00.000Z`,
      day,
      label,
    });
  store.close();
}

function report(
  stateRoot: string,
  day: string,
  label: string,
  title: string,
): void {
  const dir = join(stateRoot, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `option-wizard-${day}-${label}.md`),
    [
      `# [TEST] ${label} ${day}`,
      "",
      "## edit — editor",
      "",
      JSON.stringify({
        headline: "h",
        sections: [{ title, body: "b" }],
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}

function state(stateRoot: string, day: string, label: string, cause: string) {
  const dir = join(stateRoot, "option-wizard", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${label}.regime.json`),
    JSON.stringify({ cause, tide: "up", thesis: "t" }),
    "utf8",
  );
}

describe("openDaysBack", () => {
  it("counts trading days, oldest first, skipping the weekend", () => {
    expect(openDaysBack("2026-09-04", 5, CALENDAR)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("starts from the previous open day when the run day is closed", () => {
    // Sunday 2026-09-06: the weekly run's own day is not a session.
    expect(openDaysBack("2026-09-06", 2, CALENDAR)).toEqual([
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("skips a declared holiday", () => {
    expect(isClosedDay("2026-09-07", CALENDAR)).toBe(true);
    expect(openDaysBack("2026-09-08", 2, CALENDAR)).toEqual([
      "2026-09-04",
      "2026-09-08",
    ]);
  });
});

describe("ow_review_window", () => {
  function tool(stateRoot: string, dbPath = auditDb()) {
    return buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: dbPath },
      variant: "live",
      calendar: CALENDAR,
      extensions: { review: { windows: [5, 10, 21] } },
    }).find((entry) => entry.name === "ow_review_window")!;
  }

  it("returns one block per declared window, with the 5-day window naming exactly 08-31..09-04", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows.map((w: { days: number }) => w.days)).toEqual([
      5, 10, 21,
    ]);
    expect(out.windows[0].sessions.map((s: { day: string }) => s.day)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    expect(out.windows[0].from).toBe("2026-08-31");
    expect(out.windows[0].to).toBe("2026-09-04");
  });

  it("carries each session's cause titles, regime record and quality numbers", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const dbPath = auditDb();
    report(stateRoot, "2026-09-04", "close", "August payrolls printed 162k");
    state(stateRoot, "2026-09-04", "close", "August payrolls printed 162k");
    seedMetrics(dbPath, "2026-09-04", "close", {
      metaLeakHits: 1,
      budgetViolations: 0,
      causeTitleSimilarity: 0.107,
    });
    const out = JSON.parse(
      await tool(stateRoot, dbPath).run({ today: "2026-09-04" }),
    );
    const friday = out.windows[0].sessions.find(
      (s: { day: string }) => s.day === "2026-09-04",
    );
    expect(friday.causeTitles.close).toBe("August payrolls printed 162k");
    expect(friday.regime.close.cause).toBe("August payrolls printed 162k");
    // Straight out of the metric table, keyed by (day, label) — not parsed
    // back out of the rendered report header.
    expect(friday.quality.close).toEqual({
      metaLeakHits: 1,
      budgetViolations: 0,
      causeTitleSimilarity: 0.107,
    });
  });

  it("reads only the newest run when a (day, label) ran twice", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const dbPath = auditDb();
    const store = new AuditStore(dbPath);
    store.appendMetric({
      runId: "run-first",
      name: "metaLeakHits",
      value: 4,
      ts: "2026-09-04T18:00:00.000Z",
      day: "2026-09-04",
      label: "close",
    });
    store.appendMetric({
      runId: "run-second",
      name: "metaLeakHits",
      value: 0,
      ts: "2026-09-04T21:00:00.000Z",
      day: "2026-09-04",
      label: "close",
    });
    store.close();
    const out = JSON.parse(
      await tool(stateRoot, dbPath).run({ today: "2026-09-04" }),
    );
    const friday = out.windows[0].sessions.find(
      (s: { day: string }) => s.day === "2026-09-04",
    );
    expect(friday.quality.close).toEqual({ metaLeakHits: 0 });
  });

  it("names a session with nothing recorded rather than dropping it", async () => {
    // A day with no report is a day the run did not produce one, and that is
    // the finding. Dropping it would make a broken week look like a short one.
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows[0].sessions[0]).toEqual({
      day: "2026-08-31",
      causeTitles: {},
      regime: {},
      quality: {},
    });
  });

  it("notes the ledger as unavailable rather than failing", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows[0].ledger).toBe(null);
    expect(out.windows[0].coverage.join(" ")).toContain("ledger");
  });

  it("notes an unreadable audit database rather than failing", async () => {
    // A laptop with no audit.db, or a path the process cannot open, still gets
    // its cause titles and its regime records. A review that refuses to run
    // because one of its three inputs is missing is a review that never runs.
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    // A FILE where a directory has to be. `AuditStore`'s constructor mkdir -p's
    // the parent, so a merely absent directory is not unopenable; a plain file
    // in the way is (ENOTDIR), and that is the shape of the real failure — a
    // laptop whose ~/.helium is not what the code assumes.
    writeFileSync(join(stateRoot, "not-a-dir"), "", "utf8");
    const bad = buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: join(stateRoot, "not-a-dir", "audit.db") },
      variant: "live",
      calendar: CALENDAR,
    }).find((entry) => entry.name === "ow_review_window")!;
    const out = JSON.parse(await bad.run({ today: "2026-09-04" }));
    expect(out.windows[0].sessions).toHaveLength(5);
    expect(out.windows[0].coverage.join(" ")).toContain("quality unavailable");
  });

  it("falls back to 5/10/21 when the tenant declares no windows", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const bare = buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: auditDb() },
      variant: "live",
      calendar: CALENDAR,
    }).find((entry) => entry.name === "ow_review_window")!;
    const out = JSON.parse(await bare.run({ today: "2026-09-04" }));
    expect(out.windows.map((w: { days: number }) => w.days)).toEqual([
      5, 10, 21,
    ]);
  });
});
