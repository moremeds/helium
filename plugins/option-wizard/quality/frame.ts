/**
 * One session, framed once: the ranked channels, the fixed coverage rows, the
 * focus lists, yesterday's scored checks and the ledger's own rows.
 *
 * Computed ONCE and read three times — by the analyst and the editor through
 * the deterministic step's handoff, by the renderer out of `report.toolOutputs`,
 * and by the flash-budget gate out of `GateCtx`. Two computations of one
 * ranking is how a prompt and an audit table end up disagreeing about what
 * moved, which is the 2026-09-03 defect this design closes.
 *
 * It reads the audit store (through `channelHistory`), the state tree (through
 * `priorRecord`) and the ledger file, and it NEVER throws: an unrankable day is
 * `mode: "no-data"` with a full set of `untested` rows, and the brief is still
 * writable from it.
 * @module dsh-plugin-tenant-option-wizard/quality/frame
 */
import { existsSync } from "node:fs";
import {
  ledgerPath,
  outstanding,
  readLedger,
  type Commitment,
  type Receipt,
  type RunReport,
} from "@helium/core";
import {
  priorRecord,
  scoreChecks,
  checksLine,
  type ScoredCheck,
} from "../state/checks.js";
import {
  coverageRows,
  extractChannels,
  printedLevels,
  type ChannelId,
  type ChannelInputs,
  type CoverageRow,
} from "./channels.js";
import type { CoverageCandidates } from "./coverage-candidates.js";
import type { EventDaySummary } from "./event-day.js";
import type { MacroReleasesSummary } from "./macro-releases.js";
import type { NewsOverview } from "./news-overview.js";
import { channelHistory } from "./history.js";
import { LABEL_ORDER } from "./prior.js";
import {
  dailyFocus,
  inEventWindow,
  scoreFocus,
  selectFocus,
  type FocusInputs,
  type FocusRow,
} from "./focus.js";
import type { Caps, ReviewConfig, ThemeSpec } from "./review-config.js";
import { select, type SelectMode } from "./select.js";

/** The marker key. The renderer and the gate find this payload in
 *  `report.toolOutputs` BY SHAPE — a tool output does not record its producer. */
export const SESSION_FRAME_KIND = "session-frame/1";

/** The tenant whose ledger and state tree this frame reads. */
const TENANT = "option-wizard";

/**
 * §I.6 will re-weight the focus scores from `focusHitRate` after about eight
 * weeks. Until it does, the table says out loud that its weights were declared
 * rather than fitted — printed under the focus table, never inferred by a
 * reader from a number that looks fitted.
 */
export const FOCUS_WEIGHTS_DECLARED = "2026-09-06";

export type VerdictToken =
  "continue" | "reverse" | "strengthen" | "fade" | "untested";

export interface FrameRanked {
  id: ChannelId;
  series: string;
  level?: string;
  prior?: string;
  move?: string;
  /** The SIGNED move, in the channel's own metric unit. This is the value the
   *  metric row carries, and `quality/history.ts` reads its absolute value back
   *  as next session's denominator — so it is on the payload rather than
   *  recomputed by whoever writes the row. */
  delta?: number;
  score: number | null;
  medianSource: 0 | 1 | null;
  asOf?: string;
  excluded?: string;
}

export interface SettledRow {
  id: string;
  issuedDay: string;
  issuedPhase: string;
  status: string;
  scores: Record<string, number>;
  detail?: unknown;
  evidenceHash?: string;
  payload: unknown;
}

export interface OpenRow {
  id: string;
  issuedDay: string;
  issuedPhase: string;
  payload: unknown;
  barsSeen?: number;
  deadlineBars?: number;
}

