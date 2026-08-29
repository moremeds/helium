/**
 * Job files (spec §5): one git-diffable YAML per job. YAML carries human
 * durations and snake_case; `JobSpec` carries milliseconds and camelCase, so
 * nothing downstream re-parses a duration.
 * @module @helium/core/job
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { validateToolSelection } from "./tools/index.js";
import { DURATION_PATTERN, parseDuration, type Severity } from "@helium/core";

export type { Severity };

export interface TriggerStateChange {
  kind: "state-change";
  url: string;
  fields: string[];
  intervalMs: number;
  dedupTtlMs: number;
}

export interface TriggerCalendarWindow {
  kind: "calendar-window";
  calendar: string;
  beforeMs: number;
  afterMs: number;
  intervalDuringMs: number;
}

export interface TriggerCron {
  kind: "cron";
  schedule: string;
  tz: string;
}

export type Trigger = TriggerStateChange | TriggerCalendarWindow | TriggerCron;

/**
 * Task 3.6: a gated script action, run instead of the triage/senior engines
 * when a job declares `script:` (spec §10, the dsh upgrade canary). `command`
 * is absolute, or relative to the release root.
 */
export interface JobScriptAction {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface JobSpec {
  name: string;
  enabled: boolean;
  triggers: Trigger[];
  engine: {
    triage: { engine: "deepseek"; model: string };
    senior: { engine: "claude-max" };
  };
  escalateWhen: Exclude<Severity, "noise">;
  session: "fresh";
  memory: "none" | "thesis-file";
  tools: string[];
  allowMutations: boolean;
  maxTurns: { triage: number; senior: number };
  timeoutMs: number;
  budget: { maxTriagePerHour: number; maxSeniorPerDay: number };
  delivery: {
    jsonl: true;
    email?: { to: string; subjectPrefix: string; maxPerHour: number };
  };
  prompt: string;
  /**
   * Optional script action (Task 3.6). A job carrying `script` still
   * declares `engine`, `budget` and `delivery` in full — the triage/senior
   * engines are simply unused for that job; the harness routes it to the
   * script runner instead of a dsh agent turn.
   */
  script?: JobScriptAction;
}

/** Spec §8: dedup carries an explicit key and TTL; 6h when the file omits it. */
const DEFAULT_DEDUP_TTL_MS = parseDuration("6h");

/** Spec §8: schedules and calendar windows carry an explicit IANA tz (default America/New_York). */
const DEFAULT_TZ = "America/New_York";

/** A YAML duration literal, normalized to milliseconds. */
const duration = z
  .string()
  .refine(
    (value) => DURATION_PATTERN.test(value.trim()),
    "invalid duration (expected <integer><ms|s|m|h|d>, e.g. 30s)",
  )
  .transform((value) => parseDuration(value));

/** `escalate_when: severity >= material` — the only accepted form (spec §4). */
const escalateWhen = z
  .string()
  .refine(
    (value) => /^severity\s*>=\s*(minor|material|critical)$/.test(value.trim()),
    "escalate_when must read 'severity >= <minor|material|critical>'",
  )
  .transform(
    (value) =>
      /(minor|material|critical)$/.exec(value.trim())![1] as Exclude<
        Severity,
        "noise"
      >,
  );

const stateChangeYaml = z
  .object({
    kind: z.literal("state-change"),
    url: z.string().min(1),
    fields: z.array(z.string()).min(1),
    interval: duration,
    dedup: duration.optional(),
  })
  .strict();

const calendarWindowYaml = z
  .object({
    kind: z.literal("calendar-window"),
    calendar: z.string().min(1),
    window: z.object({ before: duration, after: duration }).strict(),
    interval_during: duration,
  })
  .strict();

const cronYaml = z
  .object({
    kind: z.literal("cron"),
    schedule: z.string().min(1),
    tz: z.string().min(1).optional(),
  })
  .strict();

type TriggerYaml =
  | z.infer<typeof stateChangeYaml>
  | z.infer<typeof calendarWindowYaml>
  | z.infer<typeof cronYaml>;

/** Task 3.6: `timeout` normalizes to `timeoutMs` via the shared `duration` schema, exactly like every other duration field. */
const scriptYaml = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeout: duration,
  })
  .strict();

/** Normalize one parsed YAML trigger into its `Trigger` shape. */
function toTrigger(raw: TriggerYaml): Trigger {
  switch (raw.kind) {
    case "state-change":
      return {
        kind: "state-change",
        url: raw.url,
        fields: raw.fields,
        intervalMs: raw.interval,
        dedupTtlMs: raw.dedup ?? DEFAULT_DEDUP_TTL_MS,
      };
    case "calendar-window":
      return {
        kind: "calendar-window",
        calendar: raw.calendar,
        beforeMs: raw.window.before,
        afterMs: raw.window.after,
        intervalDuringMs: raw.interval_during,
      };
    case "cron":
      return {
        kind: "cron",
        schedule: raw.schedule,
        tz: raw.tz ?? DEFAULT_TZ,
      };
  }
}

const trigger = z
  .discriminatedUnion("kind", [stateChangeYaml, calendarWindowYaml, cronYaml])
  .transform(toTrigger);

