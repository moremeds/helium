/**
 * Theme baskets — the §H.2 excess-move triple.
 *
 * Pure: no clock, no filesystem, no network, no `@helium/core` runtime import.
 * Every number the theme register prints is computed here and copied by the
 * renderer, because the model never does arithmetic (doctrine 4).
 */
import type { Bar } from "../eval/bars.js";
import type { ThemeSpec } from "./review-config.js";

export interface BasketExcess {
  basketPct: number;
  benchPct: number;
  excessPct: number;
  used: string[];
  missing: string[];
}

/** 4 decimals is a tenth of a basis point on a percent — finer than any tape
 *  this reads, and coarse enough that 0.1 + 0.2 never prints as 0.30000000004. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** The close on `day`, or the newest close at or before it. `undefined` when
 *  the symbol has no bar in range — which is a NAMED absence, never a zero. */
function closeAt(bars: readonly Bar[] | undefined, day: string): number | undefined {
  if (bars === undefined || bars.length === 0) return undefined;
  let best: Bar | undefined;
  for (const bar of bars) {
    const stamp = bar.time.slice(0, 10);
    if (stamp > day) continue;
    if (best === undefined || stamp > best.time.slice(0, 10)) best = bar;
  }
  return best === undefined || !Number.isFinite(best.close)
    ? undefined
    : best.close;
}

/** Percent return between two closes, `undefined` when either is missing or
 *  the base is zero. */
function returnPct(
  bars: readonly Bar[] | undefined,
  fromDay: string,
  toDay: string,
): number | undefined {
  const from = closeAt(bars, fromDay);
  const to = closeAt(bars, toDay);
  if (from === undefined || to === undefined || from === 0) return undefined;
  const pct = ((to - from) / from) * 100;
  return Number.isFinite(pct) ? pct : undefined;
}

/**
 * Equal weight means the MEAN OF RETURNS, not the return of a price sum — a
 * $600 name would otherwise be the basket. A member with no bars is EXCLUDED
 * and named in `missing`; the row says "3 of 4" rather than quietly averaging
 * what it has. Returns null (never 0) when nothing is computable.
 */
export function basketExcess(args: {
  members: readonly string[];
  benchmark: string;
  bars: ReadonlyMap<string, readonly Bar[]>;
  fromDay: string;
  toDay: string;
}): BasketExcess | null {
  const { members, benchmark, bars, fromDay, toDay } = args;
  const used: string[] = [];
  const missing: string[] = [];
  const returns: number[] = [];
  for (const member of members) {
    const pct = returnPct(bars.get(member), fromDay, toDay);
    if (pct === undefined) missing.push(member);
    else {
      used.push(member);
      returns.push(pct);
    }
  }
  const benchPct = returnPct(bars.get(benchmark), fromDay, toDay);
  if (returns.length === 0 || benchPct === undefined) return null;
  const basketPct = returns.reduce((a, b) => a + b, 0) / returns.length;
  return {
    basketPct: round4(basketPct),
    benchPct: round4(benchPct),
    excessPct: round4(basketPct - benchPct),
    used,
    missing,
  };
}

/**
 * §H.2's triple, both horizons: the week, and since `entered`. The kill line is
 * armed text plus, when `killExcess` is declared AND computable, whether the
 * condition is met.
 *
 * The renderer NEVER edits the yaml — §H.3's rule is that the operator promotes
 * and demotes, in a dated, reviewed PR. `CONDITION MET` is a printed fact, not
 * an action.
 *
 * The benchmark is a PARAMETER rather than a `"SPY"` literal: the tenant
 * already declares it at `extensions.review.rotation.benchmark`, and a pure
 * module that hardcodes a symbol the declaration owns is a second source of
 * truth (doctrine 2).
 */
export function themeRow(
  theme: ThemeSpec,
  bars: ReadonlyMap<string, readonly Bar[]>,
  day: string,
  w1From: string,
  benchmark: string,
): {
  rowId: string;
  week: BasketExcess | null;
  sinceEntered: BasketExcess | null;
  kill: { armed: string; met: boolean; why?: string };
} {
  const week = basketExcess({
    members: theme.instruments,
    benchmark,
    bars,
    fromDay: w1From,
    toDay: day,
  });
  const sinceEntered = basketExcess({
    members: theme.instruments,
    benchmark,
    bars,
    fromDay: theme.entered,
    toDay: day,
  });
  // The machine-checkable half of `kill`. Absent `killExcess`, or absent a
  // computable basket, the row still prints the armed English — the operator
  // reads it — and simply claims nothing about whether it fired.
  const threshold = theme.killExcess;
  const measured = sinceEntered ?? week;
  const met =
    threshold !== undefined &&
    measured !== null &&
    measured.excessPct <= threshold.pct;
  return {
    rowId: `theme:${theme.id}`,
    week,
    sinceEntered,
    kill: {
      armed: theme.kill,
      met,
      ...(met && threshold !== undefined && measured !== null
        ? {
            why: `excess ${measured.excessPct} % vs ${benchmark} is at or below the declared ${threshold.pct} % over ${threshold.sessions} sessions`,
          }
        : {}),
    },
  };
}
