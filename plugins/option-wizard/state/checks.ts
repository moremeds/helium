/**
 * Yesterday's three checks, found and scored.
 *
 * **The scoring rule is deliberately crude.** A check is `hit` when the series
 * it named carries a different level today, `miss` when the level is unchanged,
 * and `not-observed` when no channel carries that series at all. It does NOT
 * read the check's English sentence for a direction: parsing a sentence into an
 * up or a down is model-arithmetic wearing a regex, which is the whole thing
 * this design removes. A cheap honest counter beats a clever wrong one, and the
 * counter is what `focusHitRate` and its neighbours are eventually measured on.
 *
 * `CheckVerdict` is named apart from the coverage `VerdictToken` on purpose:
 * they are different vocabularies, and a shared name would eventually be a
 * shared bug.
 * @module dsh-plugin-tenant-option-wizard/state/checks
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "../quality/channels.js";
import { isPriorRun, labelRank } from "../quality/prior.js";
import { parseRegimeState, type Check, type RegimeState } from "./regime.js";

export type CheckVerdict = "hit" | "miss" | "not-observed";

export interface ScoredCheck {
  series: string;
  level: string;
  text: string;
  verdict: CheckVerdict;
  today?: string;
}

const STATE_FILE = /^([a-z0-9-]+)\.regime\.json$/u;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/u;
/** The runner writes `<stateRoot>/<tenant>/<day>/<label>.<suffix>`
 *  (packages/cli/src/runner.ts, `writeStateBlock`), and `ow_review_window`
 *  already reads that same path with this same literal. */
const TENANT = "option-wizard";

/**
 * The newest regime record strictly before `(day, label)`, or `null`.
 *
 * It scans rather than walking a calendar back. A weekend and a declared closed
 * day have no record at all, so there is nothing for a calendar to skip — the
 * scan reaches Friday from Tuesday for free, and this module then needs no
 * calendar argument and no import of `tools/index.ts`.
 *
 * Never throws: a missing state root is a fact the caller prints, not an error
 * that costs the run.
 */
export function priorRecord(args: {
  stateRoot: string;
  day: string;
  label: string;
}): { day: string; label: string; state: RegimeState } | null {
  const root = join(args.stateRoot, TENANT);
  const here = [args.day, labelRank(args.label)] as const;
  let best: { day: string; label: string; rank: number; file: string } | null =
    null;
  let days: string[];
  try {
    days = readdirSync(root);
  } catch {
    return null;
  }
  for (const day of days) {
    if (!DAY_DIR.test(day)) continue;
    if (day > here[0]) continue;
    let files: string[];
    try {
      files = readdirSync(join(root, day));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = STATE_FILE.exec(file);
      if (match === null) continue;
      const label = match[1]!;
      const at = labelRank(label);
      const earlier = isPriorRun({
        candidateDay: day,
        candidateLabel: label,
        day: here[0],
        label: args.label,
      });
      if (!earlier) continue;
      if (
        best === null ||
        day > best.day ||
        (day === best.day && at > best.rank)
      ) {
        best = { day, label, rank: at, file: join(root, day, file) };
      }
    }
  }
  if (best === null) return null;
  let state: RegimeState | null;
  try {
    state = parseRegimeState(JSON.parse(readFileSync(best.file, "utf8")));
  } catch {
    return null;
  }
  return state === null
    ? null
    : { day: best.day, label: best.label, state };
}

/** Three verdicts, in the order they were written down. */
export function scoreChecks(
  checks: Check[],
  channels: Channel[],
): ScoredCheck[] {
  return checks.map((check) => {
    const hit = channels.find((channel) => channel.series === check.series);
    if (hit?.level === undefined) {
      return {
        series: check.series,
        level: check.level,
        text: check.text,
        verdict: "not-observed" as const,
      };
    }
    return {
      series: check.series,
      level: check.level,
      text: check.text,
      verdict: hit.level === check.level ? ("miss" as const) : ("hit" as const),
      today: hit.level,
    };
  });
}

/** One sentence, counted in code so the model never counts. */
export function checksLine(scored: ScoredCheck[]): string {
  if (scored.length === 0) return "Yesterday: no checks were written.";
  const hit = scored.filter((s) => s.verdict === "hit").length;
  const miss = scored.filter((s) => s.verdict === "miss").length;
  const absent = scored.filter((s) => s.verdict === "not-observed").length;
  const parts: string[] = [];
  if (hit > 0) parts.push(`${hit} hit`);
  if (miss > 0) parts.push(`${miss} missed`);
  if (absent > 0) parts.push(`${absent} not observed`);
  return `Yesterday: ${parts.join(", ")}.`;
}
