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

/**
 * The class the NEXT observation puts this row in, given the prior move.
 *
 * `null` when the prior move was NIL. Every band above is a multiple of the
 * prior magnitude, so a prior of zero has no band at all: 0.5x0 and 1.5x0 are
 * both 0, and the review-v6 close printed exactly that — `flow — 39758465 →
 * +0 USD — CONTINUE (0USD..0USD)`, a verdict inside an empty interval. There
 * is nothing here to be right or wrong about, so the row is untested for the
 * band rather than scored against one.
 */
export function classify(prior: number, next: number): RealisedToken | null {
  const magnitude = Math.abs(prior);
  const size = Math.abs(next);
  if (magnitude === 0) return null;
  const ratio = size / magnitude;
  if (ratio < VERDICT_BANDS.nilFraction) return "fade";
  if (Math.sign(next) !== Math.sign(prior)) return "reverse";
  if (ratio > VERDICT_BANDS.continueHigh) return "strengthen";
  if (ratio < VERDICT_BANDS.continueLow) return "fade";
  return "continue";
}

// ---------------------------------------------------------------------------
// the settlers
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { Commitment, Receipt } from "@helium/core";
// A deliberate import cycle with `settle.ts`, and the reason is the point:
// `hashBars` is what a bar hash MEANS, and two settlers that each defined one
// could disagree about it. Both modules export only hoisted declarations, so
// the cycle resolves.
import { binaryBrier, hashBars, pending } from "./settle.js";
import type { Bar, BarSource, TenantCalendar } from "./bars.js";

/** The lookback §G.5's realized fallback is defined over. Sixty sessions is a
 *  quarter of trading — long enough that one gap week does not move the
 *  median, short enough that last spring's regime does not. */
export const REALIZED_LOOKBACK = 60;

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** The phase that minted a commitment, out of its own id. `render/ledger.ts`
 *  puts it there because `design` and `review` run at two labels a day, so a
 *  day alone does not say which run made the promise. */
function phaseOf(commitment: Commitment): string {
  const rest = commitment.id.slice("yyyy-mm-dd-".length);
  const head = rest.split("-")[0];
  return head === undefined || head === "" ? commitment.variant : head;
}

/** One definition of "the market was open that day", exported so the renderer's
 *  §7 settle date and this settler cannot disagree about a holiday. */
export function isOpen(day: string, calendar?: TenantCalendar): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !(calendar?.closed ?? []).includes(day);
}

/** OPEN sessions strictly after `from`, up to and including `to`. */
function openDaysBetween(
  from: string,
  to: string,
  calendar?: TenantCalendar,
): number {
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor.getTime() < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.toISOString().slice(0, 10);
    if (isOpen(day, calendar)) count += 1;
  }
  return count;
}

interface VerdictPayload {
  kind: string;
  rowId: string;
  token: string;
  p: number;
  observed?: { delta?: number };
  settleAfterOpenDays?: number;
}

/**
 * Settled against the ledger itself: the OLDEST commitment for the same rowId
 * issued strictly after this one carries the next dated observation.
 *
 * No new storage, no network and no clock beyond `now` — the record we already
 * keep is the evidence. The oldest-later, not the newest: a verdict promises
 * something about the NEXT period, and settling it against a month-later
 * reading would score a different claim.
 */
export function settleVerdict(args: {
  commitment: Commitment;
  later: readonly Commitment[];
  now: Date;
  calendar?: TenantCalendar;
}): Receipt {
  const { commitment, now } = args;
  const payload = commitment.payload as VerdictPayload;
  const issuedDay = commitment.issuedAt.slice(0, 10);
  const candidates = args.later
    .filter((row) => row.id !== commitment.id)
    .filter((row) => {
      const other = row.payload as VerdictPayload | null;
      return (
        other !== null &&
        typeof other === "object" &&
        other.kind === payload.kind &&
        other.rowId === payload.rowId &&
        row.issuedAt > commitment.issuedAt &&
        typeof other.observed?.delta === "number"
      );
    })
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  const next = candidates[0];
  if (next === undefined)
    return pending(
      commitment,
      now,
      `no later observation of ${payload.rowId} yet`,
    );
  const nextDay = next.issuedAt.slice(0, 10);
  const seen = openDaysBetween(issuedDay, nextDay, args.calendar);
  const need = payload.settleAfterOpenDays ?? 1;
  if (seen < need)
    return pending(
      commitment,
      now,
      `settles after ${String(need)} open days; ${String(seen)} seen`,
    );
  const prior = payload.observed?.delta ?? 0;
  const later = (next.payload as VerdictPayload).observed?.delta ?? 0;
  const realised = classify(prior, later);
  // A nil prior gives no band, so there is no claim to score. Pending, not a
  // hit and not a miss: the next dated observation may carry a real move.
  if (realised === null)
    return pending(
      commitment,
      now,
      `prior move on ${payload.rowId} was nil: no band to score`,
    );
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: realised,
    scores: {
      verdictBrier: binaryBrier(payload.p, realised === payload.token ? 1 : 0),
    },
    evidenceHash: createHash("sha256")
      .update(`${payload.rowId}|${String(prior)}|${String(later)}`)
      .digest("hex"),
    detail: {
      rowId: payload.rowId,
      said: payload.token,
      got: realised,
      from: { day: issuedDay, phase: phaseOf(commitment) },
      to: { day: nextDay, phase: phaseOf(next) },
      prior,
      next: later,
    },
  };
}

