/**
 * Tool payloads -> `Channel[]` (the ranking) and `CoverageRow[]` (the fixed
 * macro + sector + theme list).
 *
 * ONE extraction, three consumers: the one-thing ranking, the coverage table
 * and the theme register all read the numbers this module produced, so a
 * figure can never disagree with itself across two sections of one document.
 *
 * Pure. No clock, no randomness, no `node:fs`, no `@helium/core` runtime
 * import — types only, `day` is passed in. That is what makes a replay
 * byte-identical.
 *
 * Hard rules, and the reason for each:
 *
 * - **A level is carried as a STRING, verbatim, beside its parsed number.**
 *   Two fields, never one: `Number("764.77")` round-trips to 764.7699999 in a
 *   trading email, and every level the sources hand us is already formatted
 *   the way a reader expects to see it.
 * - **`{unavailable: "as-of"}` is an EXCLUSION, not an error.** It is
 *   recognised by the key, and the source's own reason is copied through.
 * - **`liveNow` before `series`.** argon's daily mirror runs about nine days
 *   behind (measured 2026-09-02); a live level printed under a past date is
 *   the most dangerous number in this whole document.
 * - **A missing datum is `untested`, never a dropped row.** `untested` is the
 *   mechanism that makes "terse, never dropped" enforceable (spec C.2).
 */
import type { Bar } from "../eval/bars.js";
import type { ThemeSpec } from "./review-config.js";
import { themeRow, type BasketExcess } from "./themes.js";

export type ChannelId =
  "rates" | "curve" | "policy" | "credit" | "vol" | "dealer" | "flow" | "event";

export interface Channel {
  id: ChannelId;
  /** Tie-break order; the `#` column of the one-thing channel table. */
  order: number;
  /** A series a reader can look up: "DGS10", "VIXCLS", "BAMLH0A0HYM2",
   *  "9/16 hike probability", "SPY gamma flip", "market tide net premium". */
  series: string;
  /** Today's level VERBATIM as the source wrote it — a string, never a number. */
  level?: string;
  prior?: string;
  /** The move, formatted once, here, with its unit: "-1.14 pts", "+4.0 bp". */
  move?: string;
  /** Signed magnitude for scoring and for verdict classification. Undefined =
   *  EXCLUDED: never the one thing, never in prose, metric row `null`. */
  delta?: number;
  magnitude?: number;
  signFlip?: boolean;
  /** The source's own as-of string, copied. */
  asOf?: string;
  excluded?: string;
}

/** The declared row ids of `extensions.review.coverage`. A sector row's id is
 *  `sector:<chain>` — the chain name VERBATIM from argon's rail. A theme row's
 *  is `theme:<id>` — the id VERBATIM from the register. */
export type CoverageRowId = string;

export interface CoverageRow {
  id: CoverageRowId;
  /** Print order = declared order. Never sorted, never dropped. */
  order: number;
  /** What settles it, in one string a later run can look up. */
  series: string;
  level?: string;
  prior?: string;
  move?: string;
  delta?: number;
  asOf?: string;
  /** Renderer-filled extra for a sector row: the chain's members, from argon. */
  members?: string[];
  /** Theme rows only: the §H.2 triple and the kill state. */
  theme?: {
    week: BasketExcess | null;
    sinceEntered: BasketExcess | null;
    kill: { armed: string; met: boolean; why?: string };
    evidence: string[];
  };
  /** Set iff the datum is absent. The row still prints, as `untested`. */
  untested?: string;
  /**
   * The renderer fills this row itself and the MODEL must not answer it.
   *
   * `calls.open` is the ledger's own open count. It was handed to the model as
   * an ordinary coverage row on 2026-09-06 and came back `untested` — a
   * verdict token on a number the renderer already holds, which can never be
   * anything but noise. It still occupies its declared slot, so the row count
   * is unchanged; only the authorship moves.
   */
  rendererFilled?: true;
}