/**
 * One dated event §5 may print.
 *
 * Lives here rather than in the renderer because the frame is what reads the
 * dated sources: `ow_uw_calendar` and `ow_argon_policy_path` are siblings of
 * `ow_session_frame`, their payloads never reach `report.toolOutputs` on their
 * own, and on the 2026-09-06 acceptance run the renderer's shape-matched
 * lookup therefore found nothing — zero rows admitted, while the weekly
 * analyst's own paragraph named the 09-16 FOMC anyway.
 */
export interface CalendarRow {
  time: string;
  type: string;
  event: string;
  forecast?: string;
  prev?: string;
  session?: "pre" | "post";
}

/** A source that spells "no value" as `null` must not reach the admission gate
 *  as a value: the gate tests for `undefined`, and `forecast: null` would have
 *  printed `forecast null` on every row. */
function textOrAbsent(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Upcoming macro events stay within seven calendar days; later policy
 *  probabilities remain available in the policy channel as background. */
export function calendarRowsOf(inputs: ChannelInputs, day: string): CalendarRow[] {
  const out: CalendarRow[] = [];
  const calendar = (inputs.calendar as { rows?: unknown } | undefined)?.rows;
  for (const entry of Array.isArray(calendar) ? calendar : []) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const time = textOrAbsent(row.time);
    const event = textOrAbsent(row.event);
    if (time === undefined || event === undefined) continue;
    const forecast = textOrAbsent(row.forecast);
    const prev = textOrAbsent(row.prev);
    const session =
      row.session === "pre" || row.session === "post" ? row.session : undefined;
    out.push({
      time,
      type: textOrAbsent(row.type) ?? "macro",
      event,
      ...(forecast === undefined ? {} : { forecast }),
      ...(prev === undefined ? {} : { prev }),
      ...(session === undefined ? {} : { session }),
    });
  }
  const meetings = (inputs.policy as { meetings?: unknown } | undefined)
    ?.meetings;
  for (const entry of Array.isArray(meetings) ? meetings : []) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const day = textOrAbsent(row.meeting_date);
    if (day === undefined) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const label = textOrAbsent(payload.label) ?? day;
    const stance = textOrAbsent(payload.stance);
    const probability = textOrAbsent(payload.probability);
    const forecast =
      probability === undefined
        ? undefined
        : `${stance ?? "priced"} ${probability}%`;
    const prev = textOrAbsent(payload.target_range);
    out.push({
      time: day,
      type: "policy path",
      event: `FOMC ${label}`,
      ...(forecast === undefined ? {} : { forecast }),
      ...(prev === undefined ? {} : { prev }),
    });
  }
  return out.filter((row) => inEventWindow(day, row.time, 7))
    .sort((a, b) => a.time.localeCompare(b.time));
}

