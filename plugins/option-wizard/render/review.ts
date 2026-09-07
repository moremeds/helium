/**
 * The review document: what the weekly analyst and the editor return for the
 * seven-section review, parsed and reported on.
 *
 * SCHEMA HALF. No numbers, no section titles, no as-of and no tool name reach
 * this document — titles and every figure are renderer-supplied, and a model
 * that tried to send one would simply have it ignored.
 *
 * Three refusals are the whole point of the file:
 *
 * - **A verdict with no usable probability mints no commitment.** `p` outside
 *   [0.5, 0.95] or absent leaves the row printable but UNSCORABLE, and says so
 *   (spec C.5, Tetlock: probability-bearing or unscorable). A token alone
 *   cannot be Brier-scored, so admitting one to the ledger would put a row in
 *   the denominator that can never be settled.
 * - **A theme's verdict does not live in `themes[]`.** A theme IS a coverage
 *   row, so its token arrives through `coverage[]`; `themes[]` carries only the
 *   §H.4 leadership sentence.
 * - **Nothing is padded.** A malformed entry is dropped with a problem string;
 *   the renderer prints `untested` or `—` for the row it belonged to, and the
 *   gap counters go up.
 * @module dsh-plugin-tenant-option-wizard/render/review
 */

import type { CommitmentDraft, RunMetric } from "@helium/core";
import { isOpen, VERDICT_BANDS } from "../eval/verdict.js";
import type { TenantCalendar } from "../eval/bars.js";
import type { CoverageRow } from "../quality/channels.js";
import type {
  CalendarRow,
  OpenRow,
  SessionFrame,
  SettledRow,
} from "../quality/frame.js";
import type { RotationRow } from "../quality/themes.js";
import { REVIEW_PERIODS, type ReviewPeriod } from "../quality/review-config.js";
import type { Section } from "./index.js";
import { trim, words, type ReviewCaps } from "./budget.js";
import { fmt, fmtSigned, unitFromToken, type Unit } from "../quality/units.js";

/** Aliases so no quoted cadence name appears in this directory. See
 *  `REVIEW_PERIODS`. */
const WEEKLY = REVIEW_PERIODS[0];
const DAILY = REVIEW_PERIODS[1];

export const VERDICT_TOKENS = [
  "continue",
  "reverse",
  "strengthen",
  "fade",
  "untested",
] as const;
export type VerdictToken = (typeof VERDICT_TOKENS)[number];

export const LEADERSHIP = ["confirms", "contradicts", "mixed"] as const;
export type Leadership = (typeof LEADERSHIP)[number];

/** Tetlock's floor and ceiling. Below 0.5 the token and the probability
 *  disagree; above 0.95 nothing is ever settled against it. */
export const P_MIN = 0.5;
export const P_MAX = 0.95;

export interface CoverageEntry {
  id: string;
  token: VerdictToken;
  /** Absent when the model gave none, or gave one outside [P_MIN, P_MAX]. */
  p?: number;
  why: string;
  /** What settles it — the observable the next period reads. */
  observable: string;
  /** False when `p` is absent or out of range: the row prints, and mints no
   *  commitment. */
  scorable: boolean;
}

export interface FocusEntry {
  ticker: string;
  why: string;
}

export interface ThemeEntry {
  id: string;
  leadership: Leadership;
  why: string;
}

export interface ReviewDoc {
  review: string;
  outlook: string;
  catalysts: string;
  coverage: CoverageEntry[];
  focus: FocusEntry[];
  themes: ThemeEntry[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function parseReviewDoc(value: unknown): {
  doc: ReviewDoc | null;
  problems: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { doc: null, problems: ["document is not an object"] };
  const row = value as Record<string, unknown>;
  const problems: string[] = [];

  const coverage: CoverageEntry[] = [];
  if (Array.isArray(row.coverage))
    for (const entry of row.coverage) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const token = text(cell.token);
      if (id === undefined) {
        problems.push("coverage: an entry has no id");
        continue;
      }
      if (
        token === undefined ||
        !(VERDICT_TOKENS as readonly string[]).includes(token)
      ) {
        problems.push(
          `coverage ${id}: token must be one of ${VERDICT_TOKENS.join(", ")}`,
        );
        continue;
      }
      const p = cell.p;
      const usable =
        typeof p === "number" && Number.isFinite(p) && p >= P_MIN && p <= P_MAX;
      if (!usable && token !== "untested")
        problems.push(
          `coverage ${id}: p ${String(p)} is not in [${String(P_MIN)}, ${String(P_MAX)}] — the row prints and mints no commitment`,
        );
      coverage.push({
        id,
        token: token as VerdictToken,
        ...(usable ? { p: p as number } : {}),
        why: text(cell.why) ?? "",
        observable: text(cell.observable) ?? "",
        scorable: usable,
      });
    }

  const focus: FocusEntry[] = [];
  if (Array.isArray(row.focus))
    for (const entry of row.focus) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const ticker = text(cell.ticker);
      if (ticker === undefined) {
        problems.push("focus: an entry has no ticker");
        continue;
      }
      focus.push({ ticker, why: text(cell.why) ?? "" });
    }

