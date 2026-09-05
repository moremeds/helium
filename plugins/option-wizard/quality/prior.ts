/**
 * The previous report on disk, and the cause title it led with.
 *
 * Reads the same `<stateRoot>/reports/option-wizard-<day>-<label>.md` files
 * delivery-markdown writes (plugins/delivery-markdown/src/channel.ts:48-62)
 * and ow_prior_brief reads. STRICTLY BEFORE this run's own (day, label): the
 * run's report is written after rendering, so it cannot read itself — but a
 * re-render of a day already on disk would, and would score 1.00 forever.
 *
 * This file is under `quality/`, not `render/`, because ordering two reports
 * within one day needs the ORDER of the day's labels, and
 * plugins/option-wizard/tests/render.spec.ts:815-841 forbids a phase name in
 * any file directly under render/.
 * @module dsh-plugin-tenant-option-wizard/quality/prior
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractJson } from "../render/json.js";

/** The order the day's runs happen in. A label not listed sorts last within
 *  its day — it is a run this list has not been taught about, and putting it
 *  after the ones it knows is the answer that cannot reorder a known pair. */
const LABEL_ORDER = ["premarket", "intraday", "close", "weekly", "frank"];

const REPORT_FILE = /^option-wizard-(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/u;
const STEP_HEADING = /^## ([a-z0-9-]+) — .*$/gmu;

/** Same resolution as the markdown channel and the CLI: HELIUM_STATE_ROOT,
 *  else `.helium-state` beside the working directory. */
export function reportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state"),
    "reports",
  );
}

function rank(label: string): number {
  const at = LABEL_ORDER.indexOf(label);
  return at === -1 ? LABEL_ORDER.length : at;
}

function stepsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const found = [...markdown.matchAll(STEP_HEADING)];
  for (let i = 0; i < found.length; i += 1) {
    const here = found[i]!;
    const start = here.index + here[0].length;
    const end = i + 1 < found.length ? found[i + 1]!.index : markdown.length;
    out.set(here[1]!, markdown.slice(start, end).trim());
  }
  return out;
}

/**
 * The lead section title of the newest report strictly before (day, label).
 * `null` for anything that is not there or cannot be parsed — a missing
 * number is a fact, and a renderer that throws costs the reader the email.
 */
export function priorCauseTitle(args: {
  dir: string;
  day: string;
  label: string;
}): string | null {
  const here = [args.day, rank(args.label)] as const;
  let best: { day: string; rank: number; file: string } | null = null;
  try {
    for (const name of readdirSync(args.dir)) {
      const match = REPORT_FILE.exec(name);
      if (match === null) continue;
      const day = match[1]!;
      const at = rank(match[2]!);
      const earlier = day < here[0] || (day === here[0] && at < here[1]);
      if (!earlier) continue;
      if (
        best === null ||
        day > best.day ||
        (day === best.day && at > best.rank)
      )
        best = { day, rank: at, file: name };
    }
  } catch {
    return null;
  }
  if (best === null) return null;
  try {
    const byStep = stepsOf(readFileSync(join(args.dir, best.file), "utf8"));
    const source = byStep.get("edit") ?? byStep.get("regime") ?? "";
    const parsed = extractJson(source);
    if (parsed === null || !Array.isArray(parsed.sections)) return null;
    const first = (parsed.sections[0] ?? {}) as { title?: unknown };
    return typeof first.title === "string" && first.title !== ""
      ? first.title
      : null;
  } catch {
    return null;
  }
}