export interface SessionFrame {
  kind: typeof SESSION_FRAME_KIND;
  day: string;
  mode: SelectMode;
  why: string;
  streak?: number;
  ranked: FrameRanked[];
  /** The FIXED list, in declared order, always complete:
   *  `coverage.length + sectors.length + themes.length` rows. */
  rows: CoverageRow[];
  /** §G. Both lists, always. The renderer takes `weekly` for the `weekly` task
   *  and `daily` for `edit` — a task id, never a phase. */
  focus: {
    weekly: FocusRow[];
    daily: FocusRow[];
    churn: number;
    carried: string[];
    dropped: Array<{ ticker: string; why: string }>;
    notes: string[];
    weightsNote: string;
  };
  /** Yesterday's three, already scored. The editor OPENS with this line. */
  checks: {
    line: string;
    scored: ScoredCheck[];
    from?: { day: string; label: string };
  };
  standing?: {
    series: string;
    threshold: string;
    horizon: string;
    breached: boolean;
  };
  /** The ledger, as of AFTER the settler ran earlier in this same run. */
  ledger: {
    settledToday: SettledRow[];
    open: OpenRow[];
    firstCommitmentDay?: string;
    totalCommitments: number;
    unavailable?: string;
  };
  caps: { weekly: Caps; daily: Caps };
  /** The declaration the row list was built from, so the renderer and the tests
   *  can recompute the expected count instead of holding a constant. */
  declared: {
    coverage: string[];
    sectors: string[];
    themes: ThemeSpec[];
    /** §G.4's "exactly 15 / exactly 5, or the row says why not". The renderer
     *  needs the DECLARED size to know a short list is short — the list it was
     *  handed cannot tell it. Absent when the tenant declared no `focus:`. */
    focus?: { weekly: number; daily: number };
  };
  coverage: Array<{
    layer: string;
    source: string;
    asOf?: string;
    state: "ok" | "skipped";
    reason?: string;
  }>;
  /** §5's dated rows, from the calendar and the policy path. Carried on the
   *  frame because those two sibling payloads never reach the renderer. */
  calendar: CalendarRow[];
  /**
   * The figures section 3 will print as levels — the exact list §4 may not
   * restate, ids and numbers, from `printedLevels`.
   *
   * Handed over rather than described. The persona has said NEVER RESTATE A
   * LEVEL SECTION 3 PRINTED since review-v5, and the v6 weekly restated
   * `55.7` anyway and lost the paragraph: a rule the author has to apply to a
   * payload is a rule it can misapply.
   */
  noRestate: Array<{ id: string; level: string }>;
  /** #107 item 2. The ranked week table and the week's dated events, computed
   *  from `ow_stock_week` AFTER the frame is built. The author reads this list
   *  and may not re-rank it; absent when the frame ran without the tool. */
  coverageCandidates?: CoverageCandidates;
  /** #107 item 2. The event day's SUMMARY — the date, why that date, and each
   *  basket's two ends. The member-level table stays in `ow_event_day`'s own
   *  payload: this block points at it, it does not replace it. */
  eventDay?: EventDaySummary;
  /** #113. The tape and the headlines behind each ranked stock, each row
   *  carrying its link. Every phase gets it — the daily runs get the same
   *  block at a smaller scale (`newsCapsFor`). Quotable ONLY as a citation: a
   *  headline is never where a number comes from. */
  newsOverview?: NewsOverview;
  /** #107, the data layer for #106. The week's macro calendar, split into what
   *  is still scheduled and what has already printed, cut to the session on a
   *  daily phase and left whole on the weekly. `unavailable` is the difference
   *  between a quiet week and an unread calendar, and is always carried. */
  macroReleases?: MacroReleasesSummary;
  /** #113 item 1. The overnight movers in the tracked universe — the
   *  IMPORTANCE selector `newsOverview` lacks, since that block is recency
   *  ordered and per-candidate. Premarket and intraday only: after the close
   *  there is no overnight session to report, and the weekly is not a
   *  session. Absent when the phase does not carry it or the tool did not
   *  answer. */
  premarketMovers?: PremarketMoversSummary;
  notes?: string[];
}

/**
 * `ow_premarket_movers`'s payload, carried on the frame verbatim.
 *
 * `ret` is TradingView's OWN percent (`premarket_change`), copied through as a
 * raw double. Nothing here rounds it and nothing recomputes it from a close
 * and a premarket price — the renderer formats, the frame carries.
 */
export interface PremarketMoversSummary {
  /** When the movers were read, ISO. */
  asOf: string;
  /** Which session the percent is measured over. */
  session: string;
  /** Largest absolute move first, truncated to the caller's `top`. */
  rows: Array<{
    /** The ticker as it was asked for — bare where the universe is bare. */
    symbol: string;
    /** The venue-qualified symbol that actually answered. */
    tvSymbol: string;
    ret: number;
    source: string;
  }>;
  /** Every asked symbol with no number for this session. NEVER silently
   *  dropped: an absent name reads as "it did not move". */
  missing: string[];
}

/**
 * Which tool answers which layer. The frame's own coverage table is built from
 * this map and the payloads themselves, so a sibling that could not be called
 * is a PRINTED row with a reason rather than a silently absent input.
 */