export interface ChannelInputs {
  macro?: unknown; // ow_macro_rates
  policy?: unknown; // ow_argon_policy_path
  gex?: unknown; // ow_uw_gex
  spot?: unknown; // ow_spot
  tide?: unknown; // ow_uw_market_state
  calendar?: unknown; // ow_uw_calendar
  commodities?: unknown; // ow_tv_commodities
  watchlist?: unknown; // ow_argon_watchlist
  bars?: unknown; // per-symbol weekly % for the sector rows
  /** Daily bars by symbol, for the theme baskets. Empty map = every theme row
   *  is `untested`, which is a printed row, not a missing one. */
  themeBars?: ReadonlyMap<string, readonly Bar[]>;
  /** Open commitment count, for the `calls.open` row. Supplied, not fetched. */
  openCalls?: number;
  /** Prior stored metric values by metric name, for channels whose d1 lives in
   *  the audit table rather than in their own payload. */
  priorMetrics?: Record<string, number | null>;
  day: string;
  /** The newest day the BARS actually reach, at or before `day`. The local
   *  apex series lags — on 2026-09-06 it stopped at 2026-08-28 — and
   *  `closeAt` answers with the newest close at or before whatever day it is
   *  given, so measuring a "week" to `day` would silently report a perfectly
   *  calm 0.00 %. `rotationTable` already takes the benchmark's newest bar as
   *  its as-of for exactly this reason; the coverage rows take the same one.
   *  Absent means the bars reach `day`. */
  barsAsOf?: string;
  /** The first day of the coverage period, for the theme week window. */
  weekFrom?: string;
  /** The benchmark the theme baskets are measured against; declared at
   *  `extensions.review.rotation.benchmark`. */
  benchmark?: string;
}

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------

/** Returns `undefined` on a non-finite result, so a `"."` FRED row can never
 *  become a `NaN` in a metric. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function signed(value: number, digits: number, unit: string): string {
  const fixed = Math.abs(value).toFixed(digits);
  return `${value < 0 ? "-" : "+"}${fixed} ${unit}`;
}

/** The source's own exclusion, recognised by its key rather than by parsing a
 *  message. `undefined` when the payload is usable. */
function unavailable(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return "no payload";
  if (typeof payload !== "object") return "no payload";
  const row = payload as { unavailable?: unknown; reason?: unknown };
  // A NON-EMPTY STRING and nothing else. The marker is `{unavailable: "as-of"}`
  // — a kind, spelled out. `ow_uw_gex` uses the same key for something else
  // entirely: a per-ticker array of the tickers that did NOT answer, which is
  // `[]` on a completely successful call. `String([])` is `""`, so every
  // healthy gex payload read as "unavailable, reason blank" and
  // `dealer.positioning` printed UNTESTED with an empty reason on every run.
  if (typeof row.unavailable !== "string" || row.unavailable === "")
    return undefined;
  const why = typeof row.reason === "string" ? ` — ${row.reason}` : "";
  return `${row.unavailable}${why}`;
}

// ---------------------------------------------------------------------------
// ow_macro_rates
// ---------------------------------------------------------------------------

interface SeriesRow {
  series_id: string;
  obs_date: string;
  value: number;
}

function seriesRows(macro: unknown, id: string): SeriesRow[] {
  const rows = (macro as { series?: { rows?: unknown } } | undefined)?.series
    ?.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is SeriesRow =>
        typeof row === "object" &&
        row !== null &&
        (row as SeriesRow).series_id === id &&
        finite((row as SeriesRow).value) !== undefined,
    )
    .sort((a, b) => b.obs_date.localeCompare(a.obs_date));
}

/** The live TradingView level for a FRED id, when the run had one. */
function liveLevel(
  macro: unknown,
  fredId: string,
): { last: number; changeAbs?: number; fetchedAt?: string } | undefined {
  const live = (macro as { liveNow?: unknown } | undefined)?.liveNow;
  if (live === undefined || unavailable(live) !== undefined) return undefined;
  const quotes = (live as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes)) return undefined;
  const hit = quotes.find(
    (q) => (q as { fredId?: unknown })?.fredId === fredId,
  ) as { last?: unknown; changeAbs?: unknown } | undefined;
  const last = finite(hit?.last);
  if (last === undefined) return undefined;
  const changeAbs = finite(hit?.changeAbs);
  return {
    last,
    ...(changeAbs === undefined ? {} : { changeAbs }),
    ...(typeof (live as { fetchedAt?: unknown }).fetchedAt === "string"
      ? { fetchedAt: (live as { fetchedAt: string }).fetchedAt }
      : {}),
  };
}

