/**
 * How many decimals a number gets when it is PRINTED, by its unit.
 *
 * One table, because the alternative is what the 2026-09-06 acceptance run
 * delivered: `+2.9089` four-week excess, `2.3634%` implied move,
 * `118.7479 → +0.3896 index pts`, and `1.3037037037037023` handed to the week
 * reviewer as a channel score. Every one of those is a float printed with
 * `String(n)`, and a reader cannot tell four significant decimals of noise
 * from a number that means something.
 *
 * The precisions are the ones the instruments themselves are quoted at:
 *
 * | unit                      | dp | why                                     |
 * | ------------------------- | -- | --------------------------------------- |
 * | percent, pp, index points | 1  | a tenth of a percent is the tape's step |
 * | basis points              | 0  | a bp IS the unit; 0.5 bp is not quoted  |
 * | VIX / gamma points        | 2  | VIX prints to two, and so does a strike |
 * | prices                    | 2  | a cent                                  |
 * | IV rank                   | 0  | a rank out of a hundred                 |
 * | USD notional              | 0  | net premium is dollars, not cents       |
 *
 * Pure: no clock, no locale, no `Intl`. `toFixed` is deliberate — it is the
 * one formatter that never inserts a thousands separator into a number a later
 * run has to parse back.
 * @module dsh-plugin-tenant-option-wizard/quality/units
 */

export const UNIT_DIGITS = {
  pct: 1,
  pp: 1,
  indexPts: 1,
  bp: 0,
  usd: 0,
  pts: 2,
  price: 2,
  ivRank: 0,
} as const;

export type Unit = keyof typeof UNIT_DIGITS;

/**
 * The unit a printed move string carries, from the token the extractor already
 * wrote after the number — never guessed from the row id. `"+0.3896 index pts"`
 * is `indexPts`; `"-2.0 bp"` is `bp`.
 */
export function unitFromToken(token: string | undefined): Unit {
  switch ((token ?? "").toLowerCase()) {
    case "bp":
      return "bp";
    case "usd":
      return "usd";
    case "%":
    case "pct":
      return "pct";
    case "pp":
      return "pp";
    case "index":
    case "indexpts":
      return "indexPts";
    case "pts":
      return "pts";
    default:
      return "price";
  }
}

/** The number, at its unit's precision. No sign is forced. */
export function fmt(value: number, unit: Unit): string {
  return Number.isFinite(value) ? value.toFixed(UNIT_DIGITS[unit]) : "—";
}

/** The number with an EXPLICIT sign. A difference always carries one: "+1.7"
 *  and "-1.7" are the two answers and "1.7" is neither. */
export function fmtSigned(value: number, unit: Unit): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = Math.abs(value).toFixed(UNIT_DIGITS[unit]);
  // `-0.0` is a rounding artefact, not a fall.
  return `${value < 0 && Number(fixed) !== 0 ? "-" : "+"}${fixed}`;
}

/** The same, rounded to the unit's precision as a NUMBER — for a payload field
 *  a model reads rather than a string it prints. */
export function roundTo(value: number, unit: Unit): number {
  const scale = 10 ** UNIT_DIGITS[unit];
  return Math.round(value * scale) / scale;
}