const LAYER_SOURCE: ReadonlyArray<readonly [string, string]> = [
  ["macro", "ow_macro_rates"],
  ["policy", "ow_argon_policy_path"],
  ["gex", "ow_uw_gex"],
  ["spot", "ow_spot"],
  ["tide", "ow_uw_market_state"],
  ["calendar", "ow_uw_calendar"],
  ["commodities", "ow_tv_commodities"],
  ["watchlist", "ow_argon_watchlist"],
  ["earnings", "ow_uw_earnings"],
  ["ivTerm", "ow_uw_iv_term"],
  ["actions", "ow_massive_actions"],
];

/** Every as-of a payload might carry, in the order the sources spell it. Copied
 *  VERBATIM — never reformatted, never converted to another zone. */
function asOfOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const row = payload as Record<string, unknown>;
  for (const key of ["asOf", "fetchedAt", "snapshotDate", "dataDate"]) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** `{unavailable: "as-of"}` is an exclusion the source itself declared. */
function unavailableReason(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const row = payload as Record<string, unknown>;
  if (typeof row.unavailable !== "string") return undefined;
  return typeof row.reason === "string"
    ? row.reason
    : `unavailable: ${row.unavailable}`;
}

/** The phase that minted a commitment. `render/ledger.ts` puts it in the id
 *  because two runs share an ET date; `variant` is the run's flavour and is not
 *  a phase, so it is only the fallback. Matched against the KNOWN labels rather
 *  than a `[a-z-]+` group — the rest of the id is hyphenated too, and a greedy
 *  group swallows it. */
function issuedPhaseOf(commitment: Commitment): string {
  const rest = commitment.id.slice("yyyy-mm-dd-".length);
  for (const label of LABEL_ORDER)
    if (rest.startsWith(`${label}-`) || rest === label) return label;
  return commitment.variant;
}

function numberField(payload: unknown, key: string): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** The tickers carried in from an outstanding `focus-admit` commitment. */
function carriedFocus(open: readonly Commitment[]): string[] {
  const out: string[] = [];
  for (const commitment of open) {
    const payload = commitment.payload;
    if (payload === null || typeof payload !== "object") continue;
    const row = payload as Record<string, unknown>;
    if (row.kind !== "focus-admit") continue;
    if (typeof row.ticker === "string" && !out.includes(row.ticker))
      out.push(row.ticker);
  }
  return out.sort((a, b) => a.localeCompare(b, "en"));
}

/** Every commitment that names a ticker, for the focus scorer's `openCall`
 *  weight. A commitment with no ticker is not an event about a name. */
function openCallsFrom(
  open: readonly Commitment[],
): Array<{ id: string; ticker: string; settleDay?: string }> {
  const out: Array<{ id: string; ticker: string; settleDay?: string }> = [];
  for (const commitment of open) {
    const payload = commitment.payload;
    if (payload === null || typeof payload !== "object") continue;
    const row = payload as Record<string, unknown>;
    const ticker =
      typeof row.ticker === "string"
        ? row.ticker
        : typeof row.symbol === "string"
          ? row.symbol
          : undefined;
    if (ticker === undefined) continue;
    out.push({
      id: commitment.id,
      ticker,
      ...(typeof row.settleDay === "string"
        ? { settleDay: row.settleDay }
        : {}),
    });
  }
  return out;
}

