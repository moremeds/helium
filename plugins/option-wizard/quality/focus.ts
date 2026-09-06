/**
 * The weekly 15 and the daily 5 — computed from dated event feeds, never
 * chosen by a model.
 *
 * Pure: no clock, no randomness, no filesystem, no environment. `day` and the
 * open-session arithmetic are injected, which is what makes a replay produce a
 * byte-identical list. The purity scan in `tests/quality-focus.spec.ts` is the
 * enforcement.
 *
 * The methodology is entirely in `extensions.review.focus` — weights, windows
 * and the tie-break — so a re-weight is a reviewable yaml diff rather than a
 * prompt edit (spec §I.6).
 * @module dsh-plugin-tenant-option-wizard/quality/focus
 */
import type { Leak } from "./meta-leak.js";
import type { FocusConfig, FocusKind, ThemeSpec } from "./review-config.js";

export type { FocusKind } from "./review-config.js";

/**
 * The ONLY sources an event may come from. A row from anywhere else is dropped
 * with a note — §G.1's "nothing outside the universe can be on the list"
 * applied to the EVENT as well as to the ticker, because a hallucinated date
 * admits a real ticker for a reason that never existed.
 */
export const ADMITTED_EVENT_SOURCES: ReadonlySet<string> = new Set([
  "ow_uw_earnings",
  "ow_uw_calendar",
  "ow_argon_policy_path",
  "ow_uw_iv_term",
  "ow_argon_watchlist",
  "ow_massive_actions",
  "ledger",
  "tenant.yaml",
]);

/** A macro row applies to the whole universe, not to one name. */
export const MARKET = "MARKET";

export interface FocusEvent {
  ticker: string;
  kind: FocusKind;
  /** `yyyy-mm-dd`, when the feed dated it. Undefined for the undated kinds
   *  (`pinned`, `theme`, `flowAnomaly` — all "today", none decaying). */
  day?: string;
  /** OPEN sessions from `inputs.day`. Negative = already past: scores 0.
   *  null = the feed gave no date, which is why it never decays. */
  sessionsAway: number | null;
  session?: "pre" | "post";
  /** The tool that dated it, verbatim. Must be in ADMITTED_EVENT_SOURCES. */
  source: string;
  /** What the row prints: "earnings (post)", "CPI", "theme el-nino-ag-2026". */
  label: string;
}

export interface FocusPart {
  kind: FocusKind;
  points: number;
  from: string;
}

export interface FocusRow {
  ticker: string;
  /** Sum of the decayed weights, rounded to 4 dp so two machines print the
   *  same string. */
  score: number;
  parts: FocusPart[];
  /** The tie-break's second key and the daily list's first. null sorts last. */
  daysToNearestEvent: number | null;
  nearest?: FocusEvent;
  /** argon's `iv_rank` when the watchlist payload carried it; the §G.4 column
   *  prints `—` when it did not. Never computed here. */
  ivRank?: number;
  openCallIds: string[];
  themes: string[];
  /** True when this name was carried in from an open focus-admit commitment. */
  sticky?: boolean;
}

