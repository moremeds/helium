import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadJobs, parseJobYaml } from "../src/job.js";

/**
 * Task 3.2's real value-add: prove the shipped `jobs/macro-watch.yaml` still
 * parses under the real schema, not a hand-copied fixture. Catches schema
 * drift between `job.ts` and the tenant file that ships to the mini.
 */
const JOBS_DIR = fileURLToPath(new URL("../../../jobs", import.meta.url));
const JOB_FILE = fileURLToPath(
  new URL("../../../jobs/macro-watch.yaml", import.meta.url),
);

describe("jobs/macro-watch.yaml", () => {
  it("parses through parseJobYaml into the expected JobSpec shape", () => {
    const job = parseJobYaml(readFileSync(JOB_FILE, "utf8"), JOB_FILE);

    expect(job.name).toBe("macro-watch");
    expect(job.enabled).toBe(true);
    expect(job.engine).toEqual({
      triage: { engine: "deepseek", model: "deepseek-v4-flash" },
      senior: { engine: "claude-max" },
    });
    expect(job.escalateWhen).toBe("material");
    expect(job.session).toBe("fresh");
    expect(job.memory).toBe("thesis-file");
    expect(job.tools).toEqual([
      "argon_api",
      "livewire_sql",
      "thesis_read",
      "thesis_write",
    ]);
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

    // Two state-change triggers on the real argon routes (fields verified
    // live against the deployed argon over an SSH tunnel, 2026-08-24 -- see
    // the comments in jobs/macro-watch.yaml), then the calendar window and
    // the cron synthesis, in file order.
    expect(job.triggers).toEqual([
      {
        kind: "state-change",
        url: "http://127.0.0.1:8400/api/rates/snapshot",
        fields: ["state.state", "state.direction", "state.confidence"],
        intervalMs: 30_000,
        dedupTtlMs: 2_700_000,
      },
      {
        kind: "state-change",
        url: "http://127.0.0.1:8400/api/regime",
        fields: ["cri.level", "crash_trigger.fired"],
        intervalMs: 60_000,
        dedupTtlMs: 2_700_000,
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

    // Narrative-only contract and the thesis_write instruction (spec §11):
    // the prompt must tell the senior tier to update memory through the
    // gated tool, never write numbers back into argon.
    expect(job.prompt).toContain("thesis_write");
    expect(job.prompt).toContain("Narrative only");
    expect(job.prompt).toMatch(
      /never write numbers, scores or signals back into argon/,
    );
  });

  it("loads via loadJobs() as the sole enabled job in jobs/", () => {
    const jobs = loadJobs(JOBS_DIR).filter((j) => j.name === "macro-watch");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.enabled).toBe(true);
    expect(jobs[0]?.triggers.map((t) => t.kind)).toEqual([
      "state-change",
      "state-change",
      "calendar-window",
      "cron",
    ]);
  });
});
