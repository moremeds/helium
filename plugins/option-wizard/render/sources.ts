/**
 * The SOURCES block, and the rule that keeps sources out of the prose (#108
 * item 3).
 *
 * The 2026-09-03 finding was that unsourced numbers get fabricated, so every
 * figure grew an inline parenthetical: `(ow_rotation)`, `(frame sector rows,
 * as-of 2026-09-04)`, `GuruFocus (2026-09-08T21:33:48Z)`. That made the prose
 * unreadable and it made provenance a property of a SENTENCE — something a
 * model writes, and therefore something a model can write wrongly.
 *
 * This module moves provenance to where it can be computed: one block, built
 * by the renderer from the frame's own coverage table, the block as-of stamps
 * and the tools the run actually recorded. The author writes none of it. Two
 * halves, and they only ship together:
 *
 *  1. `sourcesBlock` — the block. Machine-checkable, because every line comes
 *     from a payload field rather than from a sentence.
 *  2. `stripSourceParentheticals` — the prose half. A source-shaped
 *     parenthetical is removed and recorded as a fault; a parenthetical that
 *     carries a NUMBER and no source keeps its number, because the numbers on
 *     this page are copied character-for-character and the renderer may not
 *     eat one.
 *
 * Nothing here fetches and nothing here formats a number, so it is pure and
 * the block can be tested against a frozen frame.
 * @module dsh-plugin-tenant-option-wizard/render/sources
 */

/** The tenant's tool names, as they are spelled in prose when they leak. */
export const TOOL_NAME = /\bow_[a-z0-9_]+\b/giu;

/** A zoned or bare ISO stamp standing alone inside a parenthetical — the
 *  `GuruFocus (2026-09-08T21:33:48Z)` shape. */
const LONE_STAMP =
  /^\s*\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\s*$/u;

/** What makes a parenthetical SEGMENT a source rather than a fact. Deliberately
 *  narrow: `(+5.7% vs SPY, 6 of 6 priced)` and `(2026-08-07 through
 *  2026-09-04)` are data the reader came for and must survive untouched. */
function isSourceSegment(segment: string): boolean {
  const text = segment.trim();
  if (text === "") return false;
  if (LONE_STAMP.test(text)) return true;
  if (/\bow_[a-z0-9_]+\b/iu.test(text)) return true;
  if (/\bas[- ]of\b/iu.test(text)) return true;
  if (/^(?:per|via|from|source|sourced)\b/iu.test(text)) return true;
  if (/\b(?:source|reportDate|timestamp|payload|endpoint)\b/iu.test(text))
    return true;
  if (/^frame\b/iu.test(text)) return true;
  return false;
}

export interface StripResult {
  text: string;
  /** Every parenthetical the strip changed, in its ORIGINAL spelling, so the
   *  fault can quote what the author wrote. */
  removed: string[];
}

/**
 * Prose with its source parentheticals taken out.
 *
 * Segment by segment inside each parenthetical, never the whole parenthetical
 * blind: `(9/16 hike probability 55.7, as-of 2026-09-04)` loses the stamp and
 * keeps the probability. A parenthetical left with nothing goes away entirely,
 * along with the space in front of it.
 */
export function stripSourceParentheticals(input: string): StripResult {
  if (input === "") return { text: "", removed: [] };
  const removed: string[] = [];
  const text = input.replace(/\s?\(([^()]{2,200})\)/gu, (whole, inner: string) => {
    const segments = inner.split(",");
    const kept = segments.filter((segment) => !isSourceSegment(segment));
    if (kept.length === segments.length) return whole;
    removed.push(whole.trim());
    if (kept.length === 0) return "";
    return `${whole.startsWith(" ") ? " " : ""}(${kept.join(",").trim()})`;
  });
  return { text, removed };
}

/** Every tool name the prose still names after the strip. A tool name is not a
 *  parenthetical and is not rewritten — a sentence is the author's, and
 *  rewriting one is authoring. It is faulted, and the prompt is what stops it
 *  being written. */
export function toolNamesIn(input: string): string[] {
  return [...new Set(input.match(TOOL_NAME) ?? [])];
}

/** The shape `sourcesBlock` reads. Structural only — every field is copied
 *  from a payload, never reformatted. */
