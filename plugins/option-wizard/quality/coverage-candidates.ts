/**
 * The coverage-selection pre-pass (#106 / #107 item 2).
 *
 * The weekly author used to be handed the raw basket and asked to pick what
 * mattered; four helium-self loops (09-06/07) showed that asking a model to
 * "try harder" buys nothing, and #105 showed that a model handed only basket
 * rows writes only about the basket. So the SELECTION is arithmetic and
 * happens here: `ow_stock_week`'s payload is ranked deterministically, the top
 * N are handed over with their numbers, and the model reads a list it may not
 * re-rank.
 *
 * Nothing in this module fetches. It is pure so the ranking and the missing
 * guard can be tested against frozen real prices.
 * @module dsh-plugin-tenant-option-wizard/quality/coverage-candidates
 */

import type { CalendarRow } from "./frame.js";

/** How many ranked stocks the frame carries. Fixed and named: a cap the caller
 *  can pass is a cap a prompt can argue with. Eight is one screen of rows and
 *  still more than the five names the 2026-09-06 weekly managed to discuss. */
export const COVERAGE_CANDIDATE_LIMIT = 8;

/** The same list on a daily run. Same mechanism, smaller: a daily brief is
 *  300 words of market prose against the weekly's 900, so eight ranked names
 *  would be a table nobody could call. Five is what fits. */
export const DAILY_COVERAGE_CANDIDATE_LIMIT = 5;

/** The cap for a run of this phase. An unphased host — a test, an older
 *  runner — keeps the eight it had before this function existed, because a
 *  silent cut is worse than a cadence this code cannot see. */
export function candidateLimit(phase: string | undefined): number {
  return phase === undefined || phase === "weekly"
    ? COVERAGE_CANDIDATE_LIMIT
    : DAILY_COVERAGE_CANDIDATE_LIMIT;
}

/** One row of `ow_stock_week`'s `results`, in the apex 0.1.6 field spelling. */
export interface StockWeekRow {
  symbol: string;
  window_return: number | null;
  excess_vs_spy: number | null;
  excess_vs_qqq: number | null;
  ytd_return?: number | null;
  pct_from_52w_high?: number | null;
  daily?: Array<{ date: string; close: number | null; return: number | null }>;
}

/** `ow_stock_week`'s payload, as the tool emits it. */
export interface StockWeekPayload {
  start?: unknown;
  end?: unknown;
  source?: unknown;
  benchmarks?: Record<string, { window_return?: number | null } | undefined>;
  results?: unknown;
  missing?: unknown;
  notes?: unknown;
}

/** The completed earnings a candidate reported INSIDE the reported week, as
 *  `ow_uw_earnings_report` wrote them.
 *
 *  Every field is the tool's own string, copied — `actualEps` and
 *  `streetMeanEst` are strings in the UW response and stay strings here, so
 *  the surprise is never computed by anyone who is not asked to. There is no
 *  `surprise` field for that reason: the tool's own `limitations` say EPS
 *  basis is not provided, and a difference of two numbers whose basis is
 *  unstated is a number nobody can settle. */
export interface CandidateEarnings {
  reportDate: string;
  endingFiscalQuarter?: string;
  actualEps: string;
  streetMeanEst: string | null;
  reportTime: string | null;
  sourceUrl: string;
}

/** A headline, as a CITATION and nothing else (#106 Loop 2 item 3). Left empty
 *  by this build; helium #113 fills it. Never a number source: a figure inside
 *  a headline is the publisher's arithmetic, not a payload the settler can
 *  re-read. `link` is optional because the UW news feed carries no URL (see
 *  `ow_uw_headlines`, verified 2026-09-03) — an invented one is a citation the
 *  reader cannot check. */
export interface CandidateHeadline {
  title: string;
  published: string;
  provider: string;
  link?: string;
}

