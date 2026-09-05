/**
 * How much this run's cause title repeats the previous one's.
 *
 * A brief that re-tells yesterday's cause in yesterday's words is the defect
 * this number measures, and the model must never be the one measuring it —
 * doctrine 4 and the standing rule that numbers come from code.
 * @module dsh-plugin-tenant-option-wizard/quality/similarity
 */

/** The spec's list, verbatim. Short and closed on purpose: a long stopword
 *  list would make two unrelated titles look similar by deletion. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "and",
  "not",
  "is",
  "at",
  "on",
  "for",
]);

/**
 * Lowercased words, split on whitespace, with leading and trailing characters
 * that are neither letters, digits nor `%` removed.
 *
 * Whitespace rather than a character class, so `4.75%` and `back-revisions`
 * survive as one token each: splitting on punctuation would turn one number
 * into two words and inflate every union.
 */
export function wordSet(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/\s+/u)
      .map((token) =>
        token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}%]+$/u, ""),
      )
      .filter((token) => token !== "" && !STOPWORDS.has(token)),
  );
}

/** |a ∩ b| / |a ∪ b|. Two empty sets are 0, never NaN. */
export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