export interface FocusInputs {
  day: string;
  /** §G.1: argon chains ∪ pinned ∪ TV flag lists. Nothing else may score. */
  universe: string[];
  pinned: string[];
  ivRank?: Record<string, number>;
  earnings?: unknown; // ow_uw_earnings
  calendar?: unknown; // ow_uw_calendar
  policy?: unknown; // ow_argon_policy_path
  /**
   * ow_uw_iv_term. Carried so the frame can hand the renderer §G.5's ATM
   * implied move, and deliberately NOT scored: §G.2's flow-anomaly test is an
   * IV-rank threshold AND a 30-day volume ratio, and no verified payload in
   * this tenant carries a volume ratio. Half a test, scored honestly as half.
   */
  ivTerm?: unknown;
  actions?: unknown; // ow_massive_actions — splits and ex-dividends
  /** Outstanding ledger commitments that name a ticker, from readLedger. */
  openCalls?: Array<{ id: string; ticker: string; settleDay?: string }>;
  themes: readonly ThemeSpec[];
  pins: FocusConfig["calendarPins"];
  /** Open-session arithmetic, injected: no calendar walk lives in here. */
  openDaysBetween: (from: string, to: string) => number;
  /** Appended to in place when a feed is dropped or truncated. */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

export function decay(
  weight: number,
  sessionsAway: number | null,
  window: number,
): number {
  // §G.3: full points on the day, a straight line to zero at the window's end,
  // nothing outside it. An UNDATED kind (pinned, theme, flowAnomaly) has
  // sessionsAway null and earns its full weight with no decay — "today only,
  // no decay" in the spec's own words. An event already PAST earns nothing: it
  // happened, and its focus-admit commitment is what scores it now.
  if (sessionsAway === null) return weight;
  if (sessionsAway < 0 || window <= 0) return 0;
  if (sessionsAway >= window) return 0;
  return Number((weight * (1 - sessionsAway / window)).toFixed(4));
}

/** The declared window for a dated kind; 0 for the undated ones, which never
 *  reach the division anyway. */
function windowFor(kind: FocusKind, cfg: FocusConfig): number {
  const windows = cfg.windows as unknown as Record<string, number | undefined>;
  return windows[kind] ?? 0;
}

/** `parts[].from` is the tool AND, where a tool answers more than one
 *  question, the field — so a reader can see which half of a test fired. */
function partFrom(event: FocusEvent): string {
  return event.kind === "flowAnomaly"
    ? `${event.source} iv_rank`
    : event.source;
}

/**
 * The admission gate. Nothing here today produces an unadmitted source; the
 * point is the day someone wires a new feed — the event is dropped and named
 * rather than quietly scored.
 */
export function admitEvents(
  events: readonly FocusEvent[],
  notes: string[],
): FocusEvent[] {
  const kept: FocusEvent[] = [];
  for (const event of events) {
    if (ADMITTED_EVENT_SOURCES.has(event.source)) {
      kept.push(event);
      continue;
    }
    notes.push(
      `dropped ${event.ticker} ${event.kind}: source ${event.source} is not an admitted event source`,
    );
  }
  return kept;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

const asRows = (
  payload: unknown,
  key: string,
): Array<Record<string, unknown>> => {
  if (payload === null || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const DAY_PREFIX = 10;

/**
 * Extraction only. `_cfg` is declared because every caller already holds the
 * config and the weights belong to the same declaration — but nothing here
 * reads it: an event is a DATE, and what it is worth is `scoreFocus`'s
 * question, not this one's.
 */
export function focusEvents(
  inputs: FocusInputs,
  _cfg: FocusConfig,
): FocusEvent[] {
  const notes = inputs.notes ?? [];
  const inUniverse = new Set(inputs.universe);
  const raw: FocusEvent[] = [];
  const away = (day: string): number => inputs.openDaysBetween(inputs.day, day);

  // earnings — ow_uw_earnings. A row with a null date is an ETF answering
  // honestly, not an outage, and produces no event.
  for (const row of asRows(inputs.earnings, "rows")) {
    const ticker = str(row.ticker);
    const day = str(row.nextEarningsDate);
    if (ticker === undefined || day === undefined || !inUniverse.has(ticker))
      continue;
    const time = str(row.reportTime);
    const session =
      time === "postmarket" ? "post" : time === "premarket" ? "pre" : undefined;
    raw.push({
      ticker,
      kind: "earnings",
      day,
      sessionsAway: away(day),
      ...(session === undefined ? {} : { session }),
      source: "ow_uw_earnings",
      label: session === undefined ? "earnings" : `earnings (${session})`,
    });
  }

  // macro on the tape — ow_uw_calendar. Dated for the whole market.
  for (const row of asRows(inputs.calendar, "rows")) {
    const at = str(row.time);
    const event = str(row.event);
    if (at === undefined || event === undefined) continue;
    const day = at.slice(0, DAY_PREFIX);
    raw.push({
      ticker: MARKET,
      kind: "macroNamed",
      day,
      sessionsAway: away(day),
      source: "ow_uw_calendar",
      label: event,
    });
  }

  // the dated policy path — ow_argon_policy_path.
  for (const row of asRows(inputs.policy, "meetings")) {
    const day = str(row.meeting_date);
    if (day === undefined) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    raw.push({
      ticker: MARKET,
      kind: "macroNamed",
      day,
      sessionsAway: away(day),
      source: "ow_argon_policy_path",
      label: `FOMC ${str(payload.label) ?? day}`,
    });
  }

  // A SPLIT scores `corporate` on its execution_date, and — until a live call
  // confirms that /stocks/v1/splits returns an ANNOUNCED split ahead of that
  // date — nothing earlier. Announced-but-unexecuted is unverified (Task 6's
  // it.skip), so the weight fires on the date we can see, not on one we hope is
  // served.
  for (const row of asRows(inputs.actions, "splits")) {
    const ticker = str(row.ticker);
    const day = str(row.executionDate);
    if (ticker === undefined || day === undefined || !inUniverse.has(ticker))
      continue;
    raw.push({
      ticker,
      kind: "corporate",
      day,
      sessionsAway: away(day),
      source: "ow_massive_actions",
      label: `split ${String(row.from ?? "?")}-for-${String(row.to ?? "?")}`,
    });
  }

  // An EX-DIVIDEND scores `assignmentRisk` ONLY when it falls inside the window
  // of an open ledger commitment on the same ticker: a dividend on a name we
  // have no position-shaped exposure to is not a reason to watch it, and this
  // list is about what is ahead for OUR book of published calls. Every other
  // ex-dividend row is ignored, not down-weighted.
  // index add/remove, rebalance and spin-off have no feed and enter only as a
  // `focus.calendarPins` row (Task 1's it.skip gates say why).
  const open = inputs.openCalls ?? [];
  for (const row of asRows(inputs.actions, "dividends")) {
    const ticker = str(row.ticker);
    const day = str(row.exDate);
    if (ticker === undefined || day === undefined || !inUniverse.has(ticker))
      continue;
    const spanning = open.some(
      (call) =>
        call.ticker === ticker &&
        day >= inputs.day &&
        (call.settleDay === undefined || day <= call.settleDay),
    );
    if (!spanning) continue;
    raw.push({
      ticker,
      kind: "assignmentRisk",
      day,
      sessionsAway: away(day),
      source: "ow_massive_actions",
      label: `ex-dividend ${String(row.amount ?? "")}`.trim(),
    });
  }

  // our own published calls — the ledger.
  for (const call of open) {
    if (!inUniverse.has(call.ticker)) continue;
    raw.push({
      ticker: call.ticker,
      kind: "openCall",
      ...(call.settleDay === undefined ? {} : { day: call.settleDay }),
      sessionsAway: call.settleDay === undefined ? null : away(call.settleDay),
      source: "ledger",
      label: `open call ${call.id}`,
    });
  }

  // the theme register — undated, today only.
  for (const theme of inputs.themes) {
    for (const instrument of theme.instruments) {
      if (!inUniverse.has(instrument)) continue;
      raw.push({
        ticker: instrument,
        kind: "theme",
        sessionsAway: null,
        source: "tenant.yaml",
        label: `theme ${theme.id}`,
      });
    }
  }

  // the operator's tickers of interest — argon's `pinned` rows.
  for (const ticker of inputs.pinned) {
    if (!inUniverse.has(ticker)) continue;
    raw.push({
      ticker,
      kind: "pinned",
      sessionsAway: null,
      source: "ow_argon_watchlist",
      label: "of interest",
    });
  }

  // `flowAnomaly` is scored from iv_rank >= 80 ALONE. §G.2 also asks for a
  // 30-day volume ratio >= 2x; no verified payload in this tenant carries one,
  // so it is not scored and not faked — and `parts[].from` says `iv_rank` so
  // the missing half is visible in the output.
  for (const [ticker, rank] of Object.entries(inputs.ivRank ?? {})) {
    if (!inUniverse.has(ticker) || !(rank >= 80)) continue;
    raw.push({
      ticker,
      kind: "flowAnomaly",
      sessionsAway: null,
      source: "ow_argon_watchlist",
      label: `IV rank ${String(rank)}`,
    });
  }

  // operator-dated pins — the ONLY path for an index add/remove, a rebalance
  // or a spin-off, because nothing serves them.
  for (const pin of inputs.pins) {
    raw.push({
      ticker: pin.ticker,
      kind: pin.kind,
      day: pin.day,
      sessionsAway: away(pin.day),
      source: "tenant.yaml",
      label: pin.label,
    });
  }

  return admitEvents(raw, notes);
}

// score DESC · daysToNearestEvent ASC (null last) · ticker A-Z. The alphabetical
// last key is what makes the list REPLAYABLE: without it two names on the same
// score come back in payload order, and payload order is the API's, not ours.
function byFocusRank(a: FocusRow, b: FocusRow): number {
  if (a.score !== b.score) return b.score - a.score;
  const da = a.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  const db = b.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  return a.ticker.localeCompare(b.ticker, "en");
}

/** §G.4 asks the daily list for nearest-event order, so the first two keys
 *  swap. A name whose event is today has `daysToNearestEvent === 0` and leads. */
function byNearestFirst(a: FocusRow, b: FocusRow): number {
  const da = a.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  const db = b.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  if (a.score !== b.score) return b.score - a.score;
  return a.ticker.localeCompare(b.ticker, "en");
}

export function scoreFocus(inputs: FocusInputs, cfg: FocusConfig): FocusRow[] {
  const events = focusEvents(inputs, cfg);
  const tickers = [...new Set(inputs.universe)];
  const byTicker = new Map<string, FocusEvent[]>();
  for (const ticker of tickers) byTicker.set(ticker, []);
  for (const event of events) {
    if (event.ticker === MARKET) {
      for (const ticker of tickers) byTicker.get(ticker)!.push(event);
      continue;
    }
    byTicker.get(event.ticker)?.push(event);
  }

  const rows: FocusRow[] = tickers.map((ticker) => {
    const own = byTicker.get(ticker) ?? [];
    const parts: FocusPart[] = own.map((event) => ({
      kind: event.kind,
      points: decay(
        cfg.weights[event.kind],
        event.sessionsAway,
        windowFor(event.kind, cfg),
      ),
      from: partFrom(event),
    }));
    const score = Number(
      parts.reduce((total, part) => total + part.points, 0).toFixed(4),
    );
    // A MARKET-wide event is ahead for everyone, so it cannot say which name
    // has the nearest event of its OWN — the daily list's only question.
    let nearest: FocusEvent | undefined;
    for (const event of own) {
      if (event.ticker === MARKET) continue;
      if (event.sessionsAway === null || event.sessionsAway < 0) continue;
      if (nearest === undefined || event.sessionsAway < nearest.sessionsAway!)
        nearest = event;
    }
    const themeIds = inputs.themes
      .filter((theme) => theme.instruments.includes(ticker))
      .map((theme) => theme.id);
    const rank = inputs.ivRank?.[ticker];
    return {
      ticker,
      score,
      parts,
      daysToNearestEvent: nearest?.sessionsAway ?? null,
      ...(nearest === undefined ? {} : { nearest }),
      ...(rank === undefined ? {} : { ivRank: rank }),
      openCallIds: (inputs.openCalls ?? [])
        .filter((call) => call.ticker === ticker)
        .map((call) => call.id),
      themes: themeIds,
    };
  });
  return rows.sort(byFocusRank);
}

/**
 * §G.0.2 stickiness. `carried` = the tickers whose `focus-admit` commitment is
 * still outstanding; they take slots first, in tie-break order, before any new
 * name. `churn` = carried names dropped anyway (only possible when more are
 * carried than there are slots). Target 0, and it is a metric.
 */
export function selectFocus(args: {
  rows: readonly FocusRow[];
  limit: number;
  carried: readonly string[];
}): {
  rows: FocusRow[];
  churn: number;
  dropped: Array<{ ticker: string; why: string }>;
} {
  const carried = new Set(args.carried);
  const ordered = [...args.rows].sort(byFocusRank);
  const sticky = ordered
    .filter((row) => carried.has(row.ticker))
    .map((row) => ({ ...row, sticky: true }));
  const fresh = ordered.filter((row) => !carried.has(row.ticker));
  const kept = [...sticky, ...fresh].slice(0, args.limit);
  const keptNames = new Set(kept.map((row) => row.ticker));
  const dropped = sticky
    .filter((row) => !keptNames.has(row.ticker))
    .map((row) => ({
      ticker: row.ticker,
      why: `carried list is ${String(args.carried.length)} long; only ${String(args.limit)} slots`,
    }));
  return { rows: kept, churn: dropped.length, dropped };
}

/**
 * §G.4 daily: the names of the weekly list with the nearest event, topped up
 * from the full universe when the weekly list holds fewer than `limit`.
 */
export function dailyFocus(
  weekly: readonly FocusRow[],
  all: readonly FocusRow[],
  limit: number,
): FocusRow[] {
  const picked = [...weekly].sort(byNearestFirst).slice(0, limit);
  if (picked.length >= limit) return picked;
  const taken = new Set(picked.map((row) => row.ticker));
  for (const row of [...all].sort(byNearestFirst)) {
    if (picked.length >= limit) break;
    if (taken.has(row.ticker)) continue;
    taken.add(row.ticker);
    picked.push(row);
  }
  return picked;
}

/**
 * §G.6: "No direction. No sizing. No 'hot stock' reasoning." A persona is a
 * request; a pattern list is a match — the same reasoning `quality/meta-leak.ts`
 * is built on, and the same `{field, pattern, excerpt}` shape. Regex SOURCES,
 * not RegExp objects: a shared /g RegExp carries lastIndex between calls.
 *
 * `\bshort\b` also catches "short interest". Accepted: the row's job is the
 * EVENT, and "borrow" says the same thing without a direction word.
 */
export const FOCUS_BANNED_PATTERNS: readonly string[] = [
  "\\b(?:buy|sell|long|short|bull(?:ish)?|bear(?:ish)?)\\b",
  "\\b(?:target|upside|downside|rally|crash|squeeze|breakout)\\b",
  "\\b(?:size|sizing|position|contracts|shares|allocate)\\b",
  "\\b(?:should|recommend|favou?rite|best|top pick)\\b",
];

const CONTEXT_CHARS = 12;

export function findFocusLeaks(
  rows: ReadonlyArray<{ ticker: string; why: string }>,
): Leak[] {
  const out: Leak[] = [];
  for (const row of rows) {
    if (typeof row.why !== "string" || row.why === "") continue;
    for (const pattern of FOCUS_BANNED_PATTERNS) {
      const regex = new RegExp(pattern, "giu");
      for (const match of row.why.matchAll(regex)) {
        const at = match.index;
        out.push({
          field: `focus ${row.ticker} why`,
          pattern,
          excerpt: row.why.slice(
            Math.max(0, at - CONTEXT_CHARS),
            at + match[0].length + CONTEXT_CHARS,
          ),
        });
      }
    }
  }
  return out;
}
