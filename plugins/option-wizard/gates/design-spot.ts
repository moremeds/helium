/**
 * A strike is a price, and a price proposed without reading the spot is a
 * guess with a decimal point on it.
 *
 * The bug this exists for: across 42 runs the `design` step emitted proposals
 * in 24 of them without ever calling `ow_spot`, and the strikes landed 15-84%
 * away from where the underlying actually traded. Nothing mechanical caught
 * it — the reviewer is a model, and the renderer's STRIKE_BAND check runs
 * after review and fails OPEN when no spot was ever fetched, which is exactly
 * the case here. So it is checked at the step that produced the number.
 *
 * Checked here is the real invariant, not a proxy for it: every proposal
 * strike must sit within `STRIKE_BAND` of the tool-reported spot for ITS
 * ticker. "ow_spot was called" is necessary but not sufficient — a step that
 * calls `ow_spot` for AAPL and then writes an MSFT strike from memory would
 * pass a call-was-made check and still ship an ungrounded number. Reading the
 * spot back out of the step's own tool output closes that gap.
 *
 * `ow_argon_levels` sharpens that same check where it is available: a strike
 * is not just "near spot", it should sit ON a real structural level (support,
 * resistance, a gamma wall, the day's expected range) — that is the whole
 * reason the designer's persona now says to call it first. When this step's
 * own output carries an `ow_argon_levels` row for a proposal's ticker, the
 * gate checks against `LEVEL_TOLERANCE_PCT` of THAT row's levels instead of
 * the wider 25% spot band; the spot check stays as the fallback for a ticker
 * `ow_argon_levels` never returned (or was never called), so a run without
 * argon reachable does not lose the check it already had.
 *
 * The gate reads `ctx.stepToolOutputs` — the raw strings the tools THIS step
 * called returned — not `ctx.toolOutputs`, which accumulates over the whole
 * run. An earlier step's `ow_spot` call would satisfy a run-wide check while
 * the designer still never saw a price for the ticker it is proposing today.
 *
 * It refuses proposal by proposal, naming exactly the ticker/strike/spot that
 * failed, and fails the whole step only when at least one proposal fails: a
 * step that got NVDA right and QQQ wrong should not have its NVDA half
 * relabelled correct, but the step is still what gets refused (design-spot is
 * a step-scoped gate, same as `ib-preflight`).
 *
 * Levels violations are scoped narrower than that where the proposal makes it
 * possible: `action: "sell"` on a leg identifies the short strike — the one
 * the position is actually defended by a level for — so a long (protective)
 * leg drifting off a level is reported but does not by itself refuse the
 * step. A proposal whose legs carry no identifiable `action` gives the gate
 * nothing to narrow the check to, so every strike is treated as load-bearing
 * and any one of them off-levels hard-fails the step, same as before.
 * @module dsh-plugin-tenant-option-wizard/gates/design-spot
 */
import type { Gate, GateCtx } from "@helium/core";
import { extractProposals } from "./ib-preflight.js";

/** The one tool that returns the underlying's traded price. */
const SPOT_TOOL = "ow_spot";

/** The tool that returns real structural price anchors (technicals, gamma
 *  walls, the nearest options-structure levels, expected range). */
const LEVELS_TOOL = "ow_argon_levels";

/** Same band the renderer's post-review check uses: wide enough for a real
 *  hedge, narrow enough to catch a strike written from memory rather than
 *  from the quote (a QQQ 420/410 spread with QQQ at 707 is 40%+ off). This is
 *  the FALLBACK band, used only when no `ow_argon_levels` row exists for the
 *  proposal's ticker. */
const STRIKE_BAND = 0.25;

/** How close a strike must sit to a real level (support/resistance, a gamma
 *  wall, a closest-level strike) to count as "on" it, expressed as a
 *  fraction of that ticker's own spot. 0.5% of a ~$200-800 underlying is
 *  roughly the width of a single strike increment on those names — tight
 *  enough that a strike still has to actually land on the level the designer
 *  named, not just be somewhere in its neighborhood. */
const LEVEL_TOLERANCE_PCT = 0.005;

/**
 * Spots as `ow_spot`'s own JSON answered them for THIS step:
 * `{ quotes: [{ ticker, last, ... }], noPrice?: [...] }`. Any other shape in
 * `stepToolOutputs` (another tool, or a tool's own failure text) parses to
 * nothing here and is simply not a source of a spot — never a guess.
 */
