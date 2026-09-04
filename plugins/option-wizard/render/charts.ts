/**
 * Charts, drawn from the run's RAW TOOL OUTPUTS and from nothing else.
 *
 * The distinction is the whole module. Every other structured field in the
 * brief — the tape strip, the schedule, the sections — is a model's
 * transcription of a tool result, and 8 of 11 such numbers audited across the
 * 2026-09-02 and 09-03 runs were wrong. A chart is worse than a paragraph when
 * it is wrong, because a reader checks a chart less. So these three read the
 * tool payloads the runner already carries on `report.steps[].toolOutputs` and
 * never look at a model step at all.
 *
 * Each payload is identified by SHAPE, the same convention `toolPayloads`'
 * other readers use (`ledgerIds` looks for `reports[].candidates[].id`), so a
 * renamed tool does not silently blank a chart.
 *
 * A chart whose tool did not answer is OMITTED. There is no placeholder, no
 * zeroed bar and no "data unavailable" axis: an empty yield curve reads as a
 * flat curve, which is a claim about the market rather than about the run.
 * @module dsh-plugin-tenant-option-wizard/render/charts
 */

/** One tenor on the curve, as TradingView quoted it through `ow_macro_rates`. */
export interface CurvePoint {
  label: string;
  value: number;
  /** Signed change as the tool returned it, e.g. "+0.8". Absent when it did not. */
  change?: number;
}

export interface YieldCurveChart {
  points: CurvePoint[];
  /** Where the bars start. NOT zero: a 4.375 and a 4.788 differ by 9% of
   *  their own size and by 100% of what anyone trades, and a zero-based axis
   *  draws them as the same bar. Printed on the chart so the reader knows. */
  baseline: number;
  /** 2s10s in bp, as `ow_macro_rates` subtracted it. Never recomputed here. */
  spread2s10s?: number;
}

export interface PolicyMeeting {
  label: string;
  stance?: string;
  /** Percent, 0-100, as argon's scanner stored it. */
  probability: number;
  impliedRate?: string;
  targetRange?: string;
}

export interface PolicyPathChart {
  snapshotDate?: string;
  meetings: PolicyMeeting[];
}

export interface GexLevel {
  label: string;
  role?: string;
  strike: number;
  /** Dealer gamma at this strike. Signed: a negative wall is a real thing. */
  gamma: number;
}

export interface GexProfileChart {
  ticker: string;
  spot?: number;
  asOf?: string;
  levels: GexLevel[];
}

export interface Charts {
  yieldCurve?: YieldCurveChart;
  policyPath?: PolicyPathChart;
  /** One per candidate ticker argon actually answered for. */
  gex: GexProfileChart[];
}

/** The four tenors, in curve order. `ow_macro_rates` labels its live quotes
 *  `2y` / `5y` / `10y` / `30y` (TV_LIVE's own `label`), and a tenor the tool
 *  did not quote is dropped rather than interpolated. */
const TENORS = ["2y", "5y", "10y", "30y"] as const;