export function buildFrame(args: {
  inputs: ChannelInputs;
  focusInputs: FocusInputs;
  /** The trailing open days the move medians are read over. */
  days: string[];
  stateRoot: string;
  /** The run's own label. `priorRecord` returns the newest record strictly
   *  before it; a label that is not a known phase ranks last within its day,
   *  which reads as "the newest record written before this run". */
  label: string;
  review: ReviewConfig;
  /** Siblings that could not answer: layer -> the reason, verbatim. */
  skipped?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): SessionFrame {
  const { review } = args;
  const day = args.inputs.day;
  const notes: string[] = [];

  // Extracted TWICE, on purpose. `extractChannels` is pure and cheap, and the
  // first pass exists only to name the channel ids the one audit read needs;
  // the second is the real one, and it is the only one that has the stored
  // prior LEVELS. Before this, `priorMetrics` was never supplied by anybody,
  // so `policy.path`, `flow` and `curve.shape` could never compute a move.
  const seed = extractChannels(args.inputs);
  const { history, note, priorMetrics } = channelHistory({
    channels: seed,
    inputs: args.inputs,
    days: args.days,
    ...(args.env === undefined ? {} : { env: args.env }),
  });
  if (note !== undefined) notes.push(note);
  const inputs: ChannelInputs = {
    ...args.inputs,
    priorMetrics: { ...priorMetrics, ...args.inputs.priorMetrics },
  };
  const channels = extractChannels(inputs);

  // The standing invalidation is the prior record's, and it is what lets a
  // breached view win the ranking outright.
  const prior = priorRecord({
    stateRoot: args.stateRoot,
    day,
    label: args.label,
  });
  const standing = prior?.state.invalidation;

  const selection = select({
    channels,
    history,
    ...(standing === undefined ? {} : { standing }),
  });

  const rankedIds = new Set(selection.ranked.map((row) => row.channel.id));
  const ranked: FrameRanked[] = [
    ...selection.ranked.map((row) => ({
      id: row.channel.id,
      series: row.channel.series,
      ...(row.channel.level === undefined ? {} : { level: row.channel.level }),
      ...(row.channel.prior === undefined ? {} : { prior: row.channel.prior }),
      ...(row.channel.move === undefined ? {} : { move: row.channel.move }),
      ...(row.channel.delta === undefined ? {} : { delta: row.channel.delta }),
      score: row.score,
      medianSource: row.medianSource,
      ...(row.channel.asOf === undefined ? {} : { asOf: row.channel.asOf }),
    })),
    // An EXCLUDED channel still prints. It is never the one thing and never in
    // prose, but a reader must be able to see that it was looked at.
    ...channels
      .filter((channel) => !rankedIds.has(channel.id))
      .map((channel) => ({
        id: channel.id,
        series: channel.series,
        ...(channel.level === undefined ? {} : { level: channel.level }),
        ...(channel.prior === undefined ? {} : { prior: channel.prior }),
        ...(channel.move === undefined ? {} : { move: channel.move }),
        ...(channel.delta === undefined ? {} : { delta: channel.delta }),
        score: null,
        medianSource: null,
        ...(channel.asOf === undefined ? {} : { asOf: channel.asOf }),
        ...(channel.excluded === undefined
          ? {}
          : { excluded: channel.excluded }),
      })),
  ];

  const declared: SessionFrame["declared"] = {
    coverage: review.coverage,
    sectors: review.sectors,
    themes: review.themes,
    ...(review.focus === undefined
      ? {}
      : { focus: { weekly: review.focus.weekly, daily: review.focus.daily } }),
  };
  const rows = coverageRows(inputs, declared);

  // ---- the ledger, as of AFTER the settler ran earlier in this same run ----
  const path = ledgerPath(args.stateRoot, TENANT);
  const present = existsSync(path);
  const read = present
    ? readLedger(args.stateRoot, TENANT)
    : {
        commitments: [] as Commitment[],
        receipts: [] as Receipt[],
        baselines: [],
      };
  const byId = new Map(read.commitments.map((row) => [row.id, row]));
  const settledToday: SettledRow[] = read.receipts
    .filter((receipt) => receipt.settledAt.slice(0, 10) === day)
    .map((receipt) => {
      const commitment = byId.get(receipt.commitmentId);
      return {
        id: receipt.commitmentId,
        issuedDay: commitment?.issuedAt.slice(0, 10) ?? "",
        issuedPhase: commitment === undefined ? "" : issuedPhaseOf(commitment),
        status: receipt.status,
        scores: receipt.scores,
        ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
        ...(receipt.evidenceHash === undefined
          ? {}
          : { evidenceHash: receipt.evidenceHash }),
        payload: commitment?.payload ?? null,
      };
    });
  const openCommitments = outstanding(read);
  const open: OpenRow[] = openCommitments.map((commitment) => {
    const barsSeen = numberField(commitment.payload, "barsSeen");
    const deadlineBars = numberField(commitment.payload, "deadlineBars");
    return {
      id: commitment.id,
      issuedDay: commitment.issuedAt.slice(0, 10),
      issuedPhase: issuedPhaseOf(commitment),
      payload: commitment.payload,
      ...(barsSeen === undefined ? {} : { barsSeen }),
      ...(deadlineBars === undefined ? {} : { deadlineBars }),
    };
  });
  const days = read.commitments
    .map((commitment) => commitment.issuedAt.slice(0, 10))
    .sort();
  // `calls.open` is the ledger's OWN open count, and the ledger is read here.
  // The row was reaching the model as an ordinary coverage row with
  // "no ledger read for this run" on it, and coming back `untested` — a
  // verdict token on a number this function already holds.
  for (const row of rows)
    if (row.rendererFilled === true && row.id === "calls.open") {
      row.level = String(open.length);
      row.delta = open.length;
      delete row.untested;
    }
  const ledger: SessionFrame["ledger"] = {
    settledToday,
    open,
    ...(days[0] === undefined ? {} : { firstCommitmentDay: days[0] }),
    totalCommitments: read.commitments.length,
    ...(present ? {} : { unavailable: `no ledger at ${path}` }),
  };

  // ---- the focus lists ----
  const focusNotes = args.focusInputs.notes ?? [];
  const focusInputs: FocusInputs = {
    ...args.focusInputs,
    themes: review.themes,
    openCalls: args.focusInputs.openCalls ?? openCallsFrom(openCommitments),
    notes: focusNotes,
  };
  const focusCfg = review.focus;
  let weekly: FocusRow[] = [];
  let daily: FocusRow[] = [];
  let churn = 0;
  let dropped: Array<{ ticker: string; why: string }> = [];
  const carried = carriedFocus(openCommitments);
  if (focusCfg === undefined) {
    focusNotes.push("focus: extensions.review.focus is not declared");
  } else {
    const all = scoreFocus(focusInputs, focusCfg);
    const picked = selectFocus({
      rows: all,
      limit: focusCfg.weekly,
      carried,
    });
    weekly = picked.rows;
    churn = picked.churn;
    dropped = picked.dropped;
    daily = dailyFocus(weekly, all, focusCfg.daily);
  }

  // ---- yesterday's three, already scored ----
  const scored: ScoredCheck[] =
    prior?.state.checks === undefined
      ? []
      : scoreChecks(prior.state.checks, channels);
  const checks: SessionFrame["checks"] = {
    line: prior === null ? "Yesterday: no prior checks." : checksLine(scored),
    scored,
    ...(prior === null ? {} : { from: { day: prior.day, label: prior.label } }),
  };

  // ---- what could be read, and what could not ----
  const payloads: Record<string, unknown> = {
    macro: inputs.macro,
    policy: inputs.policy,
    gex: inputs.gex,
    spot: inputs.spot,
    tide: inputs.tide,
    calendar: inputs.calendar,
    commodities: inputs.commodities,
    watchlist: inputs.watchlist,
    earnings: args.focusInputs.earnings,
    ivTerm: args.focusInputs.ivTerm,
    actions: args.focusInputs.actions,
  };
  const coverage = LAYER_SOURCE.map(([layer, source]) => {
    const skipped = args.skipped?.[layer];
    if (skipped !== undefined)
      return { layer, source, state: "skipped" as const, reason: skipped };
    const payload = payloads[layer];
    if (payload === undefined)
      return {
        layer,
        source,
        state: "skipped" as const,
        reason: "not supplied",
      };
    const declined = unavailableReason(payload);
    const asOf = asOfOf(payload);
    if (declined !== undefined)
      return {
        layer,
        source,
        ...(asOf === undefined ? {} : { asOf }),
        state: "skipped" as const,
        reason: declined,
      };
    return {
      layer,
      source,
      ...(asOf === undefined ? {} : { asOf }),
      state: "ok" as const,
    };
  });

  return {
    kind: SESSION_FRAME_KIND,
    day,
    mode: selection.mode,
    why: selection.why,
    ...(selection.streak === undefined ? {} : { streak: selection.streak }),
    ranked,
    rows,
    focus: {
      weekly,
      daily,
      churn,
      carried,
      dropped,
      notes: focusNotes,
      weightsNote: `weights: declared prior ${FOCUS_WEIGHTS_DECLARED}`,
    },
    checks,
    ...(standing === undefined
      ? {}
      : {
          standing: {
            series: standing.series,
            threshold: standing.threshold,
            horizon: standing.horizon,
            breached: selection.breach !== undefined,
          },
        }),
    ledger,
    caps: { weekly: review.caps.weekly, daily: review.caps.daily },
    declared,
    coverage,
    calendar: calendarRowsOf(inputs, args.focusInputs.day),
    noRestate: printedLevels(rows),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * Every JSON payload a finished run's steps produced, from BOTH places the
 * runner puts one.
 *
 * A model step carries its tool results in `step.toolOutputs`. A DETERMINISTIC
 * step does not: `packages/cli/src/runner.ts` pushes its report row without
 * that field, and the results live in `step.text`, one `<toolName> -> <json>`
 * line per call. The 2026-09-06 acceptance run is how that was found — the
 * frame step ran, `ow_session_frame` answered, and the renderer saw nothing,
 * so the weekly reached argon with no review sections and no masthead.
 *
 * Read here rather than fixed in the runner: `runner.ts` belongs to another
 * change, and a reader that copes with both shapes is correct whichever way
 * that lands.
 */
export function toolPayloadStrings(report: RunReport): string[] {
  const out: string[] = [];
  for (const step of report.steps) {
    out.push(...(step.toolOutputs ?? []));
    for (const line of (step.text ?? "").split("\n")) {
      const arrow = line.indexOf(" -> ");
      if (arrow <= 0) continue;
      const name = line.slice(0, arrow);
      if (!/^[a-z][a-z0-9_]*$/u.test(name)) continue;
      out.push(line.slice(arrow + 4));
    }
  }
  return out;
}

/**
 * §G.5's scoring bar, attached to the focus rows after the frame is built.
 *
 * The implied move first, from `ow_uw_iv_term`'s `implied_move_perc` — the
 * nearest listed expiry at or after the name's own event day. When that tool
 * answered nothing for a name (a skipped sibling, a name with no listed
 * options, or the three-tickers-per-call cap), the realized fallback takes
 * over: the median |2-session return| over the prior 60 sessions, computed by
 * `realizedThreshold` from real daily bars. A name with neither is left alone
 * — it still prints, and it mints no commitment, and the renderer says so.
 *
 * Mutates the rows in place, deliberately: `weekly` and `daily` share row
 * objects, and two copies could disagree about one name's bar.
 */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function attachThresholds(
  frame: SessionFrame,
  ivTerm: unknown,
  realized?: ReadonlyMap<string, number>,
): void {
  const rows = [...frame.focus.weekly, ...frame.focus.daily];
  const listed = Array.isArray((ivTerm as { rows?: unknown } | undefined)?.rows)
    ? ((ivTerm as { rows: Array<Record<string, unknown>> }).rows ?? [])
    : [];
  for (const row of rows) {
    if (row.threshold !== undefined) continue;
    const eventDay = row.nearest?.day;
    const candidates = listed
      .filter(
        (entry) =>
          entry.ticker === row.ticker &&
          typeof entry.implied_move_perc === "number" &&
          Number.isFinite(entry.implied_move_perc) &&
          (entry.implied_move_perc as number) > 0 &&
          (eventDay === undefined ||
            (typeof entry.expiry === "string" && entry.expiry >= eventDay)),
      )
      .sort((a, b) => Number(a.dte) - Number(b.dte));
    const nearest = candidates[0];
    if (nearest !== undefined) {
      // `implied_move_perc` is a FRACTION, not a percent. Verified against the
      // live response on 2026-09-06: AVGO's 2026-09-09 expiry carried
      // implied_move 8.4573 and implied_move_perc 0.02363365728221534 against a
      // spot near 357.9 — 8.4573/357.9 = 0.02363. Multiplied here so that both
      // thresholds, implied and realized, are in the same unit as
      // `settleFocus`'s movePct; without it every name cleared a 0.02% bar and
      // focusHitRate would have read 1.00 forever.
      row.threshold = {
        pct: round4((nearest.implied_move_perc as number) * 100),
        source: `ow_uw_iv_term implied_move_perc, expiry ${String(nearest.expiry)}, dte ${String(nearest.dte)}`,
      };
      continue;
    }
    const fallback = realized?.get(row.ticker);
    if (fallback !== undefined && fallback > 0)
      row.threshold = {
        pct: fallback,
        source:
          "fallback: median |2-session return| over the prior 60 sessions, ow_apex_bars",
      };
  }
}

/**
 * §5's admitted set, extended with the focus list's OWN dated events.
 *
 * The v6 weekly wrote its dated-catalysts paragraph about the focus names'
 * earnings — ADBE on 2026-09-10, ORCL — and the renderer dropped the whole
 * paragraph, because the admitted set held only `ow_uw_calendar`'s macro tape
 * and `ow_argon_policy_path`'s meetings. Those earnings dates come from
 * `ow_uw_earnings`: dated, pollable, from a source `focus.ts` already admits.
 * They satisfy the same admission gate every other row does, so they belong on
 * the calendar rather than in an exception.
 *
 * The forecast is the row's own §G.5 threshold — the implied move it is
 * scored against — which is why this runs AFTER `attachThresholds`. A name
 * whose threshold could not be filled has no forecast and no prior, so it
 * lands in `not admitted` and §5 still may not name it. That is the gate
 * working, not a gap.
 *
 * Only `nearest` is read: it is the one event a focus row carries, and a
 * second dated event behind it is not what the row was selected for.
 */
export function attachFocusCalendar(frame: SessionFrame): void {
  const seen = new Set(frame.calendar.map((row) => `${row.time}|${row.event}`));
  for (const row of frame.focus.weekly) {
    const event = row.nearest;
    if (event === undefined || event.day === undefined) continue;
    if (event.kind !== "earnings" && event.kind !== "corporate") continue;
    const key = `${event.day}|${row.ticker} ${event.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frame.calendar.push({
      time: event.day,
      type: event.kind,
      event: `${row.ticker} ${event.label}`,
      ...(row.threshold === undefined
        ? {}
        : { forecast: `implied move ${String(row.threshold.pct)}%` }),
      ...(event.session === undefined ? {} : { session: event.session }),
    });
  }
  frame.calendar.sort((a, b) => a.time.localeCompare(b.time));
}

/** The same payload back out of a finished run. Null when the step did not run.
 *  Found BY SHAPE, the way `argonBaseline` already finds argon's. */
export function frameFrom(report: RunReport): SessionFrame | null {
  for (const raw of toolPayloadStrings(report)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if ((parsed as { kind?: unknown }).kind === SESSION_FRAME_KIND)
      return parsed as SessionFrame;
  }
  return null;
}
