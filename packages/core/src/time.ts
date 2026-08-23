/**
 * Duration literals and UTC timestamps. Job YAML carries human durations
 * ('30s', '10m', '2h'); everything persisted or compared is milliseconds.
 * @module @helium/core/time
 */

/** Milliseconds per accepted duration suffix. */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A whole-number count followed by one accepted suffix, and nothing else. */
export const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Parse a duration literal into milliseconds.
 * @param s - the literal, e.g. `30s`.
 * @returns the duration in milliseconds.
 * @throws when the literal is not `<integer><ms|s|m|h|d>`.
 */
export function parseDuration(s: string): number {
  const match = DURATION_PATTERN.exec(s.trim());
  if (match === null) {
    throw new Error(
      `invalid duration ${JSON.stringify(s)} (expected <integer><ms|s|m|h|d>, e.g. 30s)`,
    );
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

/** The current instant as a UTC ISO-8601 timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}
