/**
 * The One Thing document: what the editor returns, parsed and reported on.
 *
 * SCHEMA HALF. Nothing here renders, writes a file or reads a run label — it
 * takes the editor's JSON and answers two questions: what came back, and what
 * is wrong with it. A missing or malformed field is a PROBLEM STRING, never a
 * throw and never a padded value: the document still renders, and the renderer
 * prints one flag line per problem beside the section it belongs to.
 *
 * **The four beats of `oneThing` are ordered so the trim takes the right
 * thing.** `trim()` cuts at the last sentence end inside the budget, so
 * whichever beat is written LAST is the one that disappears when the paragraph
 * runs long. What moved comes first, why this one second, the mechanism third
 * and who is hurt last — because a reader who loses the fourth beat still has
 * a usable item, and one who loses the first has nothing.
 * @module dsh-plugin-tenant-option-wizard/render/one-thing
 */

export interface Invalidation {
  text: string;
  series: string;
  threshold: string;
  horizon: string;
}

export interface OneThingCheck {
  series: string;
  level: string;
  text: string;
}

export interface OneThingDoc {
  headline: string;
  /** Four beats in order: what moved · why this one (the renderer's supplied
   *  phrase) · mechanism · who is hurt. */
  oneThing: string;
  /** Dropped wholesale when the triple is incomplete — never padded. */
  changeMyMind?: Invalidation;
  checks: OneThingCheck[];
  everythingElse: string[];
  rationales: Array<{ id: string; text: string }>;
}

/** Exactly three checks, because the next run scores exactly three. */
const CHECKS = 3;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Parse an editor document. Returns whatever was well-formed plus one problem
 * string per fault. `null` only when the input is not an object at all.
 */
export function parseOneThingDoc(value: unknown): {
  doc: OneThingDoc | null;
  problems: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { doc: null, problems: ["document is not an object"] };
  const row = value as Record<string, unknown>;
  const problems: string[] = [];

  const headline = text(row.headline);
  if (headline === undefined) problems.push("headline: missing");
  const oneThing = text(row.oneThing);
  if (oneThing === undefined) problems.push("oneThing: missing");

  let changeMyMind: Invalidation | undefined;
  const change = row.changeMyMind;
  if (change !== undefined && change !== null && typeof change === "object") {
    const cell = change as Record<string, unknown>;
    const missing = (
      ["text", "series", "threshold", "horizon"] as const
    ).filter((key) => text(cell[key]) === undefined);
    if (missing.length === 0) {
      changeMyMind = {
        text: cell.text as string,
        series: cell.series as string,
        threshold: cell.threshold as string,
        horizon: cell.horizon as string,
      };
    } else {
      // The whole object goes, and the renderer prints one flag line. A view
      // with a price that kills it is only useful if all three of the price,
      // the series and the deadline are there.
      problems.push(`changeMyMind: missing ${missing.join(", ")}`);
    }
  }

  const checks: OneThingCheck[] = [];
  if (Array.isArray(row.checks)) {
    for (const entry of row.checks) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const series = text(cell.series);
      const level = text(cell.level);
      const body = text(cell.text);
      if (series === undefined || level === undefined || body === undefined) {
        problems.push("checks: an entry is missing series, level or text");
        continue;
      }
      checks.push({ series, level, text: body });
    }
  }
  if (checks.length !== CHECKS)
    problems.push(`checks: ${String(checks.length)} of ${String(CHECKS)}`);

  const everythingElse = Array.isArray(row.everythingElse)
    ? row.everythingElse.filter(
        (line: unknown): line is string => text(line) !== undefined,
      )
    : [];

  const rationales: Array<{ id: string; text: string }> = [];
  if (Array.isArray(row.rationales))
    for (const entry of row.rationales) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const body = text(cell.text);
      if (id === undefined || body === undefined) continue;
      rationales.push({ id, text: body });
    }

  return {
    doc: {
      headline: headline ?? "",
      oneThing: oneThing ?? "",
      ...(changeMyMind === undefined ? {} : { changeMyMind }),
      checks,
      everythingElse,
      rationales,
    },
    problems,
  };
}
