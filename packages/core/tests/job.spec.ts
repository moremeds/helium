import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadJobs, parseJobYaml } from "../src/job.js";

/** A macro-watch-shaped job file, matching spec §5's example. */
const MACRO_WATCH = `
name: macro-watch
enabled: true
triggers:
  - kind: state-change
    url: http://127.0.0.1:8400/api/rates/snapshot
    fields: [regime.state, direction, confidence]
    interval: 30s
  - kind: calendar-window
    calendar: us-macro
    window: { before: 30m, after: 2h }
    interval_during: 10s
  - kind: cron
    schedule: "0 17 * * 1-5"
    tz: America/New_York
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: thesis-file
tools: [argon_api, livewire_sql]
allowMutations: false
max_turns: { triage: 2, senior: 8 }
timeout: 10m
budget: { max_triage_per_hour: 30, max_senior_per_day: 12 }
delivery:
  jsonl: true
  email: { to: operator, subject_prefix: "[helium/macro]", max_per_hour: 4 }
prompt: |
  Analyze the change.
`;

describe("parseJobYaml", () => {
  it("parses a macro-watch-shaped job and normalizes durations to ms", () => {
    const job = parseJobYaml(MACRO_WATCH, "jobs/macro-watch.yaml");
    expect(job.name).toBe("macro-watch");
    expect(job.enabled).toBe(true);
    expect(job.escalateWhen).toBe("material");
    expect(job.session).toBe("fresh");
    expect(job.memory).toBe("thesis-file");
    expect(job.tools).toEqual(["argon_api", "livewire_sql"]);
    expect(job.allowMutations).toBe(false);
    expect(job.maxTurns).toEqual({ triage: 2, senior: 8 });
    expect(job.timeoutMs).toBe(600_000);
    expect(job.budget).toEqual({ maxTriagePerHour: 30, maxSeniorPerDay: 12 });
    expect(job.delivery).toEqual({
      jsonl: true,
      email: {
        to: "operator",
        subjectPrefix: "[helium/macro]",
        maxPerHour: 4,
      },
    });
    expect(job.engine).toEqual({
      triage: { engine: "deepseek", model: "deepseek-v4-flash" },
      senior: { engine: "claude-max" },
    });
    expect(job.triggers).toEqual([
      {
        kind: "state-change",
        url: "http://127.0.0.1:8400/api/rates/snapshot",
        fields: ["regime.state", "direction", "confidence"],
        intervalMs: 30_000,
        dedupTtlMs: 21_600_000,
      },
      {
        kind: "calendar-window",
        calendar: "us-macro",
        beforeMs: 1_800_000,
        afterMs: 7_200_000,
        intervalDuringMs: 10_000,
      },
      { kind: "cron", schedule: "0 17 * * 1-5", tz: "America/New_York" },
    ]);
  });

  it("honours an explicit dedup TTL", () => {
    const job = parseJobYaml(
      MACRO_WATCH.replace("interval: 30s", "interval: 30s\n    dedup: 45m"),
      "j.yaml",
    );
    expect(job.triggers[0]).toMatchObject({ dedupTtlMs: 2_700_000 });
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseJobYaml(`${MACRO_WATCH}\nmystery: 1\n`, "jobs/bad.yaml"),
    ).toThrow(/jobs\/bad\.yaml/);
    expect(() =>
      parseJobYaml(`${MACRO_WATCH}\nmystery: 1\n`, "jobs/bad.yaml"),
    ).toThrow(/[Uu]nrecognized|[Uu]nknown/);
  });

  it("names the source file when a duration is junk", () => {
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace("interval: 30s", "interval: soon"),
        "jobs/macro-watch.yaml",
      ),
    ).toThrow(/jobs\/macro-watch\.yaml.*invalid duration/s);
  });

  it("rejects an escalate_when that is not `severity >= <severity>`", () => {
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace("severity >= material", "when it matters"),
        "j.yaml",
      ),
    ).toThrow(/escalate_when/);
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace("severity >= material", "severity >= noise"),
        "j.yaml",
      ),
    ).toThrow(/escalate_when/);
  });
});

describe("loadJobs", () => {
  it("loads every *.yaml in the directory, disabled jobs included", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-jobs-"));
    writeFileSync(join(dir, "a-macro.yaml"), MACRO_WATCH);
    writeFileSync(
      join(dir, "b-off.yaml"),
      MACRO_WATCH.replace("enabled: true", "enabled: false").replace(
        "name: macro-watch",
        "name: off-job",
      ),
    );
    writeFileSync(join(dir, "notes.md"), "# not a job");
    const jobs = loadJobs(dir);
    expect(jobs.map((job) => [job.name, job.enabled])).toEqual([
      ["macro-watch", true],
      ["off-job", false],
    ]);
  });
});
