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
import {
  stockRowId,
  type CandidateRow,
} from "../quality/coverage-candidates.js";
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
  // #108 item 3. RENDERER-OWNED AND LAST. The author writes no source: it
  // writes prose, and this block says where every payload behind it came from.
  // Gmail strips `<details>`, so the email prints these rows flat at the end
  // and the argon page folds the same rows off `view.sources`.
  "Sources",
] as const;

import { reportedWeek } from "../quality/coverage-candidates.js";
import {
  sourcesBlock,
  sourcesBody,
  stripSourceParentheticals,
  toolNamesIn,
  type SourceRow,
} from "./sources.js";

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
    /** #108 item 3. The run's sources, structured, so the argon page can fold
     *  them into a real `<details>`; the email prints the same rows flat. */
    sources?: SourceRow[];
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

  // #108 ITEM 3 — SOURCES LEAVE THE PROSE, TOGETHER WITH THE BLOCK THAT
  // REPLACES THEM. Never the strip alone: the parentheticals exist because of
  // the 2026-09-03 finding that unsourced numbers get fabricated, so prose
  // loses them only because §Sources now carries the same provenance in a form
  // a machine reads. A source-shaped parenthetical is REMOVED (it is
  // removable without touching the sentence); a tool name inside a sentence is
  // faulted and left alone, because rewriting a sentence is authoring.
  const clean = (field: string, text: string): string => {
    if (text === "") return "";
    const stripped = stripSourceParentheticals(text);
    if (stripped.removed.length > 0)
      faults.push(
        `${field} carries inline source parentheticals ${stripped.removed.join(" ")} — ` +
          "removed; the Sources block is where a source goes",
      );
    const tools = toolNamesIn(stripped.text);
    if (tools.length > 0)
      faults.push(
        `${field} names ${tools.join(", ")} in prose — a tool name belongs in ` +
          "the Sources block, never in a sentence",
      );
    return stripped.text;
  };

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
  // #108 RULE 4 — THE UNTESTED ESCAPE, CLOSED DETERMINISTICALLY. On the
  // 2026-09-06 weekly 21 of 22 rows printed UNTESTED and the ledger got one
  // call, so nothing settled the week after. `untested` is the honest answer
  // to MISSING DATA and nothing else: a row the frame priced (it carries a
  // `level`, it carries no `untested` of its own, and its as-of falls inside
  // the review window) owes a call. The renderer does not write the call and
  // does not rewrite the author's words — it marks the row and faults the
  // page, which is what a gate is for.
  //
  // The exception is the FRAME's, not the author's. Run 2 of the same replay
  // showed why: given a `"missing: "` prefix as the way out, the author wrote
  // `missing: stale as-of 2026-09-03, predates window close` on a row inside
  // the window and `missing: not among three largest |excess|`, and made four
  // calls where run 1 made eleven. A free-text prefix a model writes is not a
  // test. A row the frame priced, dated inside the window, has nothing left
  // to be missing.
  const inWindow = (row: CoverageRow): boolean => {
    const window = frame.coverageCandidates?.window;
    if (window === undefined) return true;
    if (row.asOf === undefined || row.asOf === "") return true;
    const day = row.asOf.slice(0, 10);
    return day >= window.start && day <= window.end;
  };
  // THE THREE THE WEEK IS ABOUT. `delta` on a sector or theme row IS its
  // excess over the benchmark, so the three largest by magnitude are the
  // week's biggest divergences and the rows a reader came for. On those,
  // `untested` is refused outright: no wording saves them, because run 2 of
  // the 2026-09-06 replay showed a `"missing: "` prefix is something a model
  // will write in front of a number it can see.
  const mandated = new Set(
    publicRows
      .filter(
        (row) =>
          (row.id.startsWith("sector:") || row.id.startsWith("theme:")) &&
          row.untested === undefined &&
          row.delta !== undefined,
      )
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
      .slice(0, 3)
      .map((row) => row.id),
  );
  const declined = new Set<string>();
  if (period === WEEKLY)
    for (const row of publicRows) {
      if (row.untested !== undefined) continue;
      if (row.rendererFilled === true) continue;
      if (row.level === undefined || row.level === "") continue;
      if (!inWindow(row)) continue;
      const entry = entries.get(row.id);
      if (entry !== undefined && entry.token !== "untested") continue;
      // Outside the mandated three, naming the data you lack is still the
      // declared way out — the honest `untested` the frame cannot detect for
      // you. Inside them there is no way out, and a row with no entry at all
      // is a declined call wherever it sits.
      if (
        !mandated.has(row.id) &&
        entry !== undefined &&
        entry.why.startsWith("missing: ")
      )
        continue;
      declined.add(row.id);
    }
  if (declined.size > 0)
    faults.push(
      `coverage declined a call on ${String(declined.size)} priced rows ` +
        `(${[...declined].join(", ")}) — the week's three largest |excess| rows ` +
        `owe a call, and every other priced row owes one or a "missing: <data>" reason`,
    );
  // #106 LOOP 2 — A PRINTED CALL THAT MINTS NOTHING IS A FAULT.
  // The 2026-09-06 weekly could write a paragraph about SNDK and there was no
  // row id to hang it on, so nothing entered the ledger and nothing came due:
  // the §4 复盘 had zero single-name receipts to read. The renderer does not
  // invent an id — it faults the page when a scorable call names something
  // neither the fixed list nor the week's ranked names carry, which is the
  // same shape as the declined-call gate above.
  const stockRows = mintableStocks(frame);
  const unmintable = (doc?.coverage ?? []).filter(
    (entry) =>
      entry.scorable &&
      entry.token !== "untested" &&
      !stockRows.has(entry.id) &&
      !rows.some(
        (row) =>
          row.id === entry.id &&
          row.untested === undefined &&
          row.rendererFilled !== true,
      ),
  );
  if (unmintable.length > 0)
    faults.push(
      `coverage called ${unmintable.map((entry) => entry.id).join(", ")} — ` +
        "no ledger commitment id, so the call can never be settled; a call " +
        "names a row from the fixed list or a ranked stock:<SYMBOL>",
    );
  // #106 LOOP 2 — THE SAME OBLIGATION, ON THE STOCK ROWS.
  // Run 2 of the W37 replay printed all eight ranked names as
  // `UNTESTED · not called this period` and the page passed: the ids were
  // mintable and nothing made the author use one, so the ledger got zero
  // single-name rows and next period's 复盘 had nothing to settle. The rule is
  // the one Loop 1 already applies to sectors and themes, word for word: the
  // three largest |excess vs SPY| owe a call and no wording excuses them, every
  // other ranked row owes a call or a `"missing: "` reason, and leaving a row
  // out of `coverage` is a decline, not a way to avoid one.
  //
  // NOT WEEKLY-ONLY, for the same reason §3e is not: the daily frame carries
  // five of these rows and a gate that slept on four runs a week would leave
  // most of the cadence unaccountable.
  const rankedStocks = [...stockRows.values()];
  const mandatedStocks = new Set(
    rankedStocks
      .filter((row) => row.excess_vs_spy !== null)
      .sort(
        (a, b) =>
          Math.abs(b.excess_vs_spy ?? 0) - Math.abs(a.excess_vs_spy ?? 0) ||
          a.symbol.localeCompare(b.symbol, "en"),
      )
      .slice(0, 3)
      .map((row) => stockRowId(row.symbol)),
  );
  const stockDeclined = new Set<string>();
  for (const row of rankedStocks) {
    const id = stockRowId(row.symbol);
    const entry = entries.get(id);
    if (entry !== undefined && entry.token !== "untested") continue;
    if (
      !mandatedStocks.has(id) &&
      entry !== undefined &&
      entry.why.startsWith("missing: ")
    )
      continue;
    stockDeclined.add(id);
  }
  if (stockDeclined.size > 0)
    faults.push(
      `coverage declined a call on ${String(stockDeclined.size)} ranked stock rows ` +
        `(${[...stockDeclined].join(", ")}) — the three largest |excess vs SPY| ` +
        'owe a call, and every other ranked row owes one or a "missing: <data>" reason',
    );
  const detail: CoverageDetail[] = [];
  /** A fraction as a signed percentage, or an em dash. The candidate payload
   *  carries `0.1717`; a reader wants `+17.2%`. */
  const asPct = (value: number | null): string =>
    value === null ? "—" : `${fmtSigned(value * 100, "pct")}%`;
  const stockLine = (row: CandidateRow): string => {
    const id = stockRowId(row.symbol);
    const entry = entries.get(id);
    // #113 item 1. A row the MOVERS block put here has no week return and no
    // excess, so the priced half of the line would read as two em dashes and
    // nothing would say why the name is in the table. Its own number and its
    // own block are named instead. `overnight_ret` is TradingView's percent
    // already — it is NOT run through `asPct`, which is for fractions.
    const shown =
      (row.rankedOn === "overnight_ret"
        ? `overnight ${row.overnight_ret === undefined ? "—" : `${fmtSigned(row.overnight_ret, "pct")}%`} (movers) · no week return`
        : `${asPct(row.window_return)} week · excess vs SPY ${asPct(row.excess_vs_spy)}` +
          (row.overnight_ret === undefined
            ? ""
            : ` · overnight ${fmtSigned(row.overnight_ret, "pct")}% (movers)`)) +
      (row.earnings === undefined
        ? ""
        : ` · reported ${row.earnings.reportDate} EPS ${row.earnings.actualEps}` +
          ` vs est ${row.earnings.streetMeanEst ?? "—"}`);
    const mark = stockDeclined.has(id) ? " · call declined on priced data" : "";
    if (entry === undefined)
      return `- ${id} · ${shown} · UNTESTED · ${NOT_CALLED}${mark}`;
    if (entry.token === "untested")
      return `- ${id} · ${shown} · UNTESTED · ${entry.why || "—"}${mark}`;
    return `- ${id} · ${shown} · ${entry.token.toUpperCase()} · ${entry.why || "—"}`;
  };
  // #108 ITEM 1 — WHICH BLOCK IS EMPTY, IN THE RENDERER'S WORDS.
  // The 2026-09-09 weekly printed eleven macro rows as one-line
  // `missing: ...` and the reader could not tell an absent payload from an
  // author who did not look. The frame knows the difference, so it says it:
  // an empty block names itself, a priced row that was still declined says it
  // was priced. No number is repeated — `shown` already carries the level —
  // only the as-of stamps, copied.
  const frameState = (row: CoverageRow): string => {
    if (row.untested !== undefined)
      return `frame block empty — ${row.untested}`;
    if (row.level === undefined || row.level === "")
      return "frame block empty — no level";
    const window = frame.coverageCandidates?.window;
    if (!inWindow(row) && window !== undefined)
      return `frame block dated ${row.asOf ?? "—"}, outside ${window.start}→${window.end}`;
    return `frame block priced${row.asOf === undefined ? "" : `, as of ${row.asOf}`}`;
  };
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
      return `- ${row.id} · ${NO_DATUM} · UNTESTED · ${frameState(row)}`;
    // A DATUM NOBODY CALLED STILL PRINTS ITS NUMBER. Folding this into the
    // no-datum line put "no datum this period" beside ten sector rows the
    // frame had just priced, on the review-v6 rerun where the author answered
    // the macro rows and stopped. It stays a gap and it stays UNTESTED — the
    // count is what `coverageGaps` is measured against — but it does not
    // claim the frame came back empty.
    if (entry === undefined)
      return `- ${row.id} · ${shown} · UNTESTED · ${NOT_CALLED} · ${frameState(row)}`;
    if (entry.token === "untested")
      return (
        `- ${row.id} · ${shown} · UNTESTED · ${entry.why || "—"} · ${frameState(row)}` +
        (declined.has(row.id) ? " · call declined on priced data" : "")
      );
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
  // ---- the caliber line, renderer-owned (#107 item 5) ---------------------
  // WHAT THE NUMBERS ON THIS PAGE ARE, in the renderer, where no model can
  // rewrite it. It says PRIOR FRIDAY CLOSE -> FRIDAY CLOSE because that is
  // what the week return measures (verified 2026-09-08 against apex: SOXX is
  // +2.21% on that basis and +1.73% Monday-close to Friday-close); a preamble
  // that names the wrong two closes is worse than none. The precedent is
  // "Rates are the first cause" — a fixed sentence in the PROMPT, which the
  // model copied every week whether or not it was true.
  const coverageLines: string[] = [];
  if (period === WEEKLY) {
    const week = frame.coverageCandidates?.window ?? reportedWeek(frame.day);
    coverageLines.push(
      `Daily close, apex/livewire, week ${week.start}→${week.end} ` +
        "(prior Friday close → Friday close); intraday windows are 1m bars in ET; " +
        "macro releases per argon published_at",
    );
  }
  coverageLines.push("3a macro", ...macroRows.map(rowLine));
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
  // ---- 3e, the ranked single names (#106 Loop 2) ------------------------
  // PRINTED WITH THEIR ROW IDS, because the id is what makes the call
  // settleable: `stock:SNDK` is the same string `verdictCommitments` mints
  // against and the same string the next observation will carry. The returns
  // arrive as fractions and are printed as percentages here — renderer
  // arithmetic, never the author's.
  //
  // NOT WEEKLY-ONLY. The daily frame carries the same block with five rows
  // instead of eight (`candidateLimit`), and a gate that printed a name only
  // on Sundays would leave four runs a week able to write about a stock with
  // no row to hang the call on — the exact defect this section closes.
  const candidates = frame.coverageCandidates;
  if (candidates !== undefined) {
    coverageLines.push("3e stocks");
    if (candidates.stocks.length === 0)
      coverageLines.push(
        `  no ranked single name — ${candidates.notes.join("; ") || "no reason recorded"}`,
      );
    for (const row of candidates.stocks) coverageLines.push(stockLine(row));
    if (candidates.missing.length > 0)
      coverageLines.push(
        `  left out: ${candidates.missing.map((row) => `${row.symbol} (${row.reason})`).join("; ")}`,
      );
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
  let review = clean("复盘", doc?.review ?? "");
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
  outlook = clean("outlook", outlook);
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
  let catalysts = clean("dated catalysts", doc?.catalysts ?? "");
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
  // The block, from the run and nothing else: the frame's own coverage table
  // (tool, layer, its own as-of, its own skip reason) plus the derived blocks
  // the frame carries. A source the run did not call has no row here.
  const news = frame.newsOverview;
  const sourceRows = sourcesBlock({
    coverage: frame.coverage,
    ...(frame.coverageCandidates === undefined
      ? {}
      : {
          candidates: {
            window: frame.coverageCandidates.window,
            source: frame.coverageCandidates.source,
          },
        }),
    ...(frame.eventDay === undefined
      ? {}
      : {
          eventDay: {
            date: frame.eventDay.date,
            pickedBy: frame.eventDay.pickedBy,
          },
        }),
    ...(frame.macroReleases === undefined
      ? {}
      : {
          macroReleases: {
            weekStart: frame.macroReleases.weekStart,
            weekEnd: frame.macroReleases.weekEnd,
            scheduled: frame.macroReleases.scheduled.length,
            printed: frame.macroReleases.printed.length,
            ...(frame.macroReleases.unavailable === undefined
              ? {}
              : { unavailable: frame.macroReleases.unavailable }),
          },
        }),
    ...(frame.premarketMovers === undefined
      ? {}
      : {
          premarketMovers: {
            asOf: frame.premarketMovers.asOf,
            session: frame.premarketMovers.session,
          },
        }),
    ...(news === undefined
      ? {}
      : {
          news: {
            asOf: news.asOf,
            providers: [
              ...news.marketsToday,
              ...news.economic,
              ...news.stocks.flatMap((entry) => entry.headlines),
            ].map((row) => ({
              provider: row.provider,
              published: row.published,
            })),
          },
        }),
    ...(args.rotation === null
      ? {}
      : { rotation: { asOf: args.rotation.asOf, benchmark: args.rotation.benchmark } }),
  });

  sections.push(
    { title: MARKET_REPORT_TITLES[0], body: reviewBody },
    { title: MARKET_REPORT_TITLES[1], body: outlookBody },
    { title: MARKET_REPORT_TITLES[2], body: catalystBody },
    { title: MARKET_REPORT_TITLES[3], body: coverageBody },
    { title: MARKET_REPORT_TITLES[4], body: sourcesBody(sourceRows) },
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
      sources: sourceRows,
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
  if (firstLine !== "") return firstLine.replace(/^## /u, "");
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

/**
 * The ranked single names this run can mint a commitment FOR (#106 Loop 2).
 *
 * A candidate with neither a week return nor an excess carries no `delta`, so
 * a verdict on it could never be settled against the next week's observation
 * — `eval/verdict.ts` needs a number to classify. Such a row prints and mints
 * nothing, exactly like a coverage row the frame could not price.
 *
 * One function, two readers: the §3e gate below asks it what a printed call
 * may name, and `verdictCommitments` asks it what to mint. A call the gate
 * accepts and the minter drops would be the very defect the gate exists to
 * catch.
 */
function mintableStocks(frame: SessionFrame): Map<string, CandidateRow> {
  const out = new Map<string, CandidateRow>();
  for (const row of frame.coverageCandidates?.stocks ?? [])
    if (row.excess_vs_spy !== null || row.window_return !== null)
      // `stockRowId`, not `row.id`: a frame recorded before the field existed
      // (every sample under docs/evidence/flash-samples) still has to key the
      // same way a live one does, and the id IS a function of the symbol.
      out.set(stockRowId(row.symbol), row);
  return out;
}

/**
 * A single name's verdict, in the SAME id scheme and the same payload kind as
 * a macro, sector or theme row's.
 *
 * `delta` is the excess over SPY in percentage points — the theme rows' own
 * convention (`excessPct`) — because that is what the next week's observation
 * of the same row will carry, and `settleVerdict` compares the two. The week
 * return is the fallback for a row the source could not benchmark, and
 * `rankedOn` already told the reader which of the two ordered it.
 *
 * A name that drops out of the next week's ranked list mints no later
 * observation, so its verdict PENDS rather than resolving — the same outcome
 * as a coverage row the frame could not price that week, and visible as such
 * in the ledger.
 */
function stockDraft(args: {
  day: string;
  phase: string;
  entry: CoverageEntry;
  stock: CandidateRow;
  asOf?: string;
  settleAfterOpenDays: number;
}): CommitmentDraft {
  const { stock } = args;
  const delta =
    stock.excess_vs_spy === null
      ? (stock.window_return ?? 0) * 100
      : stock.excess_vs_spy * 100;
  return {
    id: `${args.day}-${args.phase}-verdict-${args.entry.id}`,
    payload: {
      kind: "coverage-verdict",
      evaluator: "verdict-v0",
      rowId: args.entry.id,
      series: `${stock.symbol} week return vs SPY, excess %`,
      unit: "%",
      token: args.entry.token,
      p: args.entry.p,
      observed: {
        ...(stock.window_return === null
          ? {}
          : { level: fmtSigned(stock.window_return * 100, "pct") }),
        delta,
        ...(args.asOf === undefined || args.asOf === ""
          ? {}
          : { asOf: args.asOf }),
      },
      settleAfterOpenDays: args.settleAfterOpenDays,
    },
  };
}

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
  const stocks = mintableStocks(args.frame);
  for (const entry of args.doc?.coverage ?? []) {
    if (!entry.scorable || entry.token === "untested") continue;
    const row = rows.get(entry.id);
    // #106 LOOP 2. A call on a ranked single name is not in `frame.rows` — the
    // fixed list is macro, sectors and themes — so it used to fall through
    // this `continue` and mint nothing at all. It now mints through the same
    // id scheme; only the source of the observation differs.
    if (row === undefined) {
      const stock = stocks.get(entry.id);
      if (stock === undefined) continue;
      const window = args.frame.coverageCandidates?.window;
      drafts.push(
        stockDraft({
          day: args.day,
          phase: args.phase,
          entry,
          stock,
          ...(window?.end === undefined || window.end === ""
            ? {}
            : { asOf: window.end }),
          settleAfterOpenDays: SETTLE_AFTER[period],
        }),
      );
      continue;
    }
    // A row with no observation is not a forecast, and a row the RENDERER
    // fills is not the model's to forecast either.
    if (row.untested !== undefined) continue;
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