function fredPoint(
  macro: unknown,
  id: string,
): { value: number; asOf: string } | undefined {
  const points = (macro as { fredDirect?: { points?: unknown } } | undefined)
    ?.fredDirect?.points;
  if (!Array.isArray(points)) return undefined;
  const hit = points.find((p) => (p as { series?: unknown })?.series === id) as
    { value?: unknown; asOf?: unknown } | undefined;
  const value = finite(hit?.value);
  if (value === undefined || typeof hit?.asOf !== "string") return undefined;
  return { value, asOf: hit.asOf };
}

/**
 * A level plus its prior observation, live-first then the daily mirror.
 * `unit` decides the formatting: yields move in basis points, VIX in points.
 */
function levelChannel(args: {
  id: ChannelId;
  order: number;
  macro: unknown;
  fredId: string;
  unit: "bp" | "pts";
}): Channel {
  const { id, order, macro, fredId, unit } = args;
  const base: Channel = { id, order, series: fredId };
  const rows = seriesRows(macro, fredId);
  const live = liveLevel(macro, fredId);
  if (live !== undefined) {
    const prior = rows[0];
    const priorValue =
      live.changeAbs !== undefined
        ? live.last - live.changeAbs
        : finite(prior?.value);
    if (priorValue === undefined) {
      return {
        ...base,
        level: String(live.last),
        excluded: `no prior observation for ${fredId}`,
      };
    }
    const raw = live.last - priorValue;
    const delta = round4(unit === "bp" ? raw * 100 : raw);
    return {
      ...base,
      level: String(live.last),
      prior: String(priorValue),
      move: signed(delta, unit === "bp" ? 1 : 2, unit),
      delta,
      magnitude: Math.abs(delta),
      ...(live.fetchedAt === undefined ? {} : { asOf: live.fetchedAt }),
    };
  }
  const direct = fredPoint(macro, fredId);
  const newest = rows[0];
  const prior = rows[1];
  const level = direct?.value ?? finite(newest?.value);
  if (level === undefined) {
    return { ...base, excluded: `${fredId} not ingested` };
  }
  // The direct FRED read and the daily mirror can disagree about which day is
  // newest, so the prior is only ever taken from the mirror's own second row
  // when the level came from the mirror too.
  const priorValue =
    direct === undefined ? finite(prior?.value) : finite(newest?.value);
  const asOf = direct?.asOf ?? newest?.obs_date;
  if (priorValue === undefined) {
    return {
      ...base,
      level: String(level),
      ...(asOf === undefined ? {} : { asOf }),
      excluded: `no prior observation for ${fredId}`,
    };
  }
  const raw = level - priorValue;
  const delta = round4(unit === "bp" ? raw * 100 : raw);
  return {
    ...base,
    level: String(level),
    prior: String(priorValue),
    move: signed(delta, unit === "bp" ? 1 : 2, unit),
    delta,
    magnitude: Math.abs(delta),
    ...(asOf === undefined ? {} : { asOf }),
  };
}

// ---------------------------------------------------------------------------
// the other payloads
// ---------------------------------------------------------------------------

interface PolicyMeeting {
  meeting_date?: string;
  snapshot_date?: string;
  payload?: {
    label?: string;
    stance?: string;
    probability?: number;
    target_range?: string;
  };
}

function nextMeeting(policy: unknown): PolicyMeeting | undefined {
  const meetings = (policy as { meetings?: unknown } | undefined)?.meetings;
  if (!Array.isArray(meetings) || meetings.length === 0) return undefined;
  return meetings[0] as PolicyMeeting;
}

function policyChannel(inputs: ChannelInputs): Channel {
  const base: Channel = { id: "policy", order: 3, series: "policy path" };
  const excluded = unavailable(inputs.policy);
  if (excluded !== undefined) return { ...base, excluded };
  const meeting = nextMeeting(inputs.policy);
  const probability = finite(meeting?.payload?.probability);
  if (meeting === undefined || probability === undefined) {
    return { ...base, excluded: "no dated meeting in the policy path" };
  }
  const label =
    meeting.payload?.label ?? meeting.meeting_date ?? "next meeting";
  const stance = (meeting.payload?.stance ?? "").toLowerCase();
  const series = `${label} ${stance || "policy"} probability`;
  const asOf = meeting.snapshot_date;
  // The probability's own payload carries no prior, so the d1 comes from the
  // audit table — the metric this same module wrote on the previous run.
  const prior = inputs.priorMetrics?.["channel.policy.prob_pp"];
  if (prior === undefined || prior === null || !Number.isFinite(prior)) {
    return {
      ...base,
      series,
      level: String(probability),
      ...(asOf === undefined ? {} : { asOf }),
      excluded: "no prior observation for the policy path",
    };
  }
  const delta = round4(probability - prior);
  return {
    ...base,
    series,
    level: String(probability),
    prior: String(prior),
    move: signed(delta, 1, "pp"),
    delta,
    magnitude: Math.abs(delta),
    ...(asOf === undefined ? {} : { asOf }),
  };
}

