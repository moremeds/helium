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
  type ChannelId,
  type ChannelInputs,
  type CoverageRow,
} from "./channels.js";
import { channelHistory } from "./history.js";
import { LABEL_ORDER } from "./prior.js";
import {
  dailyFocus,
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
  declared: { coverage: string[]; sectors: string[]; themes: ThemeSpec[] };
  coverage: Array<{
    layer: string;
    source: string;
    asOf?: string;
    state: "ok" | "skipped";
    reason?: string;
  }>;
  notes?: string[];
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
  const { inputs, review } = args;
  const day = inputs.day;
  const notes: string[] = [];

  const channels = extractChannels(inputs);
  const { history, note } = channelHistory({
    channels,
    inputs,
    days: args.days,
    ...(args.env === undefined ? {} : { env: args.env }),
  });
  if (note !== undefined) notes.push(note);

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

  const declared = {
    coverage: review.coverage,
    sectors: review.sectors,
    themes: review.themes,
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
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/** The same payload back out of a finished run. Null when the step did not run.
 *  Found BY SHAPE, the way `argonBaseline` already finds argon's. */
export function frameFrom(report: RunReport): SessionFrame | null {
  for (const step of report.steps) {
    for (const raw of step.toolOutputs ?? []) {
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
  }
  return null;
}
