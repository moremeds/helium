/**
 * The review document: what the weekly analyst and the editor return for the
 * seven-section review, parsed and reported on.
 *
 * SCHEMA HALF. No numbers, no section titles, no as-of and no tool name reach
 * this document — titles and every figure are renderer-supplied, and a model
 * that tried to send one would simply have it ignored.
 *
 * Three refusals are the whole point of the file:
 *
 * - **A verdict with no usable probability mints no commitment.** `p` outside
 *   [0.5, 0.95] or absent leaves the row printable but UNSCORABLE, and says so
 *   (spec C.5, Tetlock: probability-bearing or unscorable). A token alone
 *   cannot be Brier-scored, so admitting one to the ledger would put a row in
 *   the denominator that can never be settled.
 * - **A theme's verdict does not live in `themes[]`.** A theme IS a coverage
 *   row, so its token arrives through `coverage[]`; `themes[]` carries only the
 *   §H.4 leadership sentence.
 * - **Nothing is padded.** A malformed entry is dropped with a problem string;
 *   the renderer prints `untested` or `—` for the row it belonged to, and the
 *   gap counters go up.
 * @module dsh-plugin-tenant-option-wizard/render/review
 */

export const VERDICT_TOKENS = [
  "continue",
  "reverse",
  "strengthen",
  "fade",
  "untested",
] as const;
export type VerdictToken = (typeof VERDICT_TOKENS)[number];

export const LEADERSHIP = ["confirms", "contradicts", "mixed"] as const;
export type Leadership = (typeof LEADERSHIP)[number];

/** Tetlock's floor and ceiling. Below 0.5 the token and the probability
 *  disagree; above 0.95 nothing is ever settled against it. */
export const P_MIN = 0.5;
export const P_MAX = 0.95;

export interface CoverageEntry {
  id: string;
  token: VerdictToken;
  /** Absent when the model gave none, or gave one outside [P_MIN, P_MAX]. */
  p?: number;
  why: string;
  /** What settles it — the observable the next period reads. */
  observable: string;
  /** False when `p` is absent or out of range: the row prints, and mints no
   *  commitment. */
  scorable: boolean;
}

export interface FocusEntry {
  ticker: string;
  why: string;
}

export interface ThemeEntry {
  id: string;
  leadership: Leadership;
  why: string;
}

export interface ReviewDoc {
  review: string;
  outlook: string;
  catalysts: string;
  coverage: CoverageEntry[];
  focus: FocusEntry[];
  themes: ThemeEntry[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function parseReviewDoc(value: unknown): {
  doc: ReviewDoc | null;
  problems: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { doc: null, problems: ["document is not an object"] };
  const row = value as Record<string, unknown>;
  const problems: string[] = [];

  const coverage: CoverageEntry[] = [];
  if (Array.isArray(row.coverage))
    for (const entry of row.coverage) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const token = text(cell.token);
      if (id === undefined) {
        problems.push("coverage: an entry has no id");
        continue;
      }
      if (
        token === undefined ||
        !(VERDICT_TOKENS as readonly string[]).includes(token)
      ) {
        problems.push(
          `coverage ${id}: token must be one of ${VERDICT_TOKENS.join(", ")}`,
        );
        continue;
      }
      const p = cell.p;
      const usable =
        typeof p === "number" && Number.isFinite(p) && p >= P_MIN && p <= P_MAX;
      if (!usable && token !== "untested")
        problems.push(
          `coverage ${id}: p ${String(p)} is not in [${String(P_MIN)}, ${String(P_MAX)}] — the row prints and mints no commitment`,
        );
      coverage.push({
        id,
        token: token as VerdictToken,
        ...(usable ? { p: p as number } : {}),
        why: text(cell.why) ?? "",
        observable: text(cell.observable) ?? "",
        scorable: usable,
      });
    }

  const focus: FocusEntry[] = [];
  if (Array.isArray(row.focus))
    for (const entry of row.focus) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const ticker = text(cell.ticker);
      if (ticker === undefined) {
        problems.push("focus: an entry has no ticker");
        continue;
      }
      focus.push({ ticker, why: text(cell.why) ?? "" });
    }

  const themes: ThemeEntry[] = [];
  if (Array.isArray(row.themes))
    for (const entry of row.themes) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const leadership = text(cell.leadership);
      if (id === undefined) {
        problems.push("themes: an entry has no id");
        continue;
      }
      if (
        leadership === undefined ||
        !(LEADERSHIP as readonly string[]).includes(leadership)
      ) {
        problems.push(
          `themes ${id}: leadership must be one of ${LEADERSHIP.join(", ")}`,
        );
        continue;
      }
      themes.push({
        id,
        leadership: leadership as Leadership,
        why: text(cell.why) ?? "",
      });
    }

  return {
    doc: {
      review: text(row.review) ?? "",
      outlook: text(row.outlook) ?? "",
      catalysts: text(row.catalysts) ?? "",
      coverage,
      focus,
      themes,
    },
    problems,
  };
}