export interface SourcesInput {
  coverage: ReadonlyArray<{
    layer: string;
    source: string;
    asOf?: string;
    state: "ok" | "skipped";
    reason?: string;
  }>;
  candidates?: {
    window: { start: string; end: string };
    source: string;
  };
  eventDay?: { date: string; pickedBy: string };
  /** #119. The block carries NO as-of — only the window it covers and, when
   *  the calendar could not be read at all, its own reason. Listing a stamp it
   *  does not carry would be inventing one. */
  macroReleases?: {
    weekStart: string;
    weekEnd: string;
    scheduled: number;
    printed: number;
    unavailable?: string;
  };
  /** #120. This one DOES carry an as-of and the session its percent is
   *  measured over. */
  premarketMovers?: { asOf: string; session: string };
  news?: {
    asOf: string;
    providers: ReadonlyArray<{ provider: string; published: string }>;
  };
  rotation?: { asOf: string; benchmark: string };
}

/** One line of the block, kept structured so the argon page can fold it into a
 *  real `<details>` and the email can print the same rows flat. */
export interface SourceRow {
  /** The TOOL, as the run recorded it. This is the whitelist a provenance
   *  check reads. */
  tool: string;
  what: string;
  asOf?: string;
  reason?: string;
}

/** How many distinct headline providers the block names. A citation list is a
 *  receipt, not a bibliography. */
const PROVIDER_LIMIT = 12;

/**
 * The run's sources, from the run itself.
 *
 * Order is the frame's own: the coverage table first, in declared layer order,
 * then the derived blocks. Nothing is invented — a source the run did not call
 * has no row, and a source that answered with a refusal keeps its own reason
 * instead of disappearing.
 */
export function sourcesBlock(input: SourcesInput): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const row of input.coverage)
    rows.push({
      tool: row.source,
      what: row.layer,
      ...(row.asOf === undefined ? {} : { asOf: row.asOf }),
      ...(row.state === "skipped"
        ? { reason: row.reason ?? "skipped" }
        : {}),
    });
  if (input.candidates !== undefined)
    rows.push({
      tool: "ow_stock_week",
      what: `ranked week ${input.candidates.window.start}→${input.candidates.window.end}`,
      ...(input.candidates.source === ""
        ? {}
        : { reason: input.candidates.source }),
    });
  if (input.rotation !== undefined)
    rows.push({
      tool: "ow_rotation",
      what: `rotation vs ${input.rotation.benchmark}`,
      asOf: input.rotation.asOf,
    });
  if (input.eventDay !== undefined)
    rows.push({
      tool: "ow_event_day",
      what: `event day ${input.eventDay.date}`,
      reason: input.eventDay.pickedBy,
    });
  if (input.macroReleases !== undefined) {
    const block = input.macroReleases;
    rows.push({
      tool: "ow_macro_releases",
      what:
        `releases ${block.weekStart}→${block.weekEnd} — ` +
        `${String(block.printed)} printed, ${String(block.scheduled)} scheduled`,
      ...(block.unavailable === undefined
        ? {}
        : { reason: block.unavailable }),
    });
  }
  if (input.premarketMovers !== undefined)
    rows.push({
      tool: "ow_premarket_movers",
      what: `movers, ${input.premarketMovers.session}`,
      asOf: input.premarketMovers.asOf,
    });
  if (input.news !== undefined) {
    const seen = new Map<string, string>();
    for (const row of input.news.providers)
      if (row.provider !== "" && !seen.has(row.provider))
        seen.set(row.provider, row.published);
    const providers = [...seen.entries()].slice(0, PROVIDER_LIMIT);
    rows.push({
      tool: "ow_tv_news",
      what:
        providers.length === 0
          ? "headlines"
          : `headlines — ${providers.map(([name, at]) => `${name} ${at}`).join("; ")}`,
      asOf: input.news.asOf,
    });
  }
  return rows;
}

/** The block as the email prints it: a plain section, because Gmail strips
 *  `<details>`. The argon page reads the same rows off `view.sources` and
 *  folds them. */
export function sourcesBody(rows: readonly SourceRow[]): string {
  if (rows.length === 0) return "no source was recorded for this run";
  return rows
    .map(
      (row) =>
        `- ${row.tool} · ${row.what}` +
        (row.asOf === undefined ? "" : ` · as of ${row.asOf}`) +
        (row.reason === undefined ? "" : ` · ${row.reason}`),
    )
    .join("\n");
}