function curveChannel(inputs: ChannelInputs): Channel {
  const base: Channel = { id: "curve", order: 2, series: "2s10s" };
  const live = (inputs.macro as { liveNow?: unknown } | undefined)?.liveNow;
  const spread =
    live !== undefined && unavailable(live) === undefined
      ? finite((live as { spreads?: { "2s10s"?: unknown } }).spreads?.["2s10s"])
      : undefined;
  if (spread !== undefined) {
    const prior = inputs.priorMetrics?.["channel.curve.spread_bp"];
    if (prior === undefined || prior === null || !Number.isFinite(prior)) {
      return {
        ...base,
        level: String(spread),
        excluded: "no prior observation for 2s10s",
      };
    }
    const delta = round4(spread - prior);
    return {
      ...base,
      level: String(spread),
      prior: String(prior),
      move: signed(delta, 1, "bp"),
      delta,
      magnitude: Math.abs(delta),
    };
  }
  const ten = seriesRows(inputs.macro, "DGS10");
  const two = seriesRows(inputs.macro, "DGS2");
  if (two.length === 0) {
    // argon's macro mirror does not ingest DGS2 at all, so there is no front
    // end and therefore no curve. Naming the series is what makes this
    // actionable rather than a shrug.
    return { ...base, excluded: "DGS2 not ingested; 2s10s cannot be computed" };
  }
  if (ten.length === 0) {
    return {
      ...base,
      excluded: "DGS10 not ingested; 2s10s cannot be computed",
    };
  }
  const now = round4((ten[0]!.value - two[0]!.value) * 100);
  const before =
    ten[1] === undefined || two[1] === undefined
      ? undefined
      : round4((ten[1].value - two[1].value) * 100);
  if (before === undefined) {
    return {
      ...base,
      level: String(now),
      excluded: "no prior observation for 2s10s",
    };
  }
  const delta = round4(now - before);
  return {
    ...base,
    level: String(now),
    prior: String(before),
    move: signed(delta, 1, "bp"),
    delta,
    magnitude: Math.abs(delta),
    asOf: ten[0]!.obs_date,
  };
}

interface GexLevel {
  ticker?: string;
  gammaFlip?: unknown;
  callWall?: unknown;
  putWall?: unknown;
  asOf?: unknown;
}

function dealerChannel(inputs: ChannelInputs): Channel {
  const base: Channel = { id: "dealer", order: 6, series: "gamma flip" };
  const excluded = unavailable(inputs.gex);
  if (excluded !== undefined) return { ...base, excluded };
  const levels = (inputs.gex as { levels?: unknown }).levels;
  const first = (Array.isArray(levels) ? levels[0] : undefined) as
    GexLevel | undefined;
  if (first === undefined) {
    return { ...base, excluded: "no dealer levels in the payload" };
  }
  const ticker = String(first.ticker ?? "index");
  const flip = first.gammaFlip;
  if (flip === undefined || flip === null) {
    return {
      ...base,
      series: `${ticker} gamma flip`,
      excluded: "no gamma flip level",
    };
  }
  // ow_uw_gex returns every level as a STRING on purpose; it is copied, and
  // only the parsed copy is ever subtracted.
  const flipNumber = finite(Number(flip));
  const spotRow = spotQuote(inputs.spot, ticker);
  const spot = spotRow === undefined ? undefined : finite(spotRow.last);
  if (flipNumber === undefined || spot === undefined) {
    return {
      ...base,
      series: `${ticker} gamma flip`,
      level: String(flip),
      excluded: "no spot to measure the distance from",
    };
  }
  const delta = round4(spot - flipNumber);
  return {
    ...base,
    series: `${ticker} gamma flip`,
    level: String(flip),
    prior: String(spotRow?.rawLast ?? spot),
    move: signed(delta, 2, "pts"),
    delta,
    magnitude: Math.abs(delta),
    ...(typeof first.asOf === "string" ? { asOf: first.asOf } : {}),
  };
}

