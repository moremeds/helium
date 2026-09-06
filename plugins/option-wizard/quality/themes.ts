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

// ---------------------------------------------------------------------------
// §H.4 rotation
// ---------------------------------------------------------------------------

export interface RotationRow {
  /** "XLK" or "theme:el-nino-ag-2026". */
  symbol: string;
  label: string;
  w1: number | null;
  w4: number | null;
  w12: number | null;
  excess1w: number | null;
  excess4w: number | null;
  excess12w: number | null;
  untested?: string;
}

/** The newest bar day at or before `day`, or undefined. */
function newestDay(
  bars: readonly Bar[] | undefined,
  day: string,
): string | undefined {
  let best: string | undefined;
  for (const bar of bars ?? []) {
    const stamp = bar.time.slice(0, 10);
    if (stamp > day) continue;
    if (best === undefined || stamp > best) best = stamp;
  }
  return best;
}

/**
 * The sector-and-theme rotation table: each row's 1/4/12-week return and its
 * excess over the declared benchmark, ranked by the one-week excess.
 *
 * Two rules make the table trustworthy rather than merely present:
 *
 * - **A symbol is never dropped.** One that cannot be priced prints `untested`
 *   with the reason, exactly like a coverage row (§C.2). A silently shorter
 *   table is the failure this design exists to prevent.
 * - **A STALE series is untested, not flat.** `closeAt` answers with the newest
 *   close at or before the day, so a symbol whose data stopped two months ago
 *   would otherwise report a perfectly calm 0.00 % week. The table's as-of is
 *   the BENCHMARK's newest bar, and a symbol without a bar on that day is
 *   untested with both dates named.
 */
export function rotationTable(args: {
  sectorEtfs: readonly string[];
  themes: readonly ThemeSpec[];
  benchmark: string;
  lookbacks: { w1: number; w4: number; w12: number };
  bars: ReadonlyMap<string, readonly Bar[]>;
  day: string;
  /** The day `n` OPEN sessions before `from`. Injected: no calendar here. */
  openDaysBack: (from: string, n: number) => string;
}): {
  asOf: string;
  benchmark: string;
  benchmarkReturns: { w1: number | null; w4: number | null; w12: number | null };
  rows: RotationRow[];
  notes: string[];
} {
  const { sectorEtfs, themes, benchmark, lookbacks, bars, day } = args;
  const notes: string[] = [];
  const asOf = newestDay(bars.get(benchmark), day) ?? day;
  if (asOf !== day)
    notes.push(
      `${benchmark}: newest bar ${asOf}, so the table is as of ${asOf} rather than ${day}`,
    );
  const from = {
    w1: args.openDaysBack(asOf, lookbacks.w1),
    w4: args.openDaysBack(asOf, lookbacks.w4),
    w12: args.openDaysBack(asOf, lookbacks.w12),
  };
  const bench = {
    w1: basketExcess({ members: [benchmark], benchmark, bars, fromDay: from.w1, toDay: asOf }),
    w4: basketExcess({ members: [benchmark], benchmark, bars, fromDay: from.w4, toDay: asOf }),
    w12: basketExcess({ members: [benchmark], benchmark, bars, fromDay: from.w12, toDay: asOf }),
  };
  const benchmarkReturns = {
    w1: bench.w1?.benchPct ?? null,
    w4: bench.w4?.benchPct ?? null,
    w12: bench.w12?.benchPct ?? null,
  };

  const untestedRow = (
    symbol: string,
    label: string,
    why: string,
  ): RotationRow => {
    notes.push(`${symbol}: ${why}`);
    return {
      symbol,
      label,
      w1: null,
      w4: null,
      w12: null,
      excess1w: null,
      excess4w: null,
      excess12w: null,
      untested: why,
    };
  };

  const rowFrom = (
    symbol: string,
    label: string,
    members: readonly string[],
  ): RotationRow => {
    const stale = members.filter((member) => {
      const newest = newestDay(bars.get(member), asOf);
      return newest === undefined || newest < asOf;
    });
    if (stale.length === members.length) {
      const newest = newestDay(bars.get(members[0]!), asOf);
      return untestedRow(
        symbol,
        label,
        newest === undefined
          ? `no bars at or before ${asOf}`
          : `no bar on ${asOf}; newest ${newest}`,
      );
    }
    const triple = {
      w1: basketExcess({ members, benchmark, bars, fromDay: from.w1, toDay: asOf }),
      w4: basketExcess({ members, benchmark, bars, fromDay: from.w4, toDay: asOf }),
      w12: basketExcess({ members, benchmark, bars, fromDay: from.w12, toDay: asOf }),
    };
    if (stale.length > 0)
      notes.push(`${symbol}: ${stale.join(", ")} have no bar on ${asOf}`);
    return {
      symbol,
      label,
      w1: triple.w1?.basketPct ?? null,
      w4: triple.w4?.basketPct ?? null,
      w12: triple.w12?.basketPct ?? null,
      excess1w: triple.w1?.excessPct ?? null,
      excess4w: triple.w4?.excessPct ?? null,
      excess12w: triple.w12?.excessPct ?? null,
    };
  };

  const rows: RotationRow[] = [
    ...sectorEtfs.map((symbol) => rowFrom(symbol, symbol, [symbol])),
    ...themes.map((theme) =>
      rowFrom(`theme:${theme.id}`, theme.id, theme.instruments),
    ),
  ];
  // excess1w DESC, null last, ties by symbol — the same stability rule the
  // focus tie-break uses, for the same reason: a table that reorders between
  // two runs of the same data is not a ranking.
  rows.sort((a, b) => {
    if (a.excess1w === null && b.excess1w === null)
      return a.symbol.localeCompare(b.symbol, "en");
    if (a.excess1w === null) return 1;
    if (b.excess1w === null) return -1;
    if (a.excess1w !== b.excess1w) return b.excess1w - a.excess1w;
    return a.symbol.localeCompare(b.symbol, "en");
  });
  return { asOf, benchmark, benchmarkReturns, rows, notes };
}