export interface CandidateRow {
  /** The LEDGER row id for this name, `stock:<SYMBOL>`. It exists so a weekly
   *  call on a single name mints a commitment through the same path a macro,
   *  sector or theme row does (`render/review.ts:verdictCommitments`) — before
   *  this, a call on SNDK printed and settled against nothing. */
  id: string;
  rank: number;
  symbol: string;
  window_return: number | null;
  excess_vs_spy: number | null;
  excess_vs_qqq: number | null;
  /** WHICH number ordered this row. A reader must be able to see that a row
   *  ranked on its own return had no benchmark, not that we hid one. */
  rankedOn: "excess_vs_spy" | "window_return";
  /** Set only when this name REPORTED inside the reported week. */
  earnings?: CandidateEarnings;
  /** Citations only; empty until #113. */
  headlines?: CandidateHeadline[];
}

/** The ledger row id of a single name. One function, two readers — the ranker
 *  writes it and `render/review.ts` mints against it — so the id scheme can
 *  never drift into two spellings. */
export function stockRowId(symbol: string): string {
  return `stock:${symbol}`;
}

export interface CoverageCandidates {
  window: { start: string; end: string };
  source: string;
  /** Ranked, at most `COVERAGE_CANDIDATE_LIMIT`. */
  stocks: CandidateRow[];
  /** The week's dated events, already filtered and sorted by the frame. */
  events: CalendarRow[];
  /** Symbols the source could not serve, with its own reason. NEVER zero. */
  missing: Array<{ symbol: string; reason: string }>;
  notes: string[];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The rows of a payload, defensively: a source that answered with a refusal
 *  (`{unavailable: "as-of"}`) has no `results` and must not read as an empty
 *  week. */
function rowsOf(payload: StockWeekPayload): StockWeekRow[] {
  if (!Array.isArray(payload.results)) return [];
  const out: StockWeekRow[] = [];
  for (const raw of payload.results) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const symbol = text(row.symbol);
    if (symbol === "") continue;
    out.push({
      symbol,
      window_return: finite(row.window_return),
      excess_vs_spy: finite(row.excess_vs_spy),
      excess_vs_qqq: finite(row.excess_vs_qqq),
    });
  }
  return out;
}

function missingOf(
  payload: StockWeekPayload,
): Array<{ symbol: string; reason: string }> {
  if (!Array.isArray(payload.missing)) return [];
  const out: Array<{ symbol: string; reason: string }> = [];
  for (const raw of payload.missing) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const symbol = text(row.symbol);
    if (symbol === "") continue;
    out.push({ symbol, reason: text(row.reason) || "no reason given" });
  }
  return out;
}

/**
 * Rank the week's stocks by how far they moved AGAINST the market, and hand
 * back that list beside the week's dated events.
 *
 * `|excess_vs_spy|` is the ordering key — a name that merely rode the tape is
 * not a story — and `|window_return|` is the fallback for a row whose
 * benchmark the source could not compute. Both directions count: the worst
 * name of the week is as much of a story as the best.
 *
 * A row with neither number is NOT ranked and NOT zeroed; it earns a note. A
 * symbol the source put in `missing` stays missing, verbatim.
 */
