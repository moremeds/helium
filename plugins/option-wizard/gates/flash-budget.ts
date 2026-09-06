/**
 * The word budget, MEASURED. The renderer (`render/index.ts` `enforceBudget`)
 * already cuts every over-budget body back to its last sentence, so this gate
 * changes nothing the reader sees. It exists so that a prompt being ignored
 * looks different from a prompt being obeyed: a refusal here is a zero-token
 * row in the audit table naming the exact counts, and one degradation line in
 * the brief. Without it, nobody ever learns the editor is over budget, or by
 * how much.
 *
 * The runner does not discard a refused output (`runner.ts`: "a refusal here
 * does NOT discard the text"), and `editorDocFrom` is told by name that this
 * gate is advisory (`advisory: true`): the renderer trims to the same budget,
 * so a refusal is recorded but does not fail the step.
 *
 * THREE DOCUMENT SHAPES, ONE GATE, and no new gate for the other two — a gate
 * earns its keep by catching a defect, and the defect here is identical in all
 * three (a prompt asking for n words getting 3n). It branches on the SHAPE of
 * the document in front of it, never on a run label:
 *
 *   - `oneThing` present -> `measureOneThing`, switched by the SELECTION MODE
 *     the frame reported.
 *   - `review`/`coverage` present -> `measureReview`, with the caps the frame
 *     carries. Absent a frame it falls back to the STRICTER daily table: a
 *     gate that guesses the looser limit guards nothing.
 *   - `sections` present -> `measure`, exactly as before, section count rule
 *     intact.
 * @module dsh-plugin-tenant-option-wizard/gates/flash-budget
 */
import type { Gate, GateCtx } from "@helium/core";
import {
  FLASH_BUDGET,
  REVIEW_BUDGET,
  measure,
  measureOneThing,
  measureReview,
  type Overage,
  type ReviewCaps,
} from "../render/budget.js";
import { extractJson } from "../render/index.js";
import { SESSION_FRAME_KIND } from "../quality/frame.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

/** The frame this run produced, found in the run's raw tool outputs by shape.
 *  Absent on a run with no deterministic step, which is the fallback case both
 *  branches below are written for. */
function frameIn(ctx: GateCtx): {
  mode?: string;
  caps?: { weekly: ReviewCaps; daily: ReviewCaps };
} | null {
  for (const raw of ctx.toolOutputs ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if ((parsed as { kind?: unknown }).kind === SESSION_FRAME_KIND)
      return parsed as { mode?: string; caps?: { weekly: ReviewCaps; daily: ReviewCaps } };
  }
  return null;
}

/** The document carries a total word cap, so a review document's caps come
 *  from the frame when there is one. `weekly` and `daily` here are CAP TABLE
 *  names the tenant declared, not run labels: the gate cannot tell which run
 *  it is in and does not try. It takes the table whose totals the document
 *  could possibly satisfy — the larger one only when the frame said so. */
function capsFor(frame: ReturnType<typeof frameIn>, wide: boolean): ReviewCaps {
  const declared = frame?.caps;
  if (declared === undefined) return REVIEW_BUDGET.daily;
  return wide ? declared.weekly : declared.daily;
}

function report(overages: Overage[], extra: string[]): string[] {
  const parts = [...extra];
  for (const o of overages)
    parts.push(`${o.what} ${String(o.words)} of ${String(o.limit)}`);
  const single = overages.filter((o) => o.firstSentenceOver);
  if (single.length > 0)
    parts.push(
      `first sentence alone over budget, word-cut with "…": ${single.map((o) => o.what).join(", ")}`,
    );
  return parts;
}

const gate: Gate = {
  id: "flash-budget",
  phase: "output",
  advisory: true,
  // Every role that can put a measurable document into a brief.
  // `drift-watcher` and `recap-writer` were removed with the settlement steps
  // on 2026-09-05; a gate naming a role the manifest does not declare guards
  // nothing.
  appliesTo: ["editor", "regime-analyst", "weekly-analyst"],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const parsed = extractJson(textOf(input));
    if (parsed === null)
      return { pass: true, reason: "no sections to measure" };
    const frame = frameIn(ctx);

    if (parsed.oneThing !== undefined) {
      const measured = measureOneThing(parsed, frame?.mode);
      const extra: string[] = [];
      if ((measured.checkCount ?? 3) !== 3)
        extra.push(`${String(measured.checkCount)} checks of 3`);
      const parts = report(measured.overages, extra);
      return parts.length === 0
        ? { pass: true, reason: "within budget: one thing" }
        : { pass: false, reason: parts.join("; ") };
    }

    if (parsed.review !== undefined || parsed.coverage !== undefined) {
      // A document that carries the wider prose is measured against the wider
      // table when the frame declared one — the caps are data, and the frame
      // is the only thing that knows which the run asked for.
      const caps = capsFor(frame, Array.isArray(parsed.themes));
      const measured = measureReview(parsed, caps);
      const parts = report(measured.overages, []);
      return parts.length === 0
        ? {
            pass: true,
            reason: `within budget: ${String(measured.rowCount ?? 0)} coverage rows`,
          }
        : { pass: false, reason: parts.join("; ") };
    }

    if (!Array.isArray(parsed.sections))
      return { pass: true, reason: "no sections to measure" };
    const { overages, sectionCount } = measure(parsed);
    const parts: string[] = [];
    const sections = overages.filter((o) => o.what.startsWith("section "));
    if (sections.length > 0)
      parts.push(
        `${String(sections.length)} of ${String(sectionCount ?? 0)} sections over ${String(FLASH_BUDGET.sectionBodyWords)} words (${sections.map((o) => String(o.words)).join(", ")})`,
      );
    if ((sectionCount ?? 0) > FLASH_BUDGET.sectionCount)
      parts.push(
        `${String(sectionCount)} sections of ${String(FLASH_BUDGET.sectionCount)}`,
      );
    for (const o of overages.filter((o) => !o.what.startsWith("section ")))
      parts.push(`${o.what} ${String(o.words)} of ${String(o.limit)}`);
    const single = overages.filter((o) => o.firstSentenceOver);
    if (single.length > 0)
      parts.push(
        `first sentence alone over budget, word-cut with "…": ${single.map((o) => o.what).join(", ")}`,
      );
    if (parts.length === 0)
      return {
        pass: true,
        reason: `within budget: ${String(sectionCount)} sections`,
      };
    return { pass: false, reason: parts.join("; ") };
  },
};

export default gate;