interface FocusPayload {
  ticker: string;
  admittedFor: unknown;
  window: { fromDay: string; toDay: string; openDays: number };
  threshold: { pct: number; source: string };
  p: number;
}

/** §G.5. Unlike a verdict, this one IS bar-backed: the claim is that the name
 *  moved at least its own implied move over its own event window. */
export async function settleFocus(args: {
  commitment: Commitment;
  now: Date;
  source: BarSource;
  calendar?: TenantCalendar;
}): Promise<Receipt> {
  const { commitment, now } = args;
  const payload = commitment.payload as FocusPayload;
  const { fromDay, toDay } = payload.window;
  // A generous window, then the two bars are PICKED: the anchor is the last
  // close on or before the window's start, so a holiday start still anchors.
  const from = new Date(Date.parse(`${fromDay}T00:00:00Z`) - 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const bars = await args.source.bars1d(payload.ticker, from, toDay);
  const sorted = [...bars].sort((a, b) => a.time.localeCompare(b.time));
  const anchor = [...sorted].reverse().find((bar) => bar.time <= fromDay);
  const end = sorted.find((bar) => bar.time === toDay);
  if (anchor === undefined)
    return pending(
      commitment,
      now,
      `no daily bar for ${payload.ticker} on or before ${fromDay} yet`,
    );
  if (end === undefined)
    return pending(
      commitment,
      now,
      `no daily bar for ${payload.ticker} on ${toDay} yet`,
    );
  const movePct = (end.close / anchor.close - 1) * 100;
  const hit = Math.abs(movePct) >= payload.threshold.pct;
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: hit ? "hit" : "miss",
    scores: { focusBrier: binaryBrier(payload.p, hit ? 1 : 0) },
    evidenceHash: hashBars([anchor, end]),
    detail: {
      ticker: payload.ticker,
      admittedFor: payload.admittedFor,
      movePct: round4(movePct),
      thresholdPct: payload.threshold.pct,
      thresholdSource: payload.threshold.source,
      anchor: { time: anchor.time, close: anchor.close },
      end: { time: end.time, close: end.close },
      priceBasis: "raw, not dividend-adjusted",
    },
  };
}

/**
 * The median |n-open-session close-to-close return| over the prior 60
 * sessions, in percent.
 *
 * A DEFINED statistic over real bars, not a guess: it is the same horizon as
 * the window, so "moved more than usual" means the same thing under both the
 * implied and the realized threshold. `ow_price_structure` — which §G.5 names
 * as the fallback — holds no price series at all (it is expiry payoff
 * arithmetic over legs and their NBBO mids), so it cannot answer this and is
 * not used.
 */
export function realizedThreshold(
  bars: readonly Bar[],
  openDays: number,
): number | null {
  if (bars.length < openDays + 1) return null;
  const sorted = [...bars].sort((a, b) => a.time.localeCompare(b.time));
  const window = sorted.slice(-(REALIZED_LOOKBACK + openDays));
  const returns: number[] = [];
  for (let index = openDays; index < window.length; index += 1) {
    const before = window[index - openDays]!;
    const after = window[index]!;
    if (before.close === 0) continue;
    returns.push(Math.abs(after.close / before.close - 1) * 100);
  }
  if (returns.length === 0) return null;
  returns.sort((a, b) => a - b);
  const mid = Math.floor(returns.length / 2);
  const median =
    returns.length % 2 === 0
      ? (returns[mid - 1]! + returns[mid]!) / 2
      : returns[mid]!;
  return round4(median);
}