function num(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The live curve out of `ow_macro_rates`' `liveNow` overlay.
 *
 * `series` (argon's daily mirror) is deliberately NOT the source: it lags by
 * days, `staleSeries` exists to say by how much, and a chart cannot carry that
 * caveat legibly. `liveNow` is either present with quotes or absent with a
 * reason, and the absent case draws nothing.
 */
function yieldCurveFrom(
  payloads: readonly Record<string, unknown>[],
): YieldCurveChart | undefined {
  for (const payload of [...payloads].reverse()) {
    const live = payload.liveNow;
    if (live === null || typeof live !== "object") continue;
    const quotes = (live as Record<string, unknown>).quotes;
    if (!Array.isArray(quotes)) continue;
    const points: CurvePoint[] = [];
    for (const label of TENORS) {
      const row = quotes.find(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).name === label,
      ) as Record<string, unknown> | undefined;
      const value = num(row?.last);
      if (value === undefined) continue;
      const change = num(row?.changeAbs);
      points.push({
        label,
        value,
        ...(change === undefined ? {} : { change }),
      });
    }
    // Two points are a line, one point is a bar chart of one thing. Below two
    // there is no curve to show and the tape strip already carries the level.
    if (points.length < 2) continue;
    const min = Math.min(...points.map((point) => point.value));
    const spread = (live as Record<string, unknown>).spreads;
    const spread2s10s =
      spread === null || typeof spread !== "object"
        ? undefined
        : num((spread as Record<string, unknown>)["2s10s"]);
    return {
      points,
      // Half a point below the lowest tenor, rounded down: the shape of the
      // curve is the message and a zero-based axis destroys it.
      baseline: Math.floor(min * 2) / 2,
      ...(spread2s10s === undefined ? {} : { spread2s10s }),
    };
  }
  return undefined;
}

/** `ow_argon_policy_path`: `{snapshotDate, meetings:[{meeting_date, payload}]}`
 *  where the payload carries the scanner's own label, stance and probability. */
function policyPathFrom(
  payloads: readonly Record<string, unknown>[],
): PolicyPathChart | undefined {
  for (const payload of [...payloads].reverse()) {
    if (!Array.isArray(payload.meetings)) continue;
    const meetings: PolicyMeeting[] = [];
    for (const entry of payload.meetings) {
      if (entry === null || typeof entry !== "object") continue;
      const row = (entry as Record<string, unknown>).payload;
      if (row === null || typeof row !== "object") continue;
      const body = row as Record<string, unknown>;
      const probability = num(body.probability);
      const label =
        typeof body.label === "string"
          ? body.label
          : typeof (entry as Record<string, unknown>).meeting_date === "string"
            ? String((entry as Record<string, unknown>).meeting_date)
            : undefined;
      if (probability === undefined || label === undefined) continue;
      meetings.push({
        label,
        probability,
        ...(typeof body.stance === "string" ? { stance: body.stance } : {}),
        ...(typeof body.implied_rate === "string"
          ? { impliedRate: body.implied_rate }
          : {}),
        ...(typeof body.target_range === "string"
          ? { targetRange: body.target_range }
          : {}),
      });
    }
    if (meetings.length === 0) continue;
    const snapshotDate = payload.snapshotDate;
    return {
      meetings,
      ...(typeof snapshotDate === "string" ? { snapshotDate } : {}),
    };
  }
  return undefined;
}

/**
 * `ow_argon_levels`' per-ticker `closest_levels` — the only per-strike gamma
 * MAGNITUDE any tool in this tenant returns. `ow_uw_gex` names the same walls
 * but carries one aggregate spot-gamma number and no per-strike series, so it
 * cannot be profiled; it is not read here.
 *
 * Restricted to the tickers the brief actually shows a card for. A profile for
 * a ticker with no candidate is a chart the reader has no decision to make
 * about, and the Gmail clip limit is real.
 */
function gexFrom(
  payloads: readonly Record<string, unknown>[],
  tickers: readonly string[],
): GexProfileChart[] {
  const wanted = new Set(tickers);
  const byTicker = new Map<string, GexProfileChart>();
  for (const payload of payloads) {
    if (!Array.isArray(payload.levels)) continue;
    for (const entry of payload.levels) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.ticker !== "string" || !wanted.has(row.ticker)) continue;
      if (!Array.isArray(row.closest_levels)) continue;
      const levels: GexLevel[] = [];
      for (const raw of row.closest_levels) {
        if (raw === null || typeof raw !== "object") continue;
        const level = raw as Record<string, unknown>;
        const strike = num(level.strike);
        const gamma = num(level.gamma);
        if (strike === undefined || gamma === undefined) continue;
        levels.push({
          label: typeof level.label === "string" ? level.label : "level",
          strike,
          gamma,
          ...(typeof level.role === "string" ? { role: level.role } : {}),
        });
      }
      if (levels.length === 0) continue;
      const spotRaw = row.spot;
      const spot =
        spotRaw !== null && typeof spotRaw === "object"
          ? num((spotRaw as Record<string, unknown>).value)
          : num(spotRaw);
      byTicker.set(row.ticker, {
        ticker: row.ticker,
        // Strike order, high to low, so the ladder reads like a chain.
        levels: levels.sort((a, b) => b.strike - a.strike),
        ...(spot === undefined ? {} : { spot }),
        ...(typeof row.as_of === "string" ? { asOf: row.as_of } : {}),
      });
    }
  }
  // Candidate order, not payload order: the cards are read top to bottom.
  return tickers.flatMap((ticker) => {
    const chart = byTicker.get(ticker);
    return chart === undefined ? [] : [chart];
  });
}

export function chartsFrom(
  payloads: readonly Record<string, unknown>[],
  tickers: readonly string[],
): Charts {
  const yieldCurve = yieldCurveFrom(payloads);
  const policyPath = policyPathFrom(payloads);
  return {
    ...(yieldCurve === undefined ? {} : { yieldCurve }),
    ...(policyPath === undefined ? {} : { policyPath }),
    gex: gexFrom(payloads, tickers),
  };
}
