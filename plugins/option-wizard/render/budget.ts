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

// ---------------------------------------------------------------------------
// The One Thing document, and the review document
// ---------------------------------------------------------------------------

/**
 * Keyed by FIELD NAME, never by a run label. The persistence caps are a second
 * table chosen by the SELECTION MODE the tool reported, and the review caps by
 * the CAPS the tenant declared — both data handed in, not a label this module
 * learned to recognise.
 */
export const ONE_THING_BUDGET = {
  headlineWords: 14,
  oneThingWords: 180,
  changeMyMindWords: 40,
  checkWords: 15,
  checkCount: 3,
  elseLines: 5,
  elseLineWords: 12,
  rationaleWords: 25,
  proseWords: 420,
} as const;

/** Nothing stood out, so the lead item gets half the room. */
export const PERSISTENCE_BUDGET = {
  oneThingWords: 90,
  elseLines: 3,
} as const;

/**
 * Spec §J. DEFAULTS only: the live numbers come from
 * `extensions.review.caps` through the frame payload, so the tenant can move a
 * cap without a code change. They are here so a document with no frame beside
 * it is still measured against something, and the stricter table is the
 * fallback — a gate that guesses the looser limit guards nothing.
 */
export const REVIEW_BUDGET = {
  weekly: {
    review: 300,
    outlook: 400,
    catalysts: 150,
    rowWords: 15,
    focusWords: 40,
    themeWords: 25,
    total: 900,
  },
  daily: {
    review: 120,
    outlook: 180,
    catalysts: 60,
    rowWords: 10,
    focusWords: 40,
    themeWords: 25,
    total: 300,
  },
} as const;

/** The six caps `measureReview` needs. `extensions.review.caps.{weekly,daily}`
 *  parses to exactly this shape, and so does either half of REVIEW_BUDGET. */
export interface ReviewCaps {
  review: number;
  outlook: number;
  catalysts: number;
  rowWords: number;
  focusWords: number;
  themeWords: number;
}

function overage(
  what: string,
  text: unknown,
  limit: number,
  into: Overage[],
): void {
  if (typeof text !== "string") return;
  const n = words(text);
  if (n <= limit) return;
  into.push({
    what,
    words: n,
    limit,
    firstSentenceOver: trim(text, limit).cut === "word",
  });
}

/**
 * The One Thing document against its per-field caps.
 *
 * `mode` is the selection mode the frame reported — `persistence` halves the
 * lead item and cuts the else-list. It is a MODE, not a run label: nothing here
 * knows which run produced the document.
 */
export function measureOneThing(
  doc: unknown,
  mode?: string,
): { overages: Overage[]; checkCount?: number; elseCount?: number } {
  const overages: Overage[] = [];
  if (doc === null || typeof doc !== "object") return { overages };
  const row = doc as Record<string, unknown>;
  const quiet = mode === "persistence";
  overage("headline", row.headline, ONE_THING_BUDGET.headlineWords, overages);
  overage(
    "oneThing",
    row.oneThing,
    quiet ? PERSISTENCE_BUDGET.oneThingWords : ONE_THING_BUDGET.oneThingWords,
    overages,
  );
  const change = row.changeMyMind;
  if (change !== null && typeof change === "object")
    overage(
      "changeMyMind",
      (change as { text?: unknown }).text,
      ONE_THING_BUDGET.changeMyMindWords,
      overages,
    );
  let checkCount: number | undefined;
  if (Array.isArray(row.checks)) {
    checkCount = row.checks.length;
    row.checks.forEach((entry: unknown, i: number) => {
      overage(
        `check ${String(i + 1)}`,
        (entry as { text?: unknown } | null)?.text,
        ONE_THING_BUDGET.checkWords,
        overages,
      );
    });
  }
  let elseCount: number | undefined;
  if (Array.isArray(row.everythingElse)) {
    elseCount = row.everythingElse.length;
    row.everythingElse.forEach((line: unknown, i: number) => {
      overage(
        `else ${String(i + 1)}`,
        line,
        ONE_THING_BUDGET.elseLineWords,
        overages,
      );
    });
  }
  if (Array.isArray(row.rationales)) {
    for (const entry of row.rationales) {
      const cell = (entry ?? {}) as { id?: unknown; text?: unknown };
      overage(
        `rationale ${typeof cell.id === "string" ? cell.id : "?"}`,
        cell.text,
        ONE_THING_BUDGET.rationaleWords,
        overages,
      );
    }
  }
  return {
    overages,
    ...(checkCount === undefined ? {} : { checkCount }),
    ...(elseCount === undefined ? {} : { elseCount }),
  };
}

/** The review document against the caps it was handed. */
export function measureReview(
  doc: unknown,
  caps: ReviewCaps,
): { overages: Overage[]; rowCount?: number; focusCount?: number } {
  const overages: Overage[] = [];
  if (doc === null || typeof doc !== "object") return { overages };
  const row = doc as Record<string, unknown>;
  overage("review", row.review, caps.review, overages);
  overage("outlook", row.outlook, caps.outlook, overages);
  overage("catalysts", row.catalysts, caps.catalysts, overages);
  let rowCount: number | undefined;
  if (Array.isArray(row.coverage)) {
    rowCount = row.coverage.length;
    for (const entry of row.coverage) {
      const cell = (entry ?? {}) as {
        id?: unknown;
        why?: unknown;
        observable?: unknown;
      };
      const at = typeof cell.id === "string" ? cell.id : "?";
      overage(`rowWords ${at} why`, cell.why, caps.rowWords, overages);
      overage(
        `rowWords ${at} observable`,
        cell.observable,
        caps.rowWords,
        overages,
      );
    }
  }
  let focusCount: number | undefined;
  if (Array.isArray(row.focus)) {
    focusCount = row.focus.length;
    for (const entry of row.focus) {
      const cell = (entry ?? {}) as { ticker?: unknown; why?: unknown };
      overage(
        `focusWords ${typeof cell.ticker === "string" ? cell.ticker : "?"}`,
        cell.why,
        caps.focusWords,
        overages,
      );
    }
  }
  if (Array.isArray(row.themes)) {
    for (const entry of row.themes) {
      const cell = (entry ?? {}) as { id?: unknown; why?: unknown };
      overage(
        `themeWords ${typeof cell.id === "string" ? cell.id : "?"}`,
        cell.why,
        caps.themeWords,
        overages,
      );
    }
  }
  return {
    overages,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(focusCount === undefined ? {} : { focusCount }),
  };
}
