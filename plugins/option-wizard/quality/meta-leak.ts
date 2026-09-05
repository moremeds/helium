/**
 * Words the brief may not say about ITSELF.
 *
 * The editor persona has forbidden replay and coverage vocabulary in prose
 * since 2026-09-03, and the v3 replay still shipped "No prior intraday brief
 * exists" as a section title. A persona is a request; a pattern list is a
 * match. The list lives in the tenant because these are English words about
 * a market brief, and core knows no domain (doctrine 2).
 *
 * The `coverage` block is deliberately NOT scanned: it is the honest record
 * of what could not be read, and gating it would teach the run to hide its
 * own gaps.
 * @module dsh-plugin-tenant-option-wizard/quality/meta-leak
 */

/** Regex SOURCES, not RegExp objects: a shared `/g` RegExp carries
 *  `lastIndex` between calls, so two scans of the same text disagree. Each
 *  scan compiles its own. */
export const META_LEAK_PATTERNS: readonly string[] = [
  "\\breplay\\b",
  "\\bas-of\\b",
  "\\bunavailable\\b",
  "\\bfrozen\\b",
  "nothing ships",
  "no prior \\w+ brief",
  "not (?:checked|available|live)",
];

export interface Leak {
  /** `headline`, `decision Call`, `section 3 title`, `section 3 body`. */
  field: string;
  /** The pattern source that matched, verbatim from META_LEAK_PATTERNS. */
  pattern: string;
  /** The match with 20 characters of context on each side. */
  excerpt: string;
}

const CONTEXT_CHARS = 20;

function scan(field: string, text: unknown, out: Leak[]): void {
  if (typeof text !== "string" || text === "") return;
  for (const pattern of META_LEAK_PATTERNS) {
    const regex = new RegExp(pattern, "giu");
    for (const match of text.matchAll(regex)) {
      const at = match.index;
      out.push({
        field,
        pattern,
        excerpt: text.slice(
          Math.max(0, at - CONTEXT_CHARS),
          at + match[0].length + CONTEXT_CHARS,
        ),
      });
    }
  }
}

/**
 * Every hit over a brief-shaped document's headline, decision values and
 * section titles and bodies. Unknown or missing fields are simply not
 * scanned — a step whose JSON has no `sections` is a step doing something
 * else, the same rule `measure()` in render/budget.ts follows.
 */
export function findMetaLeaks(doc: unknown): Leak[] {
  if (doc === null || typeof doc !== "object") return [];
  const row = doc as {
    headline?: unknown;
    decision?: unknown;
    sections?: unknown;
  };
  const out: Leak[] = [];
  scan("headline", row.headline, out);
  if (Array.isArray(row.decision)) {
    for (const entry of row.decision) {
      const cell = (entry ?? {}) as { label?: unknown; value?: unknown };
      scan(
        `decision ${typeof cell.label === "string" ? cell.label : "?"}`,
        cell.value,
        out,
      );
    }
  } else if (row.decision !== null && typeof row.decision === "object") {
    for (const [label, value] of Object.entries(
      row.decision as Record<string, unknown>,
    ))
      scan(`decision ${label}`, value, out);
  }
  if (Array.isArray(row.sections)) {
    row.sections.forEach((section: unknown, i: number) => {
      const cell = (section ?? {}) as { title?: unknown; body?: unknown };
      scan(`section ${String(i + 1)} title`, cell.title, out);
      scan(`section ${String(i + 1)} body`, cell.body, out);
    });
  }
  return out;
}
