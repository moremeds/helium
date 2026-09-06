/**
 * How a stored verdict is judged against the NEXT dated observation of the
 * same row.
 *
 * Bands, not opinions — and they live here rather than in a prompt because a
 * token whose meaning the model could argue with is not scorable:
 *
 * - `continue`   same sign, 0.5x..1.5x the prior magnitude
 * - `strengthen` same sign, >1.5x
 * - `fade`       same sign, <0.5x, trending to nil
 * - `reverse`    the sign flipped
 *
 * A |delta| under `nilFraction` of the prior magnitude has no sign at all and
 * realises as `fade`, never as `reverse` — a rounding-sized wiggle is not a
 * turn.
 *
 * The renderer imports the bands to PRINT them beside each token
 * (`render/review.ts`), so the number a reader is shown and the number the
 * settler scores against are the same constant. That is why this module holds
 * no clock, no filesystem and no network.
 * @module dsh-plugin-tenant-option-wizard/eval/verdict
 */

export const VERDICT_BANDS = {
  continueLow: 0.5,
  continueHigh: 1.5,
  nilFraction: 0.1,
} as const;

export type RealisedToken = "continue" | "reverse" | "strengthen" | "fade";

/** The class the NEXT observation puts this row in, given the prior move. */
export function classify(prior: number, next: number): RealisedToken {
  const magnitude = Math.abs(prior);
  const size = Math.abs(next);
  // A prior of nil has no magnitude to measure against: any move at all is a
  // strengthening of nothing, and nil-on-nil continues.
  if (magnitude === 0) return size === 0 ? "continue" : "strengthen";
  const ratio = size / magnitude;
  if (ratio < VERDICT_BANDS.nilFraction) return "fade";
  if (Math.sign(next) !== Math.sign(prior)) return "reverse";
  if (ratio > VERDICT_BANDS.continueHigh) return "strengthen";
  if (ratio < VERDICT_BANDS.continueLow) return "fade";
  return "continue";
}