interface TidePrint {
  timestamp?: string;
  date?: string;
  net_call_premium?: unknown;
  net_put_premium?: unknown;
}

function flowChannel(inputs: ChannelInputs): Channel {
  const base: Channel = {
    id: "flow",
    order: 7,
    series: "market tide net premium",
  };
  const excluded = unavailable(inputs.tide);
  if (excluded !== undefined) return { ...base, excluded };
  const data = (inputs.tide as { marketTide?: { data?: unknown } }).marketTide
    ?.data;
  const prints = Array.isArray(data) ? (data as TidePrint[]) : [];
  const last = prints.at(-1);
  const call = finite(Number(last?.net_call_premium));
  const put = finite(Number(last?.net_put_premium));
  if (last === undefined || call === undefined || put === undefined) {
    return { ...base, excluded: "no market tide print" };
  }
  const net = round4(call - put);
  const prior = inputs.priorMetrics?.["channel.flow.net_premium_usd"];
  const asOf =
    typeof last.timestamp === "string"
      ? last.timestamp
      : (last.date ?? undefined);
  if (prior === undefined || prior === null || !Number.isFinite(prior)) {
    return {
      ...base,
      level: String(net),
      ...(asOf === undefined ? {} : { asOf }),
      excluded: "no prior observation for the market tide",
    };
  }
  const delta = round4(net - prior);
  return {
    ...base,
    level: String(net),
    prior: String(prior),
    move: signed(delta, 0, "USD"),
    delta,
    magnitude: Math.abs(delta),
    ...(asOf === undefined ? {} : { asOf }),
  };
}

function eventChannel(inputs: ChannelInputs): Channel {
  const base: Channel = { id: "event", order: 8, series: "dated event" };
  const excluded = unavailable(inputs.calendar);
  if (excluded !== undefined) return { ...base, excluded };
  const rows = (inputs.calendar as { rows?: unknown }).rows;
  const today = (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      typeof (row as { time?: unknown })?.time === "string" &&
      (row as { time: string }).time.slice(0, 10) === inputs.day,
  ) as Array<{ event?: unknown; time?: string }>;
  if (today.length === 0) {
    return { ...base, excluded: "no dated event lands today" };
  }
  const first = today[0]!;
  return {
    ...base,
    series: String(first.event ?? "dated event"),
    level: String(today.length),
    // A dated event has no magnitude of its own; `quality/select.ts` scores it
    // with EVENT_SCORE rather than against a median.
    ...(first.time === undefined ? {} : { asOf: first.time }),
  };
}

// ---------------------------------------------------------------------------
// ow_spot
// ---------------------------------------------------------------------------

interface SpotQuote {
  last: number;
  rawLast: string;
  changeAbs?: number;
  rawChangeAbs?: string;
}

function spotQuote(spot: unknown, ticker: string): SpotQuote | undefined {
  if (spot === undefined || unavailable(spot) !== undefined) return undefined;
  const quotes = (spot as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes)) return undefined;
  const hit = quotes.find(
    (q) => (q as { ticker?: unknown })?.ticker === ticker,
  ) as { last?: unknown; changeAbs?: unknown } | undefined;
  const last = finite(hit?.last);
  if (last === undefined) return undefined;
  const changeAbs = finite(hit?.changeAbs);
  return {
    last,
    rawLast: String(hit?.last),
    ...(changeAbs === undefined
      ? {}
      : { changeAbs, rawChangeAbs: signedString(changeAbs) }),
  };
}

/** The change, copied with its sign restored — never recomputed. */
function signedString(value: number): string {
  return `${value < 0 ? "" : "+"}${String(value)}`;
}

// ---------------------------------------------------------------------------
// the ranking
// ---------------------------------------------------------------------------

export function extractChannels(inputs: ChannelInputs): Channel[] {
  const channels: Channel[] = [
    levelChannel({
      id: "rates",
      order: 1,
      macro: inputs.macro,
      fredId: "DGS10",
      unit: "bp",
    }),
    curveChannel(inputs),
    policyChannel(inputs),
    levelChannel({
      id: "credit",
      order: 4,
      macro: inputs.macro,
      fredId: "BAMLH0A0HYM2",
      unit: "bp",
    }),
    levelChannel({
      id: "vol",
      order: 5,
      macro: inputs.macro,
      fredId: "VIXCLS",
      unit: "pts",
    }),
    dealerChannel(inputs),
    flowChannel(inputs),
    eventChannel(inputs),
  ];
  return channels.sort((a, b) => a.order - b.order);
}

