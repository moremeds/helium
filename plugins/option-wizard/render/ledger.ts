/**
 * What this run promises, in a form a later run can check.
 *
 * ONE commitment per settleable thing, because each settles on its own day and
 * a receipt carries ONE status. The id carries the phase as well as the day:
 * `design` and `review` run at premarket AND close, so two runs share an ET
 * date, and `render/index.ts:940-950` records what happened the last time an
 * id did not say which of the day's runs minted it.
 *
 * V0 emits the SPY direction pair and no candidate forecast. The candidate
 * numbers will come from the dedicated candidate-selection team; today's design
 * and review steps propose a different set every run, so scoring them would be
 * measuring the sampling, not the judgement.
 * @module dsh-plugin-tenant-option-wizard/render/ledger
 */
import type { CommitmentDraft, RunReport } from "@helium/core";
import type { BriefView } from "./index.js";

export function forecastCommitments(
  view: BriefView,
  phase: string,
): CommitmentDraft[] {
  const block = view.spyForecast;
  if (block === undefined || !block.scorable || block.forecast === undefined)
    return [];
  const { referenceClose, t1Down, t5Down } = block.forecast;
  return [
    { horizon: 1, p: t1Down },
    { horizon: 5, p: t5Down },
  ].map(({ horizon, p }) => ({
    id: `${view.date}-${phase}-spy-t${String(horizon)}`,
    payload: {
      kind: "spy-direction",
      evaluator: "evaluator-v0",
      horizonBars: horizon,
      symbol: "SPY",
      referenceClose,
      pDown: p,
    },
  }));
}

/** The three fields an argon signal would need to be scorable beside ours. */
const ARGON_FIELDS = ["confidence", "expectedReturn20d", "signal"] as const;

/**
 * The trivial predictors this run has to beat.
 *
 * `neutral` and `uniform` are scorable today, so the Briers have a floor from
 * day one. `argon` is raw and unscored, and it carries `dataDate` VERBATIM: a
 * signal computed three sessions ago must never be counted as today's forecast.
 * No `med = 0.6` invention — a calibration map is evaluator-v1, once real
 * (signal, outcome) pairs exist.
 */
export function baselineDraft(
  view: BriefView,
  report: RunReport,
  phase: string,
): CommitmentDraft {
  const argon = argonBaseline(report);
  return {
    id: `${view.date}-${phase}-baseline`,
    payload: {
      evaluator: "evaluator-v0",
      neutral: { t1Down: 0.5, t5Down: 0.5 },
      uniform: view.candidates.map((candidate) => ({
        candidateId: candidate.id,
        pTrigger: 0.5,
        givenTrigger: {
          targetFirst: 1 / 3,
          invalidationFirst: 1 / 3,
          unresolved: 1 / 3,
        },
      })),
      ...(argon === undefined ? {} : { argon }),
    },
  };
}

/**
 * The argon row for SPY, as `ow_argon_metrics` answered it.
 *
 * Verified against the live response 2026-09-06: the envelope is
 * `{source, queriedAsOf?, dataDate?, dataDates?, rows:[{ticker, iv, gex, skew}]}`
 * and the `iv` row is `{close, ticker, iv_rank_1y, volatility, market_date}` —
 * the real SPY row observed that day was
 * `{close 770.19, iv_rank_1y 3.5692, volatility 0.116, market_date 2026-09-04}`.
 * The top-level `dataDate` is preferred because that is where the tool now
 * puts the row vintage (PR #92); `iv.market_date` is the fallback for a
 * payload written before it. There is no `signal`, `expectedReturn20d` or
 * `confidence` on this table, so the field NAMES the gap rather than filling
 * it: a baseline that quietly has no signal in it reads like a baseline nobody
 * could beat.
 */
function argonBaseline(report: RunReport): Record<string, unknown> | undefined {
  for (const output of report.steps.flatMap((step) => step.toolOutputs ?? [])) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      continue;
    }
    const envelope = parsed as {
      source?: unknown;
      dataDate?: unknown;
      rows?: unknown;
    };
    if (envelope.source !== "argon.uw_scan" || !Array.isArray(envelope.rows))
      continue;
    const row = envelope.rows.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { ticker?: unknown }).ticker === "SPY",
    ) as Record<string, unknown> | undefined;
    if (row === undefined) continue;
    const iv = (row.iv ?? {}) as Record<string, unknown>;
    const dataDate =
      typeof envelope.dataDate === "string"
        ? envelope.dataDate
        : typeof row.dataDate === "string"
          ? row.dataDate
          : typeof iv.market_date === "string"
            ? iv.market_date
            : undefined;
    if (dataDate === undefined) continue;
    const present: Record<string, unknown> = { dataDate };
    const missing: string[] = [];
    for (const field of ARGON_FIELDS) {
      const value = row[field] ?? iv[field];
      if (value === undefined || value === null) missing.push(field);
      else present[field] = value;
    }
    if (missing.length > 0) present.missing = missing;
    return present;
  }
  return undefined;
}