function spotsFromStepOutputs(outputs: string[]): Map<string, number> {
  const spots = new Map<string, number>();
  for (const raw of outputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const quotes = (parsed as Record<string, unknown>).quotes;
    if (!Array.isArray(quotes)) continue;
    for (const row of quotes) {
      if (row === null || typeof row !== "object") continue;
      const { ticker, last } = row as Record<string, unknown>;
      if (
        typeof ticker === "string" &&
        typeof last === "number" &&
        Number.isFinite(last)
      )
        spots.set(ticker, last);
    }
  }
  return spots;
}

/** Numeric strikes out of one raw (unvalidated) proposal's legs. Lenient on
 *  purpose: this gate's question is "was the strike grounded in a price", not
 *  "is the proposal well-formed" — that second question is `ib-preflight`'s,
 *  and a malformed leg here is simply not a strike to check. */
function strikesOf(raw: unknown): number[] {
  if (raw === null || typeof raw !== "object") return [];
  const legs = (raw as Record<string, unknown>).legs;
  if (!Array.isArray(legs)) return [];
  const strikes: number[] = [];
  for (const leg of legs) {
    if (leg === null || typeof leg !== "object") continue;
    const strike = (leg as Record<string, unknown>).strike;
    if (typeof strike === "number" && Number.isFinite(strike))
      strikes.push(strike);
  }
  return strikes;
}

function tickerOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const ticker = (raw as Record<string, unknown>).ticker;
  return typeof ticker === "string" && ticker.trim() !== ""
    ? ticker.trim()
    : undefined;
}

/** One `ow_argon_levels` row, unwrapped only as far as this gate needs. */
type LevelsRow = Record<string, unknown>;

/**
 * Rows as `ow_argon_levels`'s own JSON answered them for THIS step:
 * `{ source: "argon", levels: [{ ticker, technical?, gamma?, closest_levels?,
 * expected_range?, ... }] }`. Same discipline as `spotsFromStepOutputs`: any
 * other shape in `stepToolOutputs` simply is not a source of a level here.
 */
function levelsFromStepOutputs(outputs: string[]): Map<string, LevelsRow> {
  const rows = new Map<string, LevelsRow>();
  for (const raw of outputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const levels = (parsed as Record<string, unknown>).levels;
    if (!Array.isArray(levels)) continue;
    for (const row of levels) {
      if (row === null || typeof row !== "object") continue;
      const ticker = (row as Record<string, unknown>).ticker;
      if (typeof ticker === "string" && ticker.trim() !== "")
        rows.set(ticker.trim(), row as LevelsRow);
    }
  }
  return rows;
}

/**
 * Every named, numeric level in one `ow_argon_levels` row — technical
 * (support/resistance/pivot_a/pivot_b/sma20), gamma (gex_flip/call_wall/
 * put_wall/max_magnet/hvl), and each `closest_levels[].strike`. `expected_range`
 * is deliberately excluded here: it is a RANGE, checked separately by
 * `withinExpectedRange`, not a point a strike should sit "on".
 */
function namedLevelsOf(
  row: LevelsRow,
): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  const technical = row.technical;
  if (technical !== null && typeof technical === "object") {
    for (const [key, value] of Object.entries(
      technical as Record<string, unknown>,
    )) {
      if (typeof value === "number" && Number.isFinite(value))
        out.push({ label: `technical.${key}`, value });
    }
  }
  const gamma = row.gamma;
  if (gamma !== null && typeof gamma === "object") {
    for (const [key, value] of Object.entries(
      gamma as Record<string, unknown>,
    )) {
      if (typeof value === "number" && Number.isFinite(value))
        out.push({ label: `gamma.${key}`, value });
    }
  }
  const closest = row.closest_levels;
  if (Array.isArray(closest)) {
    for (const level of closest) {
      if (level === null || typeof level !== "object") continue;
      const strike = (level as Record<string, unknown>).strike;
      const label = (level as Record<string, unknown>).label;
      if (typeof strike === "number" && Number.isFinite(strike))
        out.push({
          label:
            typeof label === "string" && label.trim() !== ""
              ? `closest_levels[${label.trim()}]`
              : "closest_levels[]",
          value: strike,
        });
    }
  }
  return out;
}

/** `low`/`high` of `row.expected_range`, or `undefined` when the row has none. */
function expectedRangeOf(
  row: LevelsRow,
): { low: number; high: number } | undefined {
  const range = row.expected_range;
  if (range === null || typeof range !== "object") return undefined;
  const { low, high } = range as Record<string, unknown>;
  if (
    typeof low === "number" &&
    typeof high === "number" &&
    Number.isFinite(low) &&
    Number.isFinite(high)
  )
    return { low, high };
  return undefined;
}

/** The nearest named level to `strike`, for a reason string a reader can act
 *  on ("nearest is gamma.call_wall 770" beats "no level matched"). `undefined`
 *  only when the row carried no numeric level at all. */
