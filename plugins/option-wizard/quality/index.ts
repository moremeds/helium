/**
 * Three numbers per run, computed in code, written to the report header and
 * to the audit table so a SELECT shows the trend. No LLM judge: eight of
 * eleven model-computed numbers audited on 2026-09-03 were wrong.
 * @module dsh-plugin-tenant-option-wizard/quality
 */
import type { RunMetric, RunReport } from "@helium/core";
import { FLASH_BUDGET, measure } from "../render/budget.js";
import { extractJson } from "../render/json.js";
import { findMetaLeaks } from "./meta-leak.js";
import { priorCauseTitle, reportsDir } from "./prior.js";
import { jaccard, wordSet } from "./similarity.js";

export { reportsDir, priorCauseTitle };

/** Only what the metrics read. Keeps this module off the BriefView type and
 *  therefore out of an import cycle with the renderer. */
export interface BriefViewLike {
  headline?: unknown;
  decision?: unknown;
  sections: Array<{ title: string; body: string }>;
}

/**
 * What `flash-budget` would refuse over, counted: one per overage the same
 * `measure()` reports, plus one if the run wrote more sections than the
 * budget allows. Read off every step whose text parses to a document with
 * `sections` — which is exactly the gate's own guard
 * (plugins/option-wizard/gates/flash-budget.ts:40-41), so the two cannot
 * disagree about what counts.
 */
export function budgetViolations(report: RunReport): number {
  let total = 0;
  for (const step of report.steps) {
    const parsed = extractJson(step.text);
    if (parsed === null || !Array.isArray(parsed.sections)) continue;
    const { overages, sectionCount } = measure(parsed);
    total += overages.length;
    if ((sectionCount ?? 0) > FLASH_BUDGET.sectionCount) total += 1;
  }
  return total;
}

/**
 * The three rows, always in this order and always all three.
 *
 * `metaLeakHits` measures the DELIVERED brief, not the gate's refusal string:
 * the gate measures what the model wrote and this measures what the reader
 * receives after the budget trim. One pattern list, one function, two
 * documents — they cannot disagree about what a leak IS.
 */
export function qualityMetrics(args: {
  view: BriefViewLike;
  report: RunReport;
  /** Injected in tests; the state root's reports directory otherwise. */
  dir?: string;
}): RunMetric[] {
  const causeTitle = args.view.sections[0]?.title ?? "";
  const prior = priorCauseTitle({
    dir: args.dir ?? reportsDir(),
    day: args.report.day,
    label: args.report.phase,
  });
  return [
    {
      name: "metaLeakHits",
      short: "leaks",
      value: findMetaLeaks(args.view).length,
    },
    {
      name: "budgetViolations",
      short: "budget",
      value: budgetViolations(args.report),
    },
    {
      name: "causeTitleSimilarity",
      short: "cause-sim",
      value:
        prior === null ? null : jaccard(wordSet(causeTitle), wordSet(prior)),
    },
  ];
}
