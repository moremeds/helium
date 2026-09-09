/**
 * The event day's cross-section (#107 item 2).
 *
 * The 2026-09-08 defect this module exists to stop: the premarket page wrote
 * "hardware rallies" and then named exactly two semis, and the user's
 * correction was "问题不是弱，而是你不能只说这两个" — the report may not pick
 * two names out of a basket. So the table is built here, MEMBER BY MEMBER, for
 * every member of every basket, and `weakest` / `strongest` are a SUMMARY of a
 * table the reader already has — never a licence to write only two names.
 *
 * Which day is the event day is arithmetic too, for the same reason #107 gives
 * for ranking the week's names here rather than in a prompt: a model asked to
 * pick "the interesting day" picks the one its story needs. The day is the one
 * where some basket moved furthest from SPY, and `pickedBy` says so in words.
 *
 * Nothing in this module fetches. It is pure so the selection and the
 * arithmetic can be tested against frozen real closes.
 * @module dsh-plugin-tenant-option-wizard/quality/event-day
 */

/** One day of one symbol, in apex 0.1.6's `/v1/equity/returns` field
 *  spelling — `return` is the day's return against the prior close, as a
 *  fraction, and is null when either close is missing. */
export interface DayPoint {
  date: string;
  close: number | null;
  return: number | null;
}

/** A basket the report speaks about as a unit: an argon watchlist chain, or a
 *  declared theme. `id` is what the reader sees. */
export interface BasketSpec {
  id: string;
  kind: "chain" | "theme";
  members: readonly string[];
}

export interface EventDayMember {
  symbol: string;
  ret: number | null;
  excess_vs_basket: number | null;
  /** 1 is the day's best member. Null for a member with no return — an
   *  unpriced name is not last, it is absent from the ranking. */
  rank: number | null;
}

export interface EventDayBasket {
  id: string;
  kind: "chain" | "theme";
  /** Equal-weight mean of the priced members' day returns — the mean of
   *  RETURNS, never the return of a price sum, exactly as `basketExcess`
   *  computes a theme basket. Null when no member priced. */
  ret: number | null;
  excess_vs_spy: number | null;
  members: EventDayMember[];
  /** The lowest and the highest priced member. A SUMMARY of `members`; the
   *  whole distribution is in the rows above it. */
  weakest: string | null;
  strongest: string | null;
  /** "8 of 10" — how much of the basket had a price that day. */
  priced: string;
}

export interface EventDayTable {
  date: string;
  /** Why this date and not another, in words the renderer can print. */
  pickedBy: string;
  /** The days the pick ranged over. Equal to `{date, date}` when the caller
   *  named the date. */
  window: { start: string; end: string };
  /** Each benchmark's own day return, so nobody subtracts anything. */
  benchmarks: Record<string, number | null>;
  baskets: EventDayBasket[];
  crossSection: Array<{
    symbol: string;
    ret: number | null;
    excess_vs_spy: number | null;
  }>;
  /** Symbols the source could not serve, with its own reason. NEVER zero. */
  missing: Array<{ symbol: string; reason: string }>;
  notes: string[];
}

const BENCHMARK = "SPY";

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** That symbol's return on that day, or null. A day the series does not carry
 *  is a null, never a zero: a basket measured to a day it has no bar for
 *  reports a perfectly calm session (`newestBarDay` documents the same trap). */
function dayReturn(
  series: ReadonlyMap<string, readonly DayPoint[]>,
  symbol: string,
  date: string,
): number | null {
  for (const point of series.get(symbol) ?? [])
    if (point.date === date) return finite(point.return);
  return null;
}

/** Equal-weight basket return and how many members carried a price. */
function basketReturn(
  series: ReadonlyMap<string, readonly DayPoint[]>,
  members: readonly string[],
  date: string,
): { ret: number | null; priced: number } {
  const returns = members
    .map((symbol) => dayReturn(series, symbol, date))
    .filter((value): value is number => value !== null);
  if (returns.length === 0) return { ret: null, priced: 0 };
  return {
    ret: returns.reduce((a, b) => a + b, 0) / returns.length,
    priced: returns.length,
  };
}

/**
 * The day some basket moved furthest from SPY.
 *
 * Ties go to the LATER date — two identical spreads a week apart are one
 * story, and the reader is owed the one that is still relevant — and the
 * ordering is total, so two runs over the same window pick the same day.
 */
function pickDay(args: {
  series: ReadonlyMap<string, readonly DayPoint[]>;
  baskets: readonly BasketSpec[];
  days: readonly string[];
}): { date: string; pickedBy: string } | { date: null; pickedBy: string } {
  let best: { date: string; spread: number; basket: string } | undefined;
  for (const date of args.days) {
    const bench = dayReturn(args.series, BENCHMARK, date);
    if (bench === null) continue;
    for (const basket of args.baskets) {
      const { ret } = basketReturn(args.series, basket.members, date);
      if (ret === null) continue;
      const spread = Math.abs(ret - bench);
      if (
        best === undefined ||
        spread > best.spread ||
        (spread === best.spread && date >= best.date)
      )
        best = { date, spread, basket: basket.id };
    }
  }
  if (best === undefined)
    return {
      date: null,
      pickedBy: `no day in the window has both a ${BENCHMARK} return and a priced basket`,
    };
  const first = args.days[0] ?? best.date;
  const last = args.days[args.days.length - 1] ?? best.date;
  return {
    date: best.date,
    pickedBy:
      `max |basket − ${BENCHMARK}| over ${first}..${last}: ${best.basket} on ` +
      `${best.date}, spread ${best.spread.toFixed(4)}`,
  };
}