function nearestLevel(
  strike: number,
  levels: ReadonlyArray<{ label: string; value: number }>,
): { label: string; value: number } | undefined {
  let best: { label: string; value: number } | undefined;
  let bestDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(strike - level.value);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return best;
}

/**
 * Whether `strike` sits within `LEVEL_TOLERANCE_PCT` of at least one named
 * level in `levels`, OR inside `range` (a strike anywhere in the day's
 * expected range is grounded — the range itself is the tool's real number,
 * not a strike author's guess).
 */
function onALevel(
  strike: number,
  levels: ReadonlyArray<{ label: string; value: number }>,
  range: { low: number; high: number } | undefined,
): boolean {
  if (range !== undefined && strike >= range.low && strike <= range.high)
    return true;
  return levels.some(
    (level) =>
      Math.abs(strike - level.value) / level.value <= LEVEL_TOLERANCE_PCT,
  );
}

/** `action` on one leg, case-folded — the designer's own prompt spells it
 *  lowercase (`"buy"|"sell"`), a test fixture spells it uppercase; both name
 *  the same fact. `undefined` when the leg carries nothing usable. */
function legAction(leg: unknown): "buy" | "sell" | undefined {
  if (leg === null || typeof leg !== "object") return undefined;
  const action = (leg as Record<string, unknown>).action;
  if (typeof action !== "string") return undefined;
  const lower = action.trim().toLowerCase();
  return lower === "buy" || lower === "sell" ? lower : undefined;
}

/**
 * The short strike(s) of one proposal — the leg(s) whose real premium is at
 * risk, and so the leg a level is actually meant to defend — plus whether the
 * proposal's legs carried enough `action` information to identify them at
 * all. When `identified` is false the caller has no legitimate way to narrow
 * the check and must treat every strike as load-bearing.
 */
function shortStrikesOf(raw: unknown): {
  strikes: Set<number>;
  identified: boolean;
} {
  const strikes = new Set<number>();
  let identified = false;
  if (raw === null || typeof raw !== "object") return { strikes, identified };
  const legs = (raw as Record<string, unknown>).legs;
  if (!Array.isArray(legs)) return { strikes, identified };
  for (const leg of legs) {
    const action = legAction(leg);
    if (action === undefined) continue;
    identified = true;
    if (action !== "sell") continue;
    const strike = (leg as Record<string, unknown>).strike;
    if (typeof strike === "number" && Number.isFinite(strike))
      strikes.add(strike);
  }
  return { strikes, identified };
}

/** Every number written in an `anchor` string, e.g. `"call wall 770"` ->
 *  `[770]`. Deliberately dumb: this is a proposal author's own free text, not
 *  JSON, so anything that parses as a number is a claim to check. */
function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/gu)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Whether at least one number written in `anchor` matches (within
 * `LEVEL_TOLERANCE_PCT`) a real level in `levels`, or falls inside `range`.
 * An `anchor` naming a number the tool never returned is exactly as made-up
 * as a strike picked from memory — the field exists so a real level gets
 * named, not so a plausible-looking one does.
 */
function anchorMatchesRow(
  anchor: string,
  levels: ReadonlyArray<{ label: string; value: number }>,
  range: { low: number; high: number } | undefined,
): boolean {
  const numbers = numbersIn(anchor);
  if (numbers.length === 0) return false;
  return numbers.some((n) => onALevel(n, levels, range));
}

