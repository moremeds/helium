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

  it("defaults a cron trigger's tz to America/New_York when omitted", () => {
    const job = parseJobYaml(
      MACRO_WATCH.replace("\n    tz: America/New_York", ""),
      "j.yaml",
    );
    expect(job.triggers[2]).toEqual({
      kind: "cron",
      schedule: "0 17 * * 1-5",
      tz: "America/New_York",
    });
  });

  it("parses a job carrying a script block, normalizing its timeout to ms", () => {
    const job = parseJobYaml(
      `${MACRO_WATCH}\nscript:\n  command: /opt/helium/scripts/canary/run.sh\n  args: ["--flag"]\n  timeout: 40m\n`,
      "jobs/dsh-canary.yaml",
    );
    expect(job.script).toEqual({
      command: "/opt/helium/scripts/canary/run.sh",
      args: ["--flag"],
      timeoutMs: 2_400_000,
    });
  });

  it("defaults a script block's args to [] when omitted", () => {
    const job = parseJobYaml(
      `${MACRO_WATCH}\nscript:\n  command: /opt/helium/scripts/canary/run.sh\n  timeout: 40m\n`,
      "j.yaml",
    );
    expect(job.script?.args).toEqual([]);
  });

  it("omits script entirely from a job that does not declare one", () => {
    const job = parseJobYaml(MACRO_WATCH, "jobs/macro-watch.yaml");
    expect(job.script).toBeUndefined();
  });

  it("a script job still requires engine, budget and delivery — none become optional", () => {
    const withScript = `${MACRO_WATCH}\nscript:\n  command: /opt/helium/scripts/canary/run.sh\n  timeout: 40m\n`;
    const noBudget = withScript
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("budget:") &&
          !line.startsWith("  max_triage") &&
          !line.startsWith("  max_senior"),
      )
      .join("\n");
    expect(() => parseJobYaml(noBudget, "j.yaml")).toThrow(/budget/);

    const noEngine = withScript.replace(
      /engine:\n  triage:.*\n  senior:.*\n/,
      "",
    );
    expect(() => parseJobYaml(noEngine, "j.yaml")).toThrow(/engine/);
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

  // A malformed job file used to abort the whole load, which aborted the plugin's
  // apply(), which killed the dsh process -- so ONE typo in ONE tenant took every
  // other tenant down and launchd's KeepAlive turned it into a crash loop. Seen on
  // the mini during the 3.7 AC#2 drill: a stray `dedup_ttl:` key froze the
  // heartbeat for over two minutes across all jobs.
  it("keeps the healthy jobs when one file is malformed, and reports the bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-jobs-bad-"));
    writeFileSync(join(dir, "a-macro.yaml"), MACRO_WATCH);
    writeFileSync(
      join(dir, "b-broken.yaml"),
      MACRO_WATCH.replace("interval: 30s", "interval: 30s\n    dedup_ttl: 10m"),
    );
    const seen: string[] = [];
    const jobs = loadJobs(dir, (path, err) => {
      seen.push(`${path.split("/").pop()}: ${err.message}`);
    });
    expect(jobs.map((job) => job.name)).toEqual(["macro-watch"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/b-broken\.yaml/);
    expect(seen[0]).toMatch(/dedup_ttl|Unrecognized key/);
  });

  // Without a handler it still throws: deploy.sh's pre-flip gate calls it that way
  // precisely so a bad job file fails the DEPLOY, while `current` still points at
  // the previous release. Loud at deploy time, degraded-but-alive at runtime.
  it("still throws when no handler is supplied, so the deploy gate can reject", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-jobs-throw-"));
    writeFileSync(
      join(dir, "broken.yaml"),
      MACRO_WATCH.replace("interval: 30s", "interval: 30s\n    dedup_ttl: 10m"),
    );
    expect(() => loadJobs(dir)).toThrow(/broken\.yaml/);
  });
});

// Task 3: the tool contract is validated at JOB LOAD, against the tool
// vocabulary — every name the build knows about — not against the catalog this
// environment happens to have configured. Doing it here rather than inside
// selected() is load-bearing: mcp/server.ts calls selected() at module top
// level, so a throw from there kills the whole MCP server and the senior lane
// loses EVERY tool instead of one capability. Here, loadJobs()'s existing
// handler path rejects only the affected tenant and reports it.
describe("job-load tool contract", () => {
  it("rejects a misspelled capability, naming it", () => {
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace(
          "tools: [argon_api, livewire_sql]",
          "tools: [argon_api, livewyre_sql]",
        ),
        "jobs/macro-watch.yaml",
      ),
    ).toThrow(/unknown tools: livewyre_sql/);
  });

  it("accepts livewire_sql even though no lake is configured in this process", () => {
    // The shipped macro-watch job declares it; livewireTools() returns [] here.
    // A catalog-based check would reject the real production job as a typo.
    expect(() => parseJobYaml(MACRO_WATCH, "jobs/macro-watch.yaml")).not.toThrow();
  });

  it("rejects a mutating tool that the job does not permit", () => {
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace(
          "tools: [argon_api, livewire_sql]",
          "tools: [argon_api, argon_rescan]",
        ),
        "jobs/macro-watch.yaml",
      ),
    ).toThrow(/require mutation permission: argon_rescan/);
  });

  // No mutating provider contract is certified at P0, so the flag would be a
  // no-op that reads as a granted permission. Reject it rather than advertise
  // it. (Every shipped job sets `allowMutations: false` today, verified across
  // jobs/*.yaml, so this rejects nothing in production.)
  it("rejects allowMutations: true until a mutating provider contract is certified", () => {
    expect(() =>
      parseJobYaml(
        MACRO_WATCH.replace("allowMutations: false", "allowMutations: true"),
        "jobs/macro-watch.yaml",
      ),
    ).toThrow(/allowMutations/);
  });

  // The whole point of validating at load: one bad tenant, not all of them.
  it("rejects only the tenant with the bad capability and keeps the others running", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-jobs-tool-"));
    writeFileSync(join(dir, "a-macro.yaml"), MACRO_WATCH);
    writeFileSync(
      join(dir, "b-typo.yaml"),
      MACRO_WATCH.replace("name: macro-watch", "name: typo-watch").replace(
        "tools: [argon_api, livewire_sql]",
        "tools: [argon_api, livewyre_sql]",
      ),
    );
    const seen: string[] = [];
    const jobs = loadJobs(dir, (path, err) => {
      seen.push(`${path.split("/").pop()}: ${err.message}`);
    });
    expect(jobs.map((job) => job.name)).toEqual(["macro-watch"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/b-typo\.yaml/);
    expect(seen[0]).toMatch(/unknown tools: livewyre_sql/);
  });
});