/**
 * Build the event day's table: every member of every basket, the benchmarks,
 * and the declared cross-section, all on one date.
 *
 * `date` fixes the day; without it the day is picked from `days` by the
 * dispersion rule above. Every number here is a fraction (0.0221 = +2.21 %) and
 * is final: the caller quotes it, nobody recomputes it.
 */
export function eventDayTable(args: {
  series: ReadonlyMap<string, readonly DayPoint[]>;
  baskets: readonly BasketSpec[];
  crossSection: readonly string[];
  /** The candidate days, ascending. Ignored when `date` is given. */
  days: readonly string[];
  date?: string;
  benchmarks?: readonly string[];
  missing?: ReadonlyArray<{ symbol: string; reason: string }>;
  notes?: readonly string[];
}): EventDayTable {
  const notes = [...(args.notes ?? [])];
  const picked =
    args.date === undefined
      ? pickDay({ series: args.series, baskets: args.baskets, days: args.days })
      : { date: args.date, pickedBy: "the caller named this date" };
  const date = picked.date ?? args.days[args.days.length - 1] ?? "";
  if (picked.date === null) notes.push(picked.pickedBy);

  const benchNames = args.benchmarks ?? [BENCHMARK, "QQQ"];
  const benchmarks: Record<string, number | null> = {};
  for (const name of benchNames)
    benchmarks[name] = dayReturn(args.series, name, date);
  const spy = benchmarks[BENCHMARK] ?? null;

  const baskets = args.baskets.map((spec): EventDayBasket => {
    const { ret, priced } = basketReturn(args.series, spec.members, date);
    const rows = spec.members.map((symbol) => ({
      symbol,
      ret: dayReturn(args.series, symbol, date),
    }));
    // Rank over the PRICED rows only, best first. A name with no price is not
    // ranked last; it has no rank at all and says so.
    const ranked = rows
      .filter((row) => row.ret !== null)
      .sort(
        (a, b) => b.ret! - a.ret! || a.symbol.localeCompare(b.symbol, "en"),
      );
    const rank = new Map(ranked.map((row, index) => [row.symbol, index + 1]));
    const members: EventDayMember[] = rows
      .map((row) => ({
        symbol: row.symbol,
        ret: row.ret,
        excess_vs_basket:
          row.ret === null || ret === null ? null : row.ret - ret,
        rank: rank.get(row.symbol) ?? null,
      }))
      // Printed in rank order so the whole distribution reads top to bottom;
      // the unpriced tail keeps its alphabetical order at the end.
      .sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) -
            (b.rank ?? Number.MAX_SAFE_INTEGER) ||
          a.symbol.localeCompare(b.symbol, "en"),
      );
    return {
      id: spec.id,
      kind: spec.kind,
      ret,
      excess_vs_spy: ret === null || spy === null ? null : ret - spy,
      members,
      strongest: ranked[0]?.symbol ?? null,
      weakest: ranked[ranked.length - 1]?.symbol ?? null,
      priced: `${String(priced)} of ${String(spec.members.length)}`,
    };
  });

  const crossSection = [...new Set(args.crossSection)]
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((symbol) => {
      const ret = dayReturn(args.series, symbol, date);
      return {
        symbol,
        ret,
        excess_vs_spy: ret === null || spy === null ? null : ret - spy,
      };
    });

  return {
    date,
    pickedBy: picked.pickedBy,
    window:
      args.date === undefined && args.days.length > 0
        ? { start: args.days[0]!, end: args.days[args.days.length - 1]! }
        : { start: date, end: date },
    benchmarks,
    baskets,
    crossSection,
    missing: [...(args.missing ?? [])],
    notes,
  };
}

/** The frame carries the SUMMARY — the date, why it was picked, and each
 *  basket's two ends. The full member table stays in the tool payload, which
 *  is what the author reads: this block is a pointer, not a substitute. */
export interface EventDaySummary {
  date: string;
  pickedBy: string;
  baskets: Array<{
    id: string;
    ret: number | null;
    excess_vs_spy: number | null;
    weakest: string | null;
    strongest: string | null;
    priced: string;
  }>;
  notes: string[];
}

export function summariseEventDay(table: EventDayTable): EventDaySummary {
  return {
    date: table.date,
    pickedBy: table.pickedBy,
    baskets: table.baskets.map((basket) => ({
      id: basket.id,
      ret: basket.ret,
      excess_vs_spy: basket.excess_vs_spy,
      weakest: basket.weakest,
      strongest: basket.strongest,
      priced: basket.priced,
    })),
    notes: [...table.notes],
  };
}