const CHANNEL_SERIES: Partial<Record<ChannelId, string>> = {
  rates: "DGS10",
  credit: "BAMLH0A0HYM2",
  vol: "VIXCLS",
};

/** The observation history a channel can supply from its OWN payload, newest
 *  first. Empty when the payload carries no series for it. */
export function seriesHistory(inputs: ChannelInputs, id: ChannelId): number[] {
  const fredId = CHANNEL_SERIES[id];
  if (fredId === undefined) return [];
  return seriesRows(inputs.macro, fredId).map((row) => row.value);
}

// ---------------------------------------------------------------------------
// the coverage table
// ---------------------------------------------------------------------------

const INDEX_SET = ["SPY", "QQQ", "IWM"] as const;

interface WatchlistChain {
  chain?: string;
  layer?: string;
  count?: number;
  members?: string[];
  asOf?: string;
}

function watchlistChains(watchlist: unknown): WatchlistChain[] {
  if (watchlist === undefined || unavailable(watchlist) !== undefined)
    return [];
  const chains = (watchlist as { chains?: unknown }).chains;
  return Array.isArray(chains) ? (chains as WatchlistChain[]) : [];
}

/** A channel's numbers, reshaped as a coverage row. The two carry the same
 *  fields on purpose: one extraction, two consumers. */
function fromChannel(
  id: string,
  order: number,
  channel: Channel,
  seriesOverride?: string,
): CoverageRow {
  const row: CoverageRow = {
    id,
    order,
    series: seriesOverride ?? channel.series,
    ...(channel.level === undefined ? {} : { level: channel.level }),
    ...(channel.prior === undefined ? {} : { prior: channel.prior }),
    ...(channel.move === undefined ? {} : { move: channel.move }),
    ...(channel.delta === undefined ? {} : { delta: channel.delta }),
    ...(channel.asOf === undefined ? {} : { asOf: channel.asOf }),
  };
  // A row with a level but no move is still answered; only a row with no
  // number at all is untested.
  if (channel.level === undefined && channel.excluded !== undefined) {
    row.untested = channel.excluded;
  }
  return row;
}

function frontEndRow(inputs: ChannelInputs, order: number): CoverageRow {
  const channel = levelChannel({
    id: "rates",
    order,
    macro: inputs.macro,
    fredId: "DGS2",
    unit: "bp",
  });
  return fromChannel("rates.front", order, channel, "DGS2");
}

function commoditiesRow(inputs: ChannelInputs, order: number): CoverageRow {
  const base: CoverageRow = { id: "commodities", order, series: "gold, crude" };
  const excluded = unavailable(inputs.commodities);
  if (excluded !== undefined) return { ...base, untested: excluded };
  const rows = (inputs.commodities as { rows?: unknown }).rows;
  const list = Array.isArray(rows)
    ? (rows as Array<{ label?: string; close?: unknown; change_pct?: unknown }>)
    : [];
  const gold = list.find((r) => r.label === "gold");
  const crude = list.find((r) => r.label === "WTI crude");
  if (gold === undefined && crude === undefined) {
    return { ...base, untested: "no gold or crude row in the payload" };
  }
  const asOf = (inputs.commodities as { asOf?: unknown }).asOf;
  const parts = [gold, crude]
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map(
      (r) =>
        `${r.label} ${String(r.close)}${
          finite(r.change_pct) === undefined
            ? ""
            : ` (${signedString(round4(r.change_pct as number))}%)`
        }`,
    );
  return {
    ...base,
    level: String(gold?.close ?? crude?.close),
    move: parts.join(" · "),
    ...(typeof asOf === "string" ? { asOf } : {}),
  };
}