const jobYaml = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    triggers: z.array(trigger).min(1),
    engine: z
      .object({
        triage: z
          .object({ engine: z.literal("deepseek"), model: z.string().min(1) })
          .strict(),
        senior: z.object({ engine: z.literal("claude-max") }).strict(),
      })
      .strict(),
    escalate_when: escalateWhen,
    session: z.literal("fresh"),
    memory: z.enum(["none", "thesis-file"]),
    tools: z.array(z.string()),
    allowMutations: z.boolean().optional(),
    max_turns: z
      .object({
        triage: z.number().int().positive(),
        senior: z.number().int().positive(),
      })
      .strict(),
    timeout: duration,
    budget: z
      .object({
        max_triage_per_hour: z.number().int().nonnegative(),
        max_senior_per_day: z.number().int().nonnegative(),
      })
      .strict(),
    delivery: z
      .object({
        jsonl: z.literal(true),
        email: z
          .object({
            to: z.string().min(1),
            subject_prefix: z.string(),
            max_per_hour: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    prompt: z.string().min(1),
    script: scriptYaml.optional(),
  })
  .strict();

/** Rename the YAML surface to the internal `JobSpec` surface. */
function toJobSpec(raw: z.infer<typeof jobYaml>): JobSpec {
  return {
    name: raw.name,
    enabled: raw.enabled ?? true,
    triggers: raw.triggers,
    engine: raw.engine,
    escalateWhen: raw.escalate_when,
    session: raw.session,
    memory: raw.memory,
    tools: raw.tools,
    allowMutations: raw.allowMutations ?? false,
    maxTurns: { triage: raw.max_turns.triage, senior: raw.max_turns.senior },
    timeoutMs: raw.timeout,
    budget: {
      maxTriagePerHour: raw.budget.max_triage_per_hour,
      maxSeniorPerDay: raw.budget.max_senior_per_day,
    },
    delivery: {
      jsonl: true,
      ...(raw.delivery.email === undefined
        ? {}
        : {
            email: {
              to: raw.delivery.email.to,
              subjectPrefix: raw.delivery.email.subject_prefix,
              maxPerHour: raw.delivery.email.max_per_hour,
            },
          }),
    },
    prompt: raw.prompt,
    ...(raw.script === undefined
      ? {}
      : {
          script: {
            command: raw.script.command,
            args: raw.script.args,
            timeoutMs: raw.script.timeout,
          },
        }),
  };
}

/**
 * Parse one job file.
 * @param text - the YAML text.
 * @param source - the file name, included in every thrown message.
 * @returns the normalized job.
 * @throws when the YAML is malformed or violates the job schema.
 */
export function parseJobYaml(text: string, source: string): JobSpec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${source}: invalid YAML — ${(error as Error).message}`);
  }
  const result = jobYaml.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map(
        (issue) =>
          `${issue.path.join(".") === "" ? "<root>" : issue.path.join(".")}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`${source}: ${detail}`);
  }
  const spec = toJobSpec(result.data);
  // Task 3: the tool contract is enforced here, at job load, and nowhere
  // downstream. `mcp/server.ts` calls `selected()` at module top level, so the
  // same check inside selection would take the entire MCP server down instead
  // of rejecting one tenant. Reaching this throw puts the file on
  // `loadJobs()`'s onInvalid path, which skips exactly this tenant, reports it
  // on stderr, and leaves every other tenant running.
  if (spec.allowMutations) {
    throw new Error(
      `${source}: allowMutations: true is refused until a mutating provider ` +
        `contract is certified — do not advertise a no-op permission`,
    );
  }
  try {
    validateToolSelection(spec.tools, { allowMutations: spec.allowMutations });
  } catch (error) {
    throw new Error(`${source}: ${(error as Error).message}`);
  }
  return spec;
}

/**
 * Load every `*.yaml` job in a directory, in file-name order.
 * Disabled jobs are returned too; callers filter on `.enabled`.
 * @param dir - the jobs directory.
 * @returns the parsed jobs.
 */
/**
 * Load every `*.yaml` job in `dir`.
 *
 * With no `onInvalid` handler a malformed file throws, which is what
 * `deploy.sh`'s pre-flip gate wants: a typo fails the DEPLOY while `current`
 * still points at the previous release, so a human sees it immediately.
 *
 * With a handler, the bad file is skipped and reported and the healthy jobs
 * still load. That is what the running daemon wants. Before this existed, one
 * malformed file threw here, which aborted the plugin's `apply()`, which killed
 * the dsh process -- so a single typo in a single tenant took EVERY other tenant
 * down, and launchd's KeepAlive turned it into a crash loop rather than a stable
 * failure. Observed on the mini during the 3.7 AC#2 drill: a stray `dedup_ttl:`
 * key froze the heartbeat for 2m12s across all jobs.
 *
 * The handler is not optional decoration -- a silently skipped tenant is its own
 * hazard, so the caller is expected to make the skip loud.
 */
export function loadJobs(
  dir: string,
  onInvalid?: (path: string, error: Error) => void,
): JobSpec[] {
  const jobs: JobSpec[] = [];
  for (const entry of readdirSync(dir)
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()) {
    const path = join(dir, entry);
    try {
      jobs.push(parseJobYaml(readFileSync(path, "utf8"), path));
    } catch (err) {
      if (!onInvalid) throw err;
      onInvalid(path, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return jobs;
}