  const themes: ThemeEntry[] = [];
  if (Array.isArray(row.themes))
    for (const entry of row.themes) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const leadership = text(cell.leadership);
      if (id === undefined) {
        problems.push("themes: an entry has no id");
        continue;
      }
      if (
        leadership === undefined ||
        !(LEADERSHIP as readonly string[]).includes(leadership)
      ) {
        problems.push(
          `themes ${id}: leadership must be one of ${LEADERSHIP.join(", ")}`,
        );
        continue;
      }
      themes.push({
        id,
        leadership: leadership as Leadership,
        why: text(cell.why) ?? "",
      });
    }

  return {
    doc: {
      review: text(row.review) ?? "",
      outlook: text(row.outlook) ?? "",
      catalysts: text(row.catalysts) ?? "",
      coverage,
      focus,
      themes,
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// rendering half
// ---------------------------------------------------------------------------

/** Spec §J.1's SEVEN fixed titles, in order. Sections 1/3/5/6/7 bodies are
 *  built here; 2 and 4 are the model's, trimmed. Section 3 carries four
 *  sub-blocks — 3a macro, 3b sectors, 3c themes, 3d rotation (weekly only). */
export const REVIEW_TITLES = [
  "1 · Scorecard",
  "2 · 上周复盘",
  "3 · Coverage",
  "4 · 下周展望",
  "5 · Dated catalysts",
  "6 · Focus",
  "7 · Open calls",
] as const;

/** A Flash page is a market report. Scorecards and call registers remain in
 * `otherSections` for the harness, but are not reader prose. */
export const MARKET_REPORT_TITLES = [
  "Market review",
  "Outlook",
  "Dated catalysts",
  "Supporting coverage",
] as const;

export type { CalendarRow } from "../quality/frame.js";

export interface RotationResult {
  asOf: string;
  benchmark: string;
  benchmarkReturns: {
    w1: number | null;
    w4: number | null;
    w12: number | null;
  };
  rows: RotationRow[];
  notes?: string[];
}

export interface FocusViewRow {
  ticker: string;
  event: string;
  why: string;
  ivRank?: number;
  openCall?: string;
  sticky?: boolean;
}

export interface ThemeViewRow {
  id: string;
  token: string;
  excess1w: string;
  excessSinceEntered: string;
  leadership?: string;
  why?: string;
  kill: string;
  killMet: boolean;
}

const NO_DATUM = "no datum this period";
/** The stand-in §3 prints for a priced row the author never answered. */
const NOT_CALLED = "not called this period";
/** No inline emphasis in a section body, anywhere. argon's `SectionsPanel`
 *  renders BLOCK-level markdown only — paragraphs, pipe tables, dash lists —
 *  so a `**token**` reaches the public /flash page as literal asterisks. The
 *  verdict token is printed in plain uppercase instead, which reads as
 *  emphasis in both renderings. */
/** How far back a datum may be dated before §2/§4 must not quote it. Calendar
 *  days, because an as-of is a wall-clock stamp and the period is a wall-clock
 *  window; the OPEN-session arithmetic lives in the frame, not here. */
const STALE_DAYS = { [WEEKLY]: 7, [DAILY]: 3 } as const;
/** Addendum A3. Under this many settled verdict receipts the calibration
 *  sentence says so rather than printing a number nobody can act on. */
const CALIBRATION_MIN = 10;
const CALIBRATION_BAND = 0.15;

/** A RATE — a hit rate, a Brier mean, a calibration probability. Not a market
 *  unit, so it carries no `quality/units.ts` entry; two decimals is what a
 *  probability between 0 and 1 is readable at. */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

/** A number in a named unit, or an em dash. Every printed figure in the review
 *  sections goes through this or through `fmtSigned`. */
function show(value: number | null | undefined, unit: Unit): string {
  return value === null || value === undefined ? "—" : fmt(value, unit);
}

function showSigned(value: number | null | undefined, unit: Unit): string {
  return value === null || value === undefined ? "—" : fmtSigned(value, unit);
}

/** Every percent inside a SOURCE-WRITTEN string, at the units table's own
 *  precision. The calendar's `forecast` is a string the provider composed, so
 *  the renderer rounds what it prints rather than re-deriving the number:
 *  `implied move 6.9333%` prints as `implied move 6.9%`. Only a number that
 *  carries a decimal point AND a trailing `%` is touched; an integer percent
 *  and every other figure in the string come through untouched. */
function roundPercents(value: string): string {
  return value.replace(
    /(-?\d+\.\d+)\s*%/gu,
    (_match, digits: string) => `${fmt(Number(digits), "pct")}%`,
  );
}

/** The unit a move string carries, so a band prints in the row's own unit.
 *  Taken from the string the extractor already formatted — never guessed. */
function unitOf(move: string | undefined): string {
  if (move === undefined) return "";
  const match = /[-+0-9.,]+\s*([a-zA-Z%$]+)/u.exec(move);
  return match?.[1] ?? "";
}

/** Weekday arithmetic only: a market holiday is NOT skipped here. Use
 *  `nextOpenDay` for anything a settler will later count. */
function nextWeekday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

/** The next day the tenant says the market is OPEN, by the settler's own
 *  `isOpen`. Bounded because the closed list is tenant data: a malformed run of
 *  closed days must not spin the renderer. */
function nextOpenDay(day: string, calendar?: TenantCalendar): string {
  let out = nextWeekday(day);
  for (let step = 0; step < 14 && !isOpen(out, calendar); step += 1)
    out = nextWeekday(out);
  return out;
}

function priorWeekday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  do date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

// --- the ledger lines -------------------------------------------------------

function payloadOf(row: { payload: unknown }): Record<string, unknown> {
  return row.payload !== null && typeof row.payload === "object"
    ? (row.payload as Record<string, unknown>)
    : {};
}

function detailOf(row: { detail?: unknown }): Record<string, unknown> {
  return row.detail !== null && typeof row.detail === "object"
    ? (row.detail as Record<string, unknown>)
    : {};
}

/** Brier's own range, so a reader can size the number without knowing which
 *  scorer wrote it: binary is 0..1, the three-class resolution score is 0..2. */
function scoreOf(row: SettledRow): { key: string; value: number } | undefined {
  for (const [key, value] of Object.entries(row.scores))
    if (typeof value === "number" && Number.isFinite(value))
      return { key, value };
  return undefined;
}

export function citationLine(row: SettledRow): string {
  const payload = payloadOf(row);
  const detail = detailOf(row);
  const parts = [
    row.id,
    `issued ${row.issuedDay} ${row.issuedPhase}`,
    row.status,
  ];
  if (payload.kind === "spy-direction") {
    const reference = (payload.referenceClose ?? {}) as { value?: unknown };
    parts.push(
      `t${String(payload.horizonBars ?? "?")} vs ${
        typeof reference.value === "number"
          ? fmt(reference.value, "price")
          : String(reference.value ?? "?")
      }`,
    );
  } else if (typeof payload.p === "number") {
    parts.push(`said p=${String(payload.p)}`);
  }
  parts.push(`got ${String(detail.got ?? row.status)}`);
  const score = scoreOf(row);
  if (score !== undefined)
    parts.push(
      `Brier ${score.value.toFixed(4)} (0..${score.key === "resolutionBrier" ? "2" : "1"})`,
    );
  if (row.evidenceHash !== undefined)
    parts.push(`bars ${row.evidenceHash.slice(0, 8)}`);
  return parts.join(" · ");
}

export function pendingLine(row: OpenRow): string {
  const head = `${row.id} · issued ${row.issuedDay} ${row.issuedPhase} · pending`;
  return row.barsSeen === undefined || row.deadlineBars === undefined
    ? head
    : `${head} (${String(row.barsSeen)} of ${String(row.deadlineBars)} bars seen)`;
}

/**
 * The day a still-open commitment comes due, from its own payload.
 *
 * A `focus-admit` carries the window it settles over; a coverage verdict
 * carries `settleAfterOpenDays` and is counted forward from the issue day over
 * the TENANT'S calendar, which is what the settler counts over too
 * (`eval/verdict.ts`). Weekday arithmetic alone printed "settles 2026-09-07"
 * for a call issued the Friday before Labor Day — a day the market is shut and
 * no receipt can ever land. A direction leg carries neither — it settles on
 * BARS — and gets `undefined`.
 */
export function settleDay(
  row: OpenRow,
  calendar?: TenantCalendar,
): string | undefined {
  const payload = payloadOf(row);
  const window = payload.window;
  if (window !== null && typeof window === "object") {
    const to = (window as { toDay?: unknown }).toDay;
    if (typeof to === "string" && to !== "") return to;
  }
  const after = payload.settleAfterOpenDays;
  if (typeof after !== "number" || !Number.isFinite(after)) return undefined;
  let day = row.issuedDay;
  for (let step = 0; step < after; step += 1) day = nextOpenDay(day, calendar);
  return day;
}

/**
 * §7's one line per outstanding call: what was called, at what probability, and
 * when it comes due.
 *
 * NO COMMITMENT ID. The id is `<day>-<phase>-<kind>-<row>`, so printing it puts
 * the issue day, the run label and the kind on the page three times over, and
 * on 2026-09-06 §1 and §7 between them carried 36 of them. The row NAME is the
 * only part a reader can act on; the id stays in the ledger, where it is
 * addressable.
 */
export function openCallLine(row: OpenRow, calendar?: TenantCalendar): string {
  const payload = payloadOf(row);
  const name =
    typeof payload.rowId === "string"
      ? payload.rowId
      : typeof payload.ticker === "string"
        ? payload.ticker
        : typeof payload.symbol === "string"
          ? payload.symbol
          : row.id;
  const verdict =
    typeof payload.token === "string"
      ? payload.token.toUpperCase()
      : payload.kind === "focus-admit"
        ? "MOVES"
        : payload.kind === "spy-direction"
          ? "DOWN"
          : "OPEN";
  const p = typeof payload.p === "number" ? payload.p : payload.pDown;
  const said = typeof p === "number" ? ` p=${p.toFixed(2)}` : "";
  const day = settleDay(row, calendar);
  if (day !== undefined) return `${name} · ${verdict}${said} · settles ${day}`;
  return row.deadlineBars === undefined
    ? `${name} · ${verdict}${said}`
    : `${name} · ${verdict}${said} · settles after ${String(row.deadlineBars)} bars`;
}

/** hit / miss / null. `null` is "not a two-sided call" — a direction leg that
 *  settled `up` is neither, and counting it either way would move a rate
 *  nobody agreed on. */
function outcomeOf(row: SettledRow): "hit" | "miss" | null {
  if (row.status === "pending") return null;
  if (row.status === "hit") return "hit";
  if (row.status === "miss") return "miss";
  const detail = detailOf(row);
  if (typeof detail.said === "string" && typeof detail.got === "string")
    return detail.said === detail.got ? "hit" : "miss";
  return null;
}

// --- section 3 --------------------------------------------------------------

/** Addendum A5. The band a token claims, in the row's own unit, from the same
 *  constant `eval/verdict.ts` scores against. */
function bandText(token: string, delta: number, unit: string): string {
  const named = unitFromToken(unit);
  const size = Math.abs(delta);
  // Every band is a multiple of the prior magnitude, so a nil prior has no
  // band: the review-v6 close printed `flow — 39758465 → +0 USD — CONTINUE
  // (0USD..0USD)`, a verdict inside an empty interval. `classify` returns null
  // on the same input and the receipt stays pending; this is the same fact,
  // printed.
  if (size === 0) return "(no prior move)";
  const low = fmt(size * VERDICT_BANDS.continueLow, named);
  const high = fmt(size * VERDICT_BANDS.continueHigh, named);
  const mag = fmt(size, named);
  switch (token) {
    case "strengthen":
      return `(>${high}${unit} = ${String(VERDICT_BANDS.continueHigh)}x prior |Δ| ${mag}${unit})`;
    case "continue":
      return `(${low}${unit}..${high}${unit})`;
    case "fade":
      return `(<${low}${unit})`;
    case "reverse":
      return "(sign flip)";
    default:
      return "";
  }
}

/** An excess is a DIFFERENCE, so it always carries its sign: "+1.7%" and
 *  "-1.7%" are the two answers, and "1.7%" is neither. */
function signed(value: number): string {
  return fmtSigned(value, "pct");
}

function themeTriple(row: CoverageRow): { week: string; since: string } {
  const week = row.theme?.week;
  const since = row.theme?.sinceEntered;
  return {
    week:
      week === null || week === undefined ? "—" : `${signed(week.excessPct)}%`,
    since:
      since === null || since === undefined
        ? "—"
        : `${signed(since.excessPct)}%`,
  };
}

/**
 * What section 3's bullet used to carry and no longer prints.
 *
 * NOT a second rendering: nothing here reaches the reader as prose. It exists
 * so cutting the band, the observable, the member list and the left-out reason
 * out of the visible line loses no datum — argon can build a real table from
 * it, and a later run can read what a row was priced at without re-parsing a
 * sentence.
 */
export interface CoverageDetail {
  id: string;
  level?: string;
  prior?: string;
  move?: string;
  asOf?: string;
  members?: string[];
  /** The interval the printed token claims, from `eval/verdict.ts`. */
  band?: string;
  /** The model's "what settles it" clause. */
  observable?: string;
  rendererFilled?: true;
  untested?: string;
  /** Why this row counted as a gap, in the source's own words. */
  leftOut?: string;
}

export interface ReviewSectionsArgs {
  frame: SessionFrame;
  /** The `ow_rotation` payload; null on a daily run. */
  rotation: RotationResult | null;
  doc: ReviewDoc | null;
  caps: ReviewCaps;
  /** From the emitting TASK id, never a phase. */
  period: ReviewPeriod;
  calendarRows: CalendarRow[];
  /** The tenant's open/closed days, so a printed settle date lands on a day the
   *  settler can actually settle. Absent means weekdays only. */
  calendar?: TenantCalendar;
}

export interface ReviewSectionsResult {
  sections: Section[];
  /** Renderer-owned records kept out of the public weekly report. */
  internalSections?: Section[];
  faults: string[];
  gaps: number;
  citations: number;
  admitted: string[];
  notAdmitted: string[];
  focusWhyMissing: number;
  focusWhyRejected: number;
  staleRowsQuoted: number;
  proposed: Array<{ id: string; thesis: string; evidence: string }>;
  view: {
    focus?: {
      period: ReviewPeriod;
      rows: FocusViewRow[];
      shortfall?: string;
      churn: number;
    };
    themes?: ThemeViewRow[];
    rotation?: { asOf: string; benchmark: string; rows: RotationRow[] };
    /** One entry per coverage row, in the same order §3 printed them. */
    coverageDetail?: CoverageDetail[];
  };
}

const PROPOSED =
  /^PROPOSED:\s+([a-z0-9][a-z0-9-]{2,63})\s+—\s+([^—]{3,200}?)\s+—\s+evidence:\s+(.{3,200})$/u;

/** `PROPOSED: <id> — <thesis> — evidence: <source>`, one per line. A proposal
 *  is NOT a row: it mints nothing, it enters no focus score, and its id is not
 *  a coverage row id. This is what stops the model inventing a fresh rotation
 *  every Sunday. */
export function proposedThemes(
  outlook: string,
): Array<{ id: string; thesis: string; evidence: string }> {
  const out: Array<{ id: string; thesis: string; evidence: string }> = [];
  for (const line of outlook.split("\n")) {
    const match = PROPOSED.exec(line.trim());
    if (match === null) continue;
    out.push({
      id: match[1]!,
      thesis: match[2]!.trim(),
      evidence: match[3]!.trim(),
    });
  }
  return out;
}

/** Any commitment id shaped like the ones `render/ledger.ts` mints. Used only
 *  to check that §2 discusses ids that section 1 actually printed. */
const COMMITMENT_ID = /\b\d{4}-\d{2}-\d{2}-[a-z]+-[A-Za-z0-9.:_-]+\b/gu;

/** What counts as NAMING an event in §5: a three-or-more-capital acronym
 *  (FOMC, CPI, NFP, PCE) or an ISO day. Two capitals are left alone on
 *  purpose — "ET", "US" and "PM" are units and places, not events. */
const EVENT_NAME = /\b(?:[A-Z]{3,8}|\d{4}-\d{2}-\d{2})\b/gu;

/**
 * A focus `why` that restates its own row and stops.
 *
 * The shape, verbatim from the 2026-09-06 weekly: an ISO event day, then the
 * implied move as a percent, then `IV expects <noun>`. Both figures are printed
 * in their own columns of the same table row, so the sentence adds a noun and
 * nothing else. Deliberately narrow — it matches THIS template, not any
 * sentence that happens to carry a date and a percent, because a real judgment
 * about a name will usually carry both.
 */
export const FOCUS_WHY_DATE_RESTATE =
  /\b\d{4}-\d{2}-\d{2}\b[^\n]{0,40}?\b\d+(?:\.\d+)?\s*%\s*IV\s+expects\b/iu;

export function reviewSections(args: ReviewSectionsArgs): ReviewSectionsResult {
  const { frame, doc, caps, period } = args;
  const faults: string[] = [];
  const sections: Section[] = [];

  // ---------------- section 1: the scorecard, zero model words -------------
  const settled = frame.ledger.settledToday;
  const open = frame.ledger.open;
  const scored = settled.filter((row) => row.status !== "pending");
  const outcomes = settled
    .map((row) => outcomeOf(row))
    .filter((value): value is "hit" | "miss" => value !== null);
  const hits = outcomes.filter((value) => value === "hit").length;
  const briers = settled
    .map((row) => row.scores.verdictBrier)
    .filter((value): value is number => typeof value === "number");
  const verdictBrier =
    briers.length === 0
      ? null
      : briers.reduce((a, b) => a + b, 0) / briers.length;
  const focusSettled = settled.filter(
    (row) => payloadOf(row).kind === "focus-admit",
  );
  const focusHits = focusSettled.filter((row) => row.status === "hit").length;
  const focusOpen = open.filter(
    (row) => payloadOf(row).kind === "focus-admit",
  ).length;

  const rows = frame.rows;
  const entries = new Map(
    (doc?.coverage ?? []).map((entry) => [entry.id, entry]),
  );
  // A row is UNCALLED when it has no datum, when the model gave it no entry at
  // all, or when the entry's own token is `untested` — the model declining is
  // still a row nobody called, and counting it any other way made the document
  // disagree with itself: the 2026-09-06 acceptance run printed 19 `UNTESTED`
  // rows over a `coverageGaps` of 16.
  const untestedReason = (row: CoverageRow): string | undefined => {
    // A renderer-filled row is never a gap: the number is in hand, and no
    // model entry is expected for it.
    if (row.rendererFilled === true && row.untested === undefined)
      return undefined;
    if (row.untested !== undefined) return row.untested;
    const entry = entries.get(row.id);
    if (entry === undefined) return "no verdict token for this row";
    if (entry.token === "untested")
      return entry.why === "" ? "the author called it untested" : entry.why;
    return undefined;
  };
  const untested = rows.filter((row) => untestedReason(row) !== undefined);
  const gaps = untested.length;

  // FOUR LINES, AND A READER CAN HOLD ALL FOUR. What stood here on 2026-09-06
  // was two metric-name lines, then one line per commitment — 24 ids, each
  // repeating its issue day and run label — then a focus line, a calibration
  // line and a footer. Nothing in it answered "how did we do", and the ids are
  // in the ledger, which is where an id belongs. `citations` still counts the
  // receipts; it is a metric, not a paragraph.
  const citationLines = [...settled]
    .sort((a, b) => b.issuedDay.localeCompare(a.issuedDay))
    .map((row) => citationLine(row));
  let calibration = "";
  if (period === WEEKLY) {
    const verdicts = settled.filter(
      (row) => payloadOf(row).kind === "coverage-verdict",
    );
    if (verdicts.length < CALIBRATION_MIN) {
      calibration = ` · calibration n=${String(verdicts.length)}, not yet scorable`;
    } else {
      const ps = verdicts
        .map((row) => payloadOf(row).p)
        .filter((value): value is number => typeof value === "number");
      const meanP = ps.reduce((a, b) => a + b, 0) / ps.length;
      const observed =
        verdicts.filter((row) => outcomeOf(row) === "hit").length /
        verdicts.length;
      const gap = observed - meanP;
      calibration =
        ` · calibration: said p≈${num(meanP)} · hit ${num(observed)} (${String(verdicts.length)})` +
        (gap > CALIBRATION_BAND
          ? " — under-confident"
          : gap < -CALIBRATION_BAND
            ? " — over-confident"
            : "");
    }
  }
  const nextDue = open
    .map((row) => settleDay(row, args.calendar))
    .filter((day): day is string => day !== undefined)
    .sort((a, b) => a.localeCompare(b))[0];
  const scoreLines: string[] = [
    (scored.length === 0
      ? nextDue === undefined
        ? "Nothing settled yet — no call has come due"
        : `Nothing settled yet — first settles ${nextDue}`
      : `${String(scored.length)} settled · hit ${String(hits)}/${String(outcomes.length)} · Brier ${num(verdictBrier)}`) +
      calibration,
    `${String(open.length)} open calls`,
    `Focus: ${String(focusHits)} of ${String(focusSettled.length)} moved ≥ implied · ${String(focusOpen)} open`,
    gaps === 0
      ? "Coverage gaps: none"
      : `Coverage gaps: ${String(gaps)} rows (${untested.map((row) => row.id).join(", ")})`,
  ];
  const scorecard = scoreLines.join("\n");

  // ---------------- section 3: the fixed coverage list ---------------------
  // Built before the prose sections because it supplies the renderer-owned
  // coverage detail those sections accompany.
  const staleBefore = (() => {
    const date = new Date(`${frame.day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - STALE_DAYS[period]);
    return date.toISOString().slice(0, 10);
  })();
  const stale: CoverageRow[] = [];
  // The SAME list `buildFrame` hands the author as `noRestate`, from the same
  // function — so the figures §4 is faulted for and the figures the author was
  // told to avoid can never be two different lists.
  const publicRows = rows.filter((row) => row.id !== "calls.open");
  // FOUR FIELDS, ONE BULLET, AND NOTHING A READER SKIPS. The 2026-09-06 row
  // carried six: the band the token claims, the settling observable, the
  // chain's members and "printed from the ledger" all rode along, and 23 rows
  // of that is the section nobody read. The four that survive are the row, what
  // it did, the call, and why. Everything cut is kept — structured, not
  // sentenced — on `view.coverageDetail`, which is where argon can build a real
  // table from it.
  const detail: CoverageDetail[] = [];
  const rowLine = (row: CoverageRow): string => {
    const entry = entries.get(row.id);
    // Staleness is a property of the DATUM, not of whether the model gave the
    // row a token: §2 must not quote a stale figure even on a row nobody
    // called.
    if (row.asOf !== undefined && row.asOf.slice(0, 10) < staleBefore)
      stale.push(row);
    const shown = row.id.startsWith("theme:")
      ? (() => {
          const triple = themeTriple(row);
          return `${triple.week} (1w) · ${triple.since} (since ${row.theme === undefined ? "?" : (frame.declared.themes.find((t) => `theme:${t.id}` === row.id)?.entered ?? "?")})`;
        })()
      : `${row.level ?? "—"} → ${row.move ?? row.prior ?? "—"}`;
    const band =
      entry === undefined ||
      entry.token === "untested" ||
      row.delta === undefined
        ? undefined
        : bandText(entry.token, row.delta, unitOf(row.move));
    detail.push({
      id: row.id,
      ...(row.level === undefined ? {} : { level: row.level }),
      ...(row.move === undefined ? {} : { move: row.move }),
      ...(row.prior === undefined ? {} : { prior: row.prior }),
      ...(row.asOf === undefined ? {} : { asOf: row.asOf }),
      ...(row.members === undefined ? {} : { members: row.members }),
      ...(band === undefined || band === "" ? {} : { band }),
      ...(entry?.observable === undefined || entry.observable === ""
        ? {}
        : { observable: entry.observable }),
      ...(row.rendererFilled === true ? { rendererFilled: true } : {}),
      ...(row.untested === undefined ? {} : { untested: row.untested }),
    });
    // §J. The ledger's own count, printed by the renderer that holds it. No
    // verdict token, no probability, no model words — and it still occupies
    // its declared slot, so the row count does not move.
    if (row.rendererFilled === true && row.untested === undefined)
      return `- ${row.id} · ${row.level ?? "—"}`;
    // TWO FIELDS AND NO MORE WHEN THERE IS NO DATUM. The `left out:` summary at
    // the end of the section still carries the source's own words.
    if (row.untested !== undefined)
      return `- ${row.id} · ${NO_DATUM} · UNTESTED`;
    // A DATUM NOBODY CALLED STILL PRINTS ITS NUMBER. Folding this into the
    // no-datum line put "no datum this period" beside ten sector rows the
    // frame had just priced, on the review-v6 rerun where the author answered
    // the macro rows and stopped. It stays a gap and it stays UNTESTED — the
    // count is what `coverageGaps` is measured against — but it does not
    // claim the frame came back empty.
    if (entry === undefined)
      return `- ${row.id} · ${shown} · UNTESTED · ${NOT_CALLED}`;
    if (entry.token === "untested")
      return `- ${row.id} · ${shown} · UNTESTED · ${entry.why || "—"}`;
    return `- ${row.id} · ${shown} · ${entry.token.toUpperCase()} · ${entry.why || "—"}`;
  };

  const macroRows = publicRows.filter(
    (row) => !row.id.startsWith("sector:") && !row.id.startsWith("theme:"),
  );
  const sectorRows = publicRows.filter((row) => row.id.startsWith("sector:"));
  const themeRows = publicRows.filter((row) => row.id.startsWith("theme:"));
  const publicUntested = publicRows.filter(
    (row) => untestedReason(row) !== undefined,
  );
  const coverageLines: string[] = ["3a macro", ...macroRows.map(rowLine)];
  coverageLines.push("3b sectors", ...sectorRows.map(rowLine));
  coverageLines.push("3c themes");
  for (const row of themeRows) {
    coverageLines.push(rowLine(row));
    const theme = row.theme;
    if (theme === undefined) continue;
    coverageLines.push(`  kill armed: ${theme.kill.armed}`);
    if (theme.kill.met)
      coverageLines.push(
        `  kill: ${theme.kill.why ?? theme.kill.armed} — CONDITION MET; promote a removal PR`,
      );
    if (theme.evidence.every((line) => !line.includes("tool:")))
      coverageLines.push("  evidence: operator-checked");
  }
  if (period === WEEKLY) {
    coverageLines.push("3d rotation");
    if (args.rotation === null) {
      coverageLines.push("rotation: not priced this run");
    } else {
      for (const row of args.rotation.rows)
        coverageLines.push(
          row.untested === undefined
            ? `  ${row.symbol} · 1w ${showSigned(row.w1, "pct")}% · 4w ${showSigned(row.w4, "pct")}% · 12w ${showSigned(row.w12, "pct")}% · excess 1w ${showSigned(row.excess1w, "pct")}%`
            : `  ${row.symbol} · untested — ${row.untested}`,
        );
      const bench = args.rotation.benchmarkReturns;
      coverageLines.push(
        `  benchmark ${args.rotation.benchmark} · 1w ${showSigned(bench.w1, "pct")}% · 4w ${showSigned(bench.w4, "pct")}% · 12w ${showSigned(bench.w12, "pct")}% · as of ${args.rotation.asOf}`,
      );
    }
  }
  // ONE LINE, NOT EIGHTEEN. The per-row reason is still recorded — it is on
  // `coverageDetail[].leftOut` — but eighteen copies of "no verdict token for
  // this row" under the table taught the reader nothing the count does not.
  if (publicUntested.length > 0)
    coverageLines.push(
      `left out: ${String(publicUntested.length)} rows — ${publicUntested.map((row) => row.id).join(", ")}`,
    );
  const coverageBody = coverageLines.join("\n");
  const reasons = new Map(
    untested.map((row) => [row.id, untestedReason(row) ?? "?"]),
  );
  for (const entry of detail) {
    const reason = reasons.get(entry.id);
    if (reason !== undefined) entry.leftOut = reason;
  }

  // ---------------- section 2: the model's, checked against §1 -------------
  const printedIds = new Set([
    ...settled.map((row) => row.id),
    ...open.map((row) => row.id),
  ]);
  let review = doc?.review ?? "";
  for (const match of review.matchAll(COMMITMENT_ID)) {
    faults.push(
      printedIds.has(match[0])
        ? `复盘 names ${match[0]}, a ledger commitment id that belongs in internal records — the paragraph is dropped`
        : `复盘 names ${match[0]}, which the ledger does not carry — the paragraph is dropped`,
    );
    review = "";
    break;
  }
  review = review === "" ? "" : trim(review, caps.review).text;
  let staleRowsQuoted = 0;
  const quotesRow = (text: string, row: CoverageRow): boolean =>
    new RegExp(
      `\\b${row.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`,
      "iu",
    ).test(text) ||
    (row.level !== undefined && text.includes(row.level));
  const reviewLines: string[] = [];
  if (review !== "") reviewLines.push(review);
  for (const row of stale)
    for (const sentence of review.split(/(?<=[.。!?])\s+/u))
      if (sentence.trim() !== "" && quotesRow(sentence, row))
        staleRowsQuoted += 1;
  const reviewBody = reviewLines.join("\n");

  // ---------------- section 4: the model's, no restatement -----------------
  const proposed = proposedThemes(doc?.outlook ?? "").filter((entry) => {
    if (frame.declared.themes.some((theme) => theme.id === entry.id)) {
      faults.push(
        `proposed theme ${entry.id} collides with a declared row — dropped`,
      );
      return false;
    }
    return true;
  });
  let outlook = doc?.outlook ?? "";
  outlook = outlook
    .split("\n")
    .filter((line) => PROPOSED.exec(line.trim()) === null)
    .join("\n")
    .trim();
  outlook = outlook === "" ? "" : trim(outlook, caps.outlook).text;
  for (const row of stale)
    for (const sentence of outlook.split(/(?<=[.。!?])\s+/u))
      if (sentence.trim() !== "" && quotesRow(sentence, row))
        staleRowsQuoted += 1;
  const outlookLines: string[] = [];
  if (outlook !== "") outlookLines.push(outlook);
  // Themes have their own structured view block. Repeating their verdicts in
  // public outlook prose turns one subject into two competing sections.
  if (proposed.length > 0) {
    outlookLines.push("proposed (not scored)");
    for (const entry of proposed)
      outlookLines.push(
        `  PROPOSED: ${entry.id} — ${entry.thesis} — evidence: ${entry.evidence}`,
      );
  }
  const outlookBody = outlookLines.join("\n");

  // ---------------- section 5: dated catalysts -----------------------------
  const admitted: string[] = [];
  const notAdmitted: string[] = [];
  const catalystLines: string[] = [];
  for (const row of args.calendarRows) {
    const missing: string[] = [];
    if (typeof row.time !== "string" || row.time === "") missing.push("time");
    if (typeof row.event !== "string" || row.event === "")
      missing.push("event");
    if (row.forecast === undefined && row.prev === undefined)
      missing.push("forecast or prev");
    if (missing.length > 0) {
      notAdmitted.push(`${row.event || "(unnamed)"} — ${missing.join(", ")}`);
      continue;
    }
    admitted.push(row.event);
    // WHEN, WHAT, AND BOTH NUMBERS. The release TIME is the point of a dated
    // row — 08:30 ET and 16:05 ET are different events — so the row's own
    // timestamp is printed whole, never truncated to its day. The forecast and
    // the prior are printed together: a forecast with nothing to compare it
    // against says less than either number alone. What the 2026-09-06 line
    // carried and this one does not: the type ("earnings", already in the
    // event), the session a second time ("ADBE earnings (post) … · post"), a
    // settle day mechanically one weekday later (the ledger's business), and
    // `implied move 6.9333%` — four decimals of a fraction nobody quotes, so
    // the percent goes through the units table like every other printed figure.
    catalystLines.push(
      `- ${row.time} · ${row.event}` +
        (row.session === undefined || row.event.includes(row.session)
          ? ""
          : ` · ${row.session}`) +
        (row.forecast === undefined
          ? ""
          : ` · fcst ${roundPercents(row.forecast)}`) +
        (row.prev === undefined ? "" : ` · prev ${roundPercents(row.prev)}`),
    );
  }
  for (const line of notAdmitted) catalystLines.push(`not admitted: ${line}`);
  if (admitted.length === 0)
    catalystLines.push("no dated event was admitted this period");
  let catalysts = doc?.catalysts ?? "";
  if (catalysts !== "") {
    const named = notAdmitted
      .map((line) => line.split(" — ")[0] ?? "")
      .filter((name) => name !== "" && catalysts.includes(name));
    if (named.length > 0) {
      faults.push(
        `dated catalysts names ${named.join(", ")}, which no dated source admitted — the paragraph is dropped`,
      );
      catalysts = "";
    }
  }
  // THE RULE THE PROMPT ALREADY CARRIES, NOW ENFORCED. On 2026-09-06 zero rows
  // were admitted and §5 still printed "FOMC decision 2026-09-16 … 50.7%
  // hold" — a whole paragraph about an event no dated source handed the run.
  // An event NAME is an acronym of three or more capitals or an ISO day; every
  // one of them must appear in what the admitted rows actually say.
  if (catalysts !== "") {
    const haystack = args.calendarRows
      .filter((row) => admitted.includes(row.event))
      // The WHOLE admitted row, forecast and prior included. Keying on the
      // event name alone dropped a paragraph on the review-v6 close for
      // saying "HOLD" and "HIKE" — the two words the admitted FOMC rows carry
      // in their own `forecast` field.
      .map(
        (row) =>
          `${row.time} ${row.type} ${row.event} ${row.forecast ?? ""} ${row.prev ?? ""}`,
      )
      .join(" ")
      .toLowerCase();
    const unsourced = [
      ...new Set(
        (catalysts.match(EVENT_NAME) ?? []).filter(
          (token) => !haystack.includes(token.toLowerCase()),
        ),
      ),
    ];
    if (unsourced.length > 0) {
      faults.push(
        `dated catalysts names ${unsourced.join(", ")}, which the admitted rows do not carry — the paragraph is dropped`,
      );
      catalysts = "";
    }
  }
  if (catalysts !== "")
    catalystLines.push(trim(catalysts, caps.catalysts).text);
  const catalystBody = catalystLines.join("\n");

  // ---------------- section 6: the focus list ------------------------------
  const list = period === WEEKLY ? frame.focus.weekly : frame.focus.daily;
  const limit =
    (period === WEEKLY
      ? frame.declared.focus?.weekly
      : frame.declared.focus?.daily) ?? list.length;
  const whyByTicker = new Map<string, string>();
  const tickers = new Set(list.map((row) => row.ticker));
  const focusWhyRejected = 0;
  for (const entry of doc?.focus ?? []) {
    if (!tickers.has(entry.ticker)) {
      faults.push(
        `focus ${entry.ticker}: not on the computed list — the line is discarded`,
      );
      continue;
    }
    // THE SHAPE THAT SAYS NOTHING. "Earnings 2026-10-15; 7.86% IV expects
    // volume recovery." is the event date and the implied move, both already
    // printed in their own columns two cells to the left, plus a noun. It is
    // recorded and NOT dropped: the line is worthless, not wrong, and printing
    // an empty cell would hide that the author was asked and answered.
    if (FOCUS_WHY_DATE_RESTATE.test(entry.why))
      faults.push(
        `focus-why-restates-date ${entry.ticker}: "${entry.why}" is the date and the implied move, which the row already prints`,
      );
    whyByTicker.set(entry.ticker, trim(entry.why, caps.focusWords).text);
  }
  const focusRows: FocusViewRow[] = list.map((row) => {
    const nearest = row.nearest;
    const event =
      nearest === undefined
        ? "—"
        : `${nearest.label}${nearest.day === undefined ? "" : ` ${nearest.day}`}`;
    return {
      ticker: row.ticker,
      event,
      why: whyByTicker.get(row.ticker) ?? "",
      ...(row.ivRank === undefined ? {} : { ivRank: row.ivRank }),
      // THAT there is an open call, not its id. The id is
      // `2026-09-04-close-focus-ADBE` — the day, the run label and the kind,
      // all three already on the page — and a reader who wants the call itself
      // reads §7, which lists it by name.
      ...(row.openCallIds[0] === undefined ? {} : { openCall: "open" }),
      ...(row.sticky === true ? { sticky: true } : {}),
    };
  });
  const focusWhyMissing = focusRows.filter((row) => row.why === "").length;
  const focusLines: string[] = [
    "rank · ticker · event · IV rank · implied move · open call · why",
  ];
  focusRows.forEach((row, index) => {
    const source = list[index]!;
    const threshold = (source as { threshold?: { pct: number } }).threshold;
    focusLines.push(
      `| ${String(index + 1)} | ${row.ticker} | ${row.event} | ` +
        `${show(row.ivRank, "ivRank")} | ` +
        `${threshold === undefined ? "—" : `${fmt(threshold.pct, "pct")}%`} | ` +
        `${row.openCall ?? "—"} | ${row.why === "" ? "—" : row.why} |` +
        (row.sticky === true ? " sticky" : ""),
    );
  });
  const shortfall =
    focusRows.length < limit
      ? `${String(focusRows.length)} of ${String(limit)} — ${frame.focus.notes[0] ?? "no reason recorded"}`
      : undefined;
  if (shortfall !== undefined) focusLines.push(shortfall);
  focusLines.push(frame.focus.weightsNote);
  const focusBody = focusLines.join("\n");

  // ---------------- section 7: open calls, zero model words ----------------
  const openBody =
    open.length === 0
      ? "nothing outstanding"
      : [...open]
          .sort((a, b) =>
            (settleDay(a, args.calendar) ?? "9999-99-99").localeCompare(
              settleDay(b, args.calendar) ?? "9999-99-99",
            ),
          )
          .map((row) => openCallLine(row, args.calendar))
          .join("\n");

  // Assembled LAST, in §J.1's order, because the bodies are computed in
  // dependency order and not in print order.
  sections.push(
    { title: MARKET_REPORT_TITLES[0], body: reviewBody },
    { title: MARKET_REPORT_TITLES[1], body: outlookBody },
    { title: MARKET_REPORT_TITLES[2], body: catalystBody },
    { title: MARKET_REPORT_TITLES[3], body: coverageBody },
  );

  // ---------------- the structured view blocks -----------------------------
  const themeView: ThemeViewRow[] = frame.declared.themes.map((theme) => {
    const row = rows.find((entry) => entry.id === `theme:${theme.id}`);
    const entry = entries.get(`theme:${theme.id}`);
    const model = (doc?.themes ?? []).find((item) => item.id === theme.id);
    const triple =
      row === undefined ? { week: "—", since: "—" } : themeTriple(row);
    return {
      id: theme.id,
      token: entry?.token ?? "untested",
      excess1w: triple.week,
      excessSinceEntered: triple.since,
      ...(model === undefined
        ? {}
        : { leadership: model.leadership, why: model.why }),
      kill: row?.theme?.kill.armed ?? theme.kill,
      killMet: row?.theme?.kill.met ?? false,
    };
  });

  return {
    sections,
    internalSections: [
      { title: REVIEW_TITLES[0], body: scorecard },
      { title: REVIEW_TITLES[5], body: focusBody },
      { title: REVIEW_TITLES[6], body: openBody },
    ],
    faults,
    gaps,
    citations: citationLines.length,
    admitted,
    notAdmitted,
    focusWhyMissing,
    focusWhyRejected,
    staleRowsQuoted,
    proposed,
    view: {
      focus: {
        period,
        rows: focusRows,
        ...(shortfall === undefined ? {} : { shortfall }),
        churn: frame.focus.churn,
      },
      themes: themeView,
      coverageDetail: detail,
      ...(period === WEEKLY && args.rotation !== null
        ? {
            rotation: {
              asOf: args.rotation.asOf,
              benchmark: args.rotation.benchmark,
              rows: args.rotation.rows,
            },
          }
        : {}),
    },
  };
}

/**
 * The masthead line a review document carries when no regime step supplied one.
 *
 * NEVER empty. A weekly run has no `regime` step at all, so the 2026-09-06 W36
 * document reached argon with `headline: ""` and the page had nothing to head
 * itself with. This is renderer-computed from what the run already printed —
 * the market-review lead or a deterministic market label, so it is never an
 * old scorecard or yesterday-checks headline.
 */
export function reviewHeadline(args: {
  period: ReviewPeriod;
  /** Kept for callers that retain the internal scorecard. */
  scorecard: string;
  review?: string;
  oneThing?: string;
  checksLine?: string;
}): string {
  const review = (args.review ?? "").trim();
  const firstLine = review.split(/\r?\n/u)[0]?.trim() ?? "";
  if (firstLine !== "") return firstLine;
  if (args.period === WEEKLY) return "Weekly market review";
  const lead = (args.oneThing ?? "").trim();
  if (lead !== "") {
    const first = /^[^.。!?]{1,160}[.。!?]?/u.exec(lead)?.[0]?.trim() ?? "";
    if (first !== "") return first;
  }
  return "Market review";
}

// --- what a review mints ----------------------------------------------------

/** Trading days after the issue day before a verdict may be settled — the
 *  cadence, made explicit so a mid-week daily run cannot close a weekly
 *  verdict early. */
const SETTLE_AFTER = { [WEEKLY]: 5, [DAILY]: 1 } as const;
/** §G.5's window: the open session before the event through the open session
 *  after it. */
const FOCUS_SETTLE_AFTER = 2;

export function verdictCommitments(args: {
  frame: SessionFrame;
  doc: ReviewDoc | null;
  day: string;
  phase: string;
  period?: ReviewPeriod;
  /** Collects the one fault line an unscorable admitted name earns. */
  faults?: string[];
}): CommitmentDraft[] {
  const period = args.period ?? WEEKLY;
  const drafts: CommitmentDraft[] = [];
  const rows = new Map(args.frame.rows.map((row) => [row.id, row]));
  for (const entry of args.doc?.coverage ?? []) {
    if (!entry.scorable || entry.token === "untested") continue;
    const row = rows.get(entry.id);
    // A row with no observation is not a forecast, and a row the RENDERER
    // fills is not the model's to forecast either.
    if (row === undefined || row.untested !== undefined) continue;
    if (row.rendererFilled === true) continue;
    drafts.push({
      id: `${args.day}-${args.phase}-verdict-${entry.id}`,
      payload: {
        kind: "coverage-verdict",
        evaluator: "verdict-v0",
        rowId: entry.id,
        series: row.series,
        unit: entry.id.startsWith("theme:") ? "%" : unitOf(row.move),
        token: entry.token,
        p: entry.p,
        observed: {
          ...(row.level === undefined ? {} : { level: row.level }),
          ...(row.prior === undefined ? {} : { prior: row.prior }),
          ...(row.delta === undefined ? {} : { delta: row.delta }),
          ...(row.asOf === undefined ? {} : { asOf: row.asOf }),
        },
        settleAfterOpenDays: SETTLE_AFTER[period],
      },
    });
  }

  // §G.5. One admission per admitted, scorable name — and none for a name
  // already carried by an outstanding commitment for the same event: the
  // ledger is append-only, and a second id would double-count focusHitRate.
  const carried = new Set(
    args.frame.ledger.open
      .map((row) => payloadOf(row))
      .filter((payload) => payload.kind === "focus-admit")
      .map((payload) => String(payload.ticker ?? "")),
  );
  const list =
    period === WEEKLY ? args.frame.focus.weekly : args.frame.focus.daily;
  for (const row of list) {
    if (carried.has(row.ticker)) continue;
    const nearest = row.nearest;
    const threshold = (row as { threshold?: { pct: number; source: string } })
      .threshold;
    if (nearest?.day === undefined) continue;
    if (threshold === undefined) {
      args.faults?.push(
        `focus ${row.ticker}: no implied or realized threshold; admitted but not scorable`,
      );
      continue;
    }
    const fromDay = priorWeekday(nearest.day);
    const toDay =
      nearest.session === "post" ? nextWeekday(nearest.day) : nearest.day;
    drafts.push({
      id: `${args.day}-${args.phase}-focus-${row.ticker}`,
      payload: {
        kind: "focus-admit",
        evaluator: "focus-v0",
        ticker: row.ticker,
        admittedFor: {
          kind: nearest.kind,
          day: nearest.day,
          ...(nearest.session === undefined
            ? {}
            : { session: nearest.session }),
          source: nearest.source,
          label: nearest.label,
        },
        window: { fromDay, toDay, openDays: FOCUS_SETTLE_AFTER },
        threshold,
        p: 0.5,
        settleAfterOpenDays: FOCUS_SETTLE_AFTER,
      },
    });
  }
  return drafts;
}

export function reviewMetrics(args: {
  frame: SessionFrame;
  sections: Section[];
  gaps: number;
  citations: number;
  focus: { churn: number; whyMissing: number; whyRejected: number };
  themes: { rows: number; proposed: number };
  rotationRows: number | null;
  staleRowsQuoted: number;
  /** The `ow_review_window` payload, when this run has one. */
  windows?: unknown;
}): RunMetric[] {
  const { frame } = args;
  const settled = frame.ledger.settledToday;
  const scored = settled.filter((row) => row.status !== "pending");
  const outcomes = settled
    .map((row) => outcomeOf(row))
    .filter((value): value is "hit" | "miss" => value !== null);
  const briers = settled
    .map((row) => row.scores.verdictBrier)
    .filter((value): value is number => typeof value === "number");
  const focusSettled = settled.filter(
    (row) => payloadOf(row).kind === "focus-admit",
  );
  const s2 = words(args.sections[1]?.body ?? "");
  const s3 = modelWordsInCoverage(args);
  const s4 = words(args.sections[3]?.body ?? "");
  const rows: RunMetric[] = [
    { name: "callsScored", short: "cs", value: scored.length },
    { name: "callsOutstanding", short: "co", value: frame.ledger.open.length },
    {
      name: "callHitRate",
      short: "chr",
      value:
        outcomes.length === 0
          ? null
          : outcomes.filter((value) => value === "hit").length /
            outcomes.length,
    },
    {
      name: "verdictBrier",
      short: "vb",
      value:
        briers.length === 0
          ? null
          : briers.reduce((a, b) => a + b, 0) / briers.length,
    },
    { name: "coverageGaps", short: "gaps", value: args.gaps },
    { name: "reviewModelWords", short: "rw", value: s2 + s3 + s4 },
    { name: "reviewModelWords.s2", short: "rw2", value: s2 },
    { name: "reviewModelWords.s3", short: "rw3", value: s3 },
    { name: "reviewModelWords.s4", short: "rw4", value: s4 },
    { name: "ledgerCitationCount", short: "cite", value: args.citations },
    { name: "staleRowsQuoted", short: "sq", value: args.staleRowsQuoted },
    {
      name: "focusHitRate",
      short: "fhr",
      value:
        focusSettled.length === 0
          ? null
          : focusSettled.filter((row) => row.status === "hit").length /
            focusSettled.length,
    },
    { name: "focusChurn", short: "fch", value: args.focus.churn },
    { name: "focusWhyRejected", short: "fwr", value: args.focus.whyRejected },
    { name: "focusWhyMissing", short: "fwm", value: args.focus.whyMissing },
    { name: "themeRows", short: "thr", value: args.themes.rows },
    { name: "themesProposed", short: "thp", value: args.themes.proposed },
    { name: "rotationRows", short: "rot", value: args.rotationRows },
  ];
  return rows;
}

/**
 * The model's share of section 3: the `why` clause, and only that.
 *
 * The row is `- <id> · <change> · <TOKEN> · <why>` and the `why` is LAST, so it
 * is the final field however many separators the change string itself carries
 * (`equity.internals` prints three quoted symbols in one cell). The
 * `observable` no longer prints, so it no longer counts: `reviewModelWords` is
 * measured over the document the reader gets.
 */
function modelWordsInCoverage(args: { sections: Section[] }): number {
  const body = args.sections[2]?.body ?? "";
  let total = 0;
  for (const line of body.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const parts = line.split(" · ");
    if (parts.length < 4) continue;
    const why = parts[parts.length - 1] ?? "";
    // The renderer's own stand-ins for an answer nobody gave.
    if (why === "—" || why === NOT_CALLED || why === NO_DATUM) continue;
    total += words(why);
  }
  return total;
}