function fxRow(inputs: ChannelInputs, order: number): CoverageRow {
  const base: CoverageRow = { id: "fx", order, series: "DXY" };
  const dxy = spotQuote(inputs.spot, "DXY");
  if (dxy !== undefined) {
    return {
      ...base,
      level: dxy.rawLast,
      ...(dxy.rawChangeAbs === undefined ? {} : { move: dxy.rawChangeAbs }),
    };
  }
  // The Fed broad index is a DIFFERENT index on a different scale, so it is
  // named as itself rather than passed off as DXY.
  const broad = seriesRows(inputs.macro, "DTWEXBGS");
  if (broad.length === 0) {
    return { ...base, untested: "no DXY quote and DTWEXBGS not ingested" };
  }
  return {
    ...base,
    series: "DTWEXBGS (Fed broad index, not DXY)",
    level: String(broad[0]!.value),
    ...(broad[1] === undefined
      ? {}
      : {
          prior: String(broad[1].value),
          move: signed(
            round4(broad[0]!.value - broad[1].value),
            4,
            "index pts",
          ),
        }),
    asOf: broad[0]!.obs_date,
  };
}

function internalsRow(inputs: ChannelInputs, order: number): CoverageRow {
  const base: CoverageRow = {
    id: "equity.internals",
    order,
    series: INDEX_SET.join(", "),
  };
  const quotes: Array<{ ticker: string; quote: SpotQuote }> = [];
  for (const ticker of INDEX_SET) {
    const quote = spotQuote(inputs.spot, ticker);
    if (quote !== undefined) quotes.push({ ticker, quote });
  }
  if (quotes.length === 0) {
    return { ...base, untested: unavailable(inputs.spot) ?? "no index quote" };
  }
  const lead = quotes[0]!;
  return {
    ...base,
    // The strings are COPIED. `changeAbs` was formatted by the source; a
    // recomputation here would be the model doing arithmetic with extra steps.
    level: lead.quote.rawLast,
    move: quotes
      .map(
        (entry) =>
          `${entry.ticker} ${entry.quote.rawChangeAbs ?? entry.quote.rawLast}`,
      )
      .join(" · "),
    ...(typeof (inputs.spot as { fetchedAt?: unknown })?.fetchedAt === "string"
      ? { asOf: (inputs.spot as { fetchedAt: string }).fetchedAt }
      : {}),
  };
}

function callsOpenRow(inputs: ChannelInputs, order: number): CoverageRow {
  const base: CoverageRow = {
    id: "calls.open",
    order,
    series: "open commitments",
  };
  // PUBLISHED CANDIDATES AND FORECASTS ONLY. The /flash page is public; a
  // holding, a size or a ticker from the book must never reach it, so the
  // COUNT is the whole datum this row carries.
  const count = inputs.openCalls;
  if (count === undefined || !Number.isFinite(count)) {
    return { ...base, rendererFilled: true, untested: "no ledger read for this run" };
  }
  return { ...base, rendererFilled: true, level: String(count), delta: count };
}

function sectorRow(
  chainName: string,
  inputs: ChannelInputs,
  order: number,
): CoverageRow {
  const base: CoverageRow = {
    id: `sector:${chainName}`,
    order,
    series: `${chainName} members, weekly %`,
  };
  const chains = watchlistChains(inputs.watchlist);
  if (chains.length === 0) {
    return {
      ...base,
      untested: unavailable(inputs.watchlist) ?? "no argon watchlist read",
    };
  }
  const hit = chains.find((chain) => chain.chain === chainName);
  if (hit === undefined) {
    // A chain argon's rail does not serve is `chain unknown`, not a dropped
    // row — the same mechanism as a macro row with no source.
    return { ...base, untested: `chain unknown to argon's rail` };
  }
  const members = Array.isArray(hit.members) ? hit.members : [];
  const row: CoverageRow = {
    ...base,
    members,
    ...(typeof hit.asOf === "string" ? { asOf: hit.asOf } : {}),
  };
  const bars = inputs.themeBars;
  if (bars === undefined || inputs.weekFrom === undefined) {
    return { ...row, untested: "no weekly bars for the chain members" };
  }
  // Measured TO the day the bars reach, and dated by it. The watchlist's own
  // scan stamp says when the MEMBERSHIP was read; it is not when the prices
  // were, and printing it beside a weekly % would date the number wrong.
  const toDay = inputs.barsAsOf ?? inputs.day;
  const excess = themeRow(
    {
      id: "sector",
      thesis: chainName,
      horizon: "1w",
      entered: inputs.weekFrom,
      instruments: members,
      evidence: [],
      kill: "",
    },
    bars,
    toDay,
    inputs.weekFrom,
    inputs.benchmark ?? "SPY",
  );
  if (excess.week === null) {
    return { ...row, untested: "no weekly bars for the chain members" };
  }
  return {
    ...row,
    asOf: toDay,
    level: String(excess.week.basketPct),
    move: `${signedString(excess.week.excessPct)}% vs ${inputs.benchmark ?? "SPY"} (${excess.week.used.length} of ${members.length})`,
    delta: excess.week.excessPct,
  };
}