const gate: Gate = {
  id: "design-spot",
  phase: "output",
  appliesTo: ["structure-designer"],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const extracted = extractProposals(input);
    if (extracted.proposals.length === 0) {
      // Covers both `{"proposals":[],"reason":...}` — the tenant's documented
      // way of saying "no trade today" — and output nothing could be read out
      // of. Neither carries a strike, so neither can carry a strike written
      // without a price. Refusing here would refuse the honest empty answer.
      return {
        pass: true,
        reason:
          extracted.error === undefined
            ? "no proposals: no strike was written, so none was written without a spot"
            : `no proposals could be read out of this role's output (${extracted.error}): no strike to check`,
      };
    }

    const calls = ctx.toolCalls ?? [];
    const calledSpot = calls.includes(SPOT_TOOL);
    const calledLevels = calls.includes(LEVELS_TOOL);
    if (!calledSpot && !calledLevels) {
      return {
        pass: false,
        reason:
          `${String(extracted.proposals.length)} proposal(s) with strikes, but neither ${SPOT_TOOL} nor ` +
          `${LEVELS_TOOL} was called in this step (tools called: ${calls.length === 0 ? "none" : calls.join(", ")}). ` +
          "A strike is a price: call ow_argon_levels (or at least ow_spot) for each " +
          "ticker you propose and pick strikes against what it returns.",
      };
    }

    const spots = spotsFromStepOutputs(ctx.stepToolOutputs ?? []);
    const levelsRows = levelsFromStepOutputs(ctx.stepToolOutputs ?? []);
    const faults: string[] = [];
    const softNotes: string[] = [];
    const oks: string[] = [];
    for (const [index, raw] of extracted.proposals.entries()) {
      const ticker = tickerOf(raw);
      const strikes = strikesOf(raw);
      if (ticker === undefined || strikes.length === 0) continue;
      const levelsRow = levelsRows.get(ticker);

      if (levelsRow !== undefined) {
        // Sharper check: strikes are graded against real structural levels,
        // not just closeness to spot.
        const namedLevels = namedLevelsOf(levelsRow);
        const range = expectedRangeOf(levelsRow);
        const { strikes: shortStrikes, identified } = shortStrikesOf(raw);
        for (const strike of strikes) {
          if (onALevel(strike, namedLevels, range)) {
            oks.push(`${ticker} ${String(strike)} on a level`);
            continue;
          }
          const nearest = nearestLevel(strike, namedLevels);
          const nearestText =
            nearest === undefined
              ? "no numeric level in this row"
              : `nearest is ${nearest.label} ${String(nearest.value)}`;
          const rangeText =
            range === undefined
              ? ""
              : ` (expected_range ${String(range.low)}-${String(range.high)})`;
          const note =
            `proposal ${String(index + 1)} (${ticker}): strike ${String(strike)} is not within ` +
            `${String(LEVEL_TOLERANCE_PCT * 100)}% of any ${LEVELS_TOOL} level and not inside ` +
            `expected_range — ${nearestText}${rangeText}`;
          // Scoped to the short leg where the proposal makes that possible: a
          // long (protective) leg off-level is worth flagging, not refusing —
          // the level is what the SHORT strike is meant to sit on.
          if (identified && !shortStrikes.has(strike)) {
            softNotes.push(`${note} (long leg, not hard-failed)`);
          } else {
            faults.push(note);
          }
        }
        const anchor = (raw as Record<string, unknown> | null)?.anchor;
        if (typeof anchor === "string" && anchor.trim() !== "") {
          if (!anchorMatchesRow(anchor, namedLevels, range)) {
            faults.push(
              `proposal ${String(index + 1)} (${ticker}): anchor "${anchor.trim()}" names no number ` +
                `that appears in this step's ${LEVELS_TOOL} row for ${ticker} — a fabricated anchor`,
            );
          }
        }
        continue;
      }

      // Fallback: no ow_argon_levels row for this ticker (not called, or
      // argon returned nothing for it) — the original spot-band check.
      const spot = spots.get(ticker);
      if (spot === undefined) {
        // Fail closed: neither tool produced a price for this ticker in this
        // step's own output. A strike with no grounding anywhere here is
        // exactly the ungrounded number this gate exists to catch.
        faults.push(
          `proposal ${String(index + 1)} (${ticker}): no spot and no ${LEVELS_TOOL} row for ${ticker} ` +
            `in this step's tool output — strike(s) ${strikes.join(", ")} unverified`,
        );
        continue;
      }
      for (const strike of strikes) {
        const pctOff = Math.abs(strike - spot) / spot;
        if (pctOff > STRIKE_BAND) {
          faults.push(
            `proposal ${String(index + 1)} (${ticker}): strike ${String(strike)} is ` +
              `${(pctOff * 100).toFixed(1)}% away from spot ${String(spot)}, over the ` +
              `${String(STRIKE_BAND * 100)}% band`,
          );
        } else {
          oks.push(
            `${ticker} ${String(strike)} vs spot ${String(spot)} (${(pctOff * 100).toFixed(1)}%)`,
          );
        }
      }
    }

    if (faults.length > 0) {
      return {
        pass: false,
        reason:
          softNotes.length === 0
            ? faults.join("; ")
            : `${faults.join("; ")} | also: ${softNotes.join("; ")}`,
      };
    }
    return {
      pass: true,
      reason:
        oks.length === 0 && softNotes.length === 0
          ? `${calledLevels ? LEVELS_TOOL : SPOT_TOOL} was called in this step; no numeric strike found to check`
          : [
              oks.length === 0
                ? undefined
                : `strikes grounded: ${oks.join("; ")}`,
              softNotes.length === 0
                ? undefined
                : `not hard-failed: ${softNotes.join("; ")}`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" | "),
    };
  },
};

export default gate;