export function rankCoverageCandidates(args: {
  payload: StockWeekPayload;
  events: readonly CalendarRow[];
  limit?: number;
}): CoverageCandidates {
  const { payload } = args;
  const limit = args.limit ?? COVERAGE_CANDIDATE_LIMIT;
  const notes: string[] = [];
  const rows = rowsOf(payload);

  const scored: Array<{
    row: StockWeekRow;
    score: number;
    on: CandidateRow["rankedOn"];
  }> = [];
  const unrankable: string[] = [];
  for (const row of rows) {
    if (row.excess_vs_spy !== null) {
      scored.push({
        row,
        score: Math.abs(row.excess_vs_spy),
        on: "excess_vs_spy",
      });
    } else if (row.window_return !== null) {
      scored.push({
        row,
        score: Math.abs(row.window_return),
        on: "window_return",
      });
    } else {
      unrankable.push(row.symbol);
    }
  }
  // Score descending, then symbol ascending — two names that moved identically
  // must not swap places between runs.
  scored.sort(
    (a, b) =>
      b.score - a.score || a.row.symbol.localeCompare(b.row.symbol, "en"),
  );

  const stocks: CandidateRow[] = scored.slice(0, limit).map((entry, index) => ({
    id: stockRowId(entry.row.symbol),
    rank: index + 1,
    symbol: entry.row.symbol,
    window_return: entry.row.window_return,
    excess_vs_spy: entry.row.excess_vs_spy,
    excess_vs_qqq: entry.row.excess_vs_qqq,
    rankedOn: entry.on,
  }));

  if (scored.length > stocks.length)
    notes.push(
      `ranked ${String(stocks.length)} of ${String(scored.length)} priced symbols`,
    );
  if (unrankable.length > 0)
    notes.push(
      `no week return for ${unrankable.sort((a, b) => a.localeCompare(b, "en")).join(", ")} — left unranked, not zeroed`,
    );
  const missing = missingOf(payload);
  if (missing.length > 0)
    notes.push(
      `missing from the source: ${missing.map((row) => `${row.symbol} (${row.reason})`).join("; ")}`,
    );
  if (rows.length === 0 && missing.length === 0)
    notes.push("ow_stock_week returned no rows");
  for (const note of Array.isArray(payload.notes) ? payload.notes : [])
    if (typeof note === "string") notes.push(note);

  return {
    window: { start: text(payload.start), end: text(payload.end) },
    source: text(payload.source) || "unknown",
    stocks,
    events: [...args.events],
    missing,
    notes,
  };
}

/**
 * The one row of an `ow_uw_earnings_report` payload that falls INSIDE the
 * reported week, or `null`.
 *
 * Pure, and here rather than in the clerk step, because the window test is the
 * whole point: SNDK's newest completed report on 2026-09-08 was 2026-08-05,
 * three weeks before the reported window, and printing it beside a
 * 2026-08-31..09-04 week return would read as this week's cause. `statements`
 * is deliberately not read — the tool's own `limitations` say the quarter
 * labels and EPS basis are not a contract to join.
 *
 * Every field is copied as the source spelled it. `actualEps` and
 * `streetMeanEst` are strings in the UW response and stay strings: nobody here
 * subtracts them.
 */
export function inWindowEarnings(
  payload: unknown,
  window: { start: string; end: string },
): CandidateEarnings | null {
  const rows = (payload as { earnings?: unknown } | null)?.earnings;
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const date = row.reportDate;
    const eps = row.actualEps;
    if (
      typeof date !== "string" ||
      date < window.start ||
      date > window.end ||
      typeof eps !== "string"
    )
      continue;
    return {
      reportDate: date,
      ...(typeof row.endingFiscalQuarter === "string"
        ? { endingFiscalQuarter: row.endingFiscalQuarter }
        : {}),
      actualEps: eps,
      streetMeanEst:
        typeof row.streetMeanEst === "string" ? row.streetMeanEst : null,
      reportTime: typeof row.reportTime === "string" ? row.reportTime : null,
      sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : "",
    };
  }
  return null;
}

const DAY_MS = 86_400_000;

/**
 * The Monday–Friday the weekly reports on: the latest Friday on or before
 * `day`, and the Monday four days before it.
 *
 * Anchored on the FRIDAY, not on the run day's own ISO week, because a weekly
 * that slips to a Monday morning must still report the week that closed —
 * `2026-09-06` (Sunday) and `2026-09-07` (Monday) both give
 * `2026-08-31 → 2026-09-04`.
 *
 * The returned dates are the trading-week boundary. The RETURN measured over
 * that window is based on the prior Friday's close — see `ow_stock_week` and
 * the renderer preamble, which say so in words.
 */
export function reportedWeek(day: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day.trim());
  if (match === null) return { start: "", end: "" };
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const weekday = new Date(time).getUTCDay(); // 0 Sun … 6 Sat
  // Friday is 5. Sunday(0) is two days past it, Saturday(6) one.
  const back = (weekday + 2) % 7;
  const friday = time - back * DAY_MS;
  return {
    start: new Date(friday - 4 * DAY_MS).toISOString().slice(0, 10),
    end: new Date(friday).toISOString().slice(0, 10),
  };
}