function registerRow(
  theme: ThemeSpec,
  inputs: ChannelInputs,
  order: number,
): CoverageRow {
  const benchmark = inputs.benchmark ?? "SPY";
  const bars = inputs.themeBars ?? new Map<string, readonly Bar[]>();
  const toDay = inputs.barsAsOf ?? inputs.day;
  const computed = themeRow(
    theme,
    bars,
    toDay,
    inputs.weekFrom ?? theme.entered,
    benchmark,
  );
  const base: CoverageRow = {
    id: computed.rowId,
    order,
    series: `${theme.instruments.join(",")} equal-weight vs ${benchmark}, excess %`,
    theme: {
      week: computed.week,
      sinceEntered: computed.sinceEntered,
      kill: computed.kill,
      evidence: theme.evidence.map((row) =>
        row.tool === undefined ? `${row.text} (operator-checked)` : row.text,
      ),
    },
  };
  if (computed.week === null && computed.sinceEntered === null) {
    const have = theme.instruments.filter((s) => bars.has(s)).length;
    return {
      ...base,
      untested: `no bars for ${theme.instruments.length - have} of ${theme.instruments.length} instruments`,
    };
  }
  const week = computed.week;
  const since = computed.sinceEntered;
  return {
    ...base,
    asOf: toDay,
    ...(week === null ? {} : { level: signedString(week.excessPct) }),
    ...(since === null ? {} : { prior: signedString(since.excessPct) }),
    move: [
      week === null ? undefined : `${signedString(week.excessPct)}% (1w)`,
      since === null
        ? undefined
        : `${signedString(since.excessPct)}% (since ${theme.entered})`,
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
    ...(week === null ? {} : { delta: week.excessPct }),
  };
}

/**
 * The declared coverage list, in declared order, ALWAYS complete.
 *
 * `declared` comes straight from `parseReviewConfig`; a row the payloads cannot
 * answer carries `untested` and still prints. The returned length is ALWAYS
 * `coverage.length + sectors.length + themes.length`. There is no code path
 * that omits a row.
 */
export function coverageRows(
  inputs: ChannelInputs,
  declared: {
    coverage: string[];
    sectors: string[];
    themes: readonly ThemeSpec[];
  },
): CoverageRow[] {
  const channels = new Map(
    extractChannels(inputs).map((channel) => [channel.id, channel]),
  );
  const rows: CoverageRow[] = [];
  declared.coverage.forEach((id, index) => {
    const order = rows.length;
    switch (id) {
      case "rates.front":
        rows.push(frontEndRow(inputs, order));
        return;
      case "rates.long":
        rows.push(fromChannel(id, order, channels.get("rates")!));
        return;
      case "curve.shape":
        rows.push(fromChannel(id, order, channels.get("curve")!));
        return;
      case "policy.path":
        rows.push(fromChannel(id, order, channels.get("policy")!));
        return;
      case "credit":
        rows.push(fromChannel(id, order, channels.get("credit")!));
        return;
      case "vol":
        rows.push(fromChannel(id, order, channels.get("vol")!));
        return;
      case "dealer.positioning":
        rows.push(fromChannel(id, order, channels.get("dealer")!));
        return;
      case "flow":
        rows.push(fromChannel(id, order, channels.get("flow")!));
        return;
      case "commodities":
        rows.push(commoditiesRow(inputs, order));
        return;
      case "fx":
        rows.push(fxRow(inputs, order));
        return;
      case "equity.internals":
        rows.push(internalsRow(inputs, order));
        return;
      case "calls.open":
        rows.push(callsOpenRow(inputs, order));
        return;
      default:
        // A declared row this module has no extractor for still PRINTS. A
        // silent omission is the one failure the coverage list exists to
        // prevent, so an unknown id is untested and named, not dropped.
        rows.push({
          id,
          order,
          series: id,
          untested: `no extractor for the declared row ${id} (declared at index ${index})`,
        });
    }
  });
  for (const chain of declared.sectors) {
    rows.push(sectorRow(chain, inputs, rows.length));
  }
  for (const theme of declared.themes) {
    rows.push(registerRow(theme, inputs, rows.length));
  }
  return rows;
}
