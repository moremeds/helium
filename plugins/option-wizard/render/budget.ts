/**
 * The flash word budget — ONE copy, imported by both the renderer (which
 * enforces it) and the `flash-budget` gate (which measures it). Two copies of
 * a number that must agree is how a gate ends up certifying the thing it was
 * supposed to catch.
 *
 * Why it exists: the 2026-09-03 premarket brief shipped eleven sections of
 * 111–259 words each under a 43-word headline, against a prompt that asked for
 * five of sixty. A prompt is a request; this is arithmetic, and the model never
 * does arithmetic.
 * @module dsh-plugin-tenant-option-wizard/render/budget
 */

export const FLASH_BUDGET = {
  headlineWords: 30,
  sectionCount: 5,
  sectionBodyWords: 60,
  decisionValueWords: 25,
  rationaleWords: 40,
} as const;

/** Words are whitespace-separated runs. CJK is not word-delimited, so a run of
 *  Han characters counts as one word by this rule and 今日故事 (31 words by
 *  this measure on 2026-09-03) is under budget by construction. That is a
 *  known, accepted imprecision: the defect is 259-word English paragraphs, and
 *  a character-based CJK rule would be a second budget nobody asked for. */
export function words(text: string): number {
  return tokens(text).length;
}

function tokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== "");
}

/** A token that closes a sentence: ends in `.`, `。`, `!` or `?`, allowing a
 *  closing quote or bracket after it. A decimal (`0.75`) does not end a
 *  token with its dot and is not matched.
 *  ponytail: "U.S." also reads as a sentence end; a body cut there loses
 *  nothing the reader can act on, and an abbreviation list is a second rule. */
const SENTENCE_END = /[.。!?]["'”’)\]]*$/;

export type Cut = "none" | "sentence" | "word";

/** Cut `text` to at most `max` words.
 *
 *  Over budget, the cut lands at the LAST SENTENCE END inside the budget and
 *  nothing is appended: four complete sentences can be acted on, five and a
 *  fragment cannot, and a trailing "…" tells the reader something was taken
 *  without telling them what.
 *
 *  The word cut survives for one case: the FIRST sentence alone is over
 *  budget, so there is no sentence end to cut at. Then the text is cut at the
 *  last whole word with a trailing "…" — and `cut: "word"` reports it, because
 *  a single 90-word sentence is a different authoring failure from five
 *  sentences that ran long. */
export function trim(text: string, max: number): { text: string; cut: Cut } {
  const parts = tokens(text);
  if (parts.length <= max) return { text, cut: "none" };
  let lastEnd = -1;
  for (let i = 0; i < max; i += 1) {
    if (SENTENCE_END.test(parts[i] ?? "")) lastEnd = i;
  }
  if (lastEnd >= 0)
    return { text: parts.slice(0, lastEnd + 1).join(" "), cut: "sentence" };
  return { text: `${parts.slice(0, max).join(" ")}…`, cut: "word" };
}

export interface Overage {
  /** `headline`, `section 3`, `decision Confidence`, `rationale SPY-…` */
  what: string;
  words: number;
  limit: number;
  /** True when no sentence end falls inside the budget — the renderer will
   *  have to word-cut this one. */
  firstSentenceOver: boolean;
}

/** Measure a brief-shaped object against the budget. Unknown or missing
 *  fields are simply not measured — a step whose JSON has no `sections` is a
 *  step doing something else, not a violation. */
export function measure(doc: {
  headline?: unknown;
  sections?: unknown;
  decision?: unknown;
  candidates?: unknown;
}): { overages: Overage[]; sectionCount?: number } {
  const overages: Overage[] = [];
  const check = (what: string, text: unknown, limit: number): void => {
    if (typeof text !== "string") return;
    const n = words(text);
    if (n <= limit) return;
    overages.push({
      what,
      words: n,
      limit,
      firstSentenceOver: trim(text, limit).cut === "word",
    });
  };
  check("headline", doc.headline, FLASH_BUDGET.headlineWords);
  let sectionCount: number | undefined;
  if (Array.isArray(doc.sections)) {
    sectionCount = doc.sections.length;
    doc.sections.forEach((section: unknown, i: number) => {
      const row = (section ?? {}) as { body?: unknown };
      check(
        `section ${String(i + 1)}`,
        row.body,
        FLASH_BUDGET.sectionBodyWords,
      );
    });
  }
  if (Array.isArray(doc.decision)) {
    for (const entry of doc.decision) {
      const row = (entry ?? {}) as { label?: unknown; value?: unknown };
      check(
        `decision ${typeof row.label === "string" ? row.label : "?"}`,
        row.value,
        FLASH_BUDGET.decisionValueWords,
      );
    }
  }
  if (Array.isArray(doc.candidates)) {
    for (const entry of doc.candidates) {
      const row = (entry ?? {}) as { id?: unknown; rationale?: unknown };
      check(
        `rationale ${typeof row.id === "string" ? row.id : "?"}`,
        row.rationale,
        FLASH_BUDGET.rationaleWords,
      );
    }
  }
  return {
    overages,
    ...(sectionCount === undefined ? {} : { sectionCount }),
  };
}
