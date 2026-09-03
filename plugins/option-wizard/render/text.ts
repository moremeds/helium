/**
 * The email's plain-text part. Same sections as the html, in the same order.
 *
 * It is not a fallback nobody reads: a text/plain alternative is what keeps the
 * message scoring like mail rather than like a flyer, and it is what a text
 * client shows. The markdown channel keeps writing the generic transcript, so
 * this file is never the durable record.
 * @module dsh-plugin-tenant-option-wizard/render/text
 */
import type { BriefView, CandidateView } from "./index.js";
import { invalidationLabel } from "./math.js";

/**
 * The header of the payoff row, which says what its columns ARE. With a quoted
 * spot they are moves away from it; without one they are the strikes, and
 * saying so is what stops a reader reading a strike as a percentage.
 */
export function payoffLabel(quoted: boolean): string {
  return quoted ? "到期损益（spot ±%）" : "到期损益（按行权价，reviewer 未报 spot）";
}

/** One column of the payoff row: "+10%: 320" or "750: -290". */
export function payoffCell(point: { pct: number | null; spot: number; pnl: number }): string {
  const head =
    point.pct === null
      ? point.spot.toFixed(2)
      : `${point.pct > 0 ? "+" : ""}${String(point.pct)}%`;
  return `${head}: ${point.pnl.toFixed(0)}`;
}

const money = (value: number | null): string =>
  value === null ? "无上限" : `$${value.toFixed(2)}`;

function pricingLines(candidate: CandidateView): string[] {
  const pricing = candidate.pricing;
  if (pricing.kind !== "priced") return [`  ${pricing.reason}`];
  const flow = pricing.net >= 0 ? "净收权利金" : "净付权利金";
  const breakevens =
    pricing.breakevens.length === 0
      ? "无"
      : pricing.breakevens.map((value) => value.toFixed(2)).join(" / ");
  return [
    `  ${flow} $${Math.abs(pricing.net).toFixed(2)}/股`,
    `  max gain ${money(pricing.maxGain)} · max loss ${money(pricing.maxLoss)}`,
    `  breakeven ${breakevens}`,
    `  ${payoffLabel(pricing.pnlAt[0]?.pct !== null)}${pricing.pnlAt
      .map((point) => payoffCell(point))
      .join("  ")}`,
  ];
}

function candidateLines(candidate: CandidateView): string[] {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  const earnings =
    candidate.earnings === undefined ? "" : ` · 财报 ${candidate.earnings}`;
  return [
    `[${candidate.id}] ${candidate.ticker} — ${candidate.strategy}${dte} · 失效 ${invalidationLabel(candidate.invalidation)}${earnings}`,
    ...candidate.legs.map(
      (leg) =>
        `  ${leg.action} ${leg.right} ${String(leg.strike)} ${leg.expiry}` +
        (leg.mid === undefined ? " mid —" : ` mid ${leg.mid.toFixed(2)}`),
    ),
    ...pricingLines(candidate),
    `  ${candidate.rationale}`,
    "",
  ];
}

export function renderText(view: BriefView): string {
  const lines: string[] = [
    `${view.date} — ${view.tenant} [${view.outcome}]`,
    "",
  ];
  if (view.empty !== undefined) {
    lines.push(view.empty, "");
    if (view.degradation !== undefined) lines.push(view.degradation, "");
    return lines.join("\n");
  }
  for (const section of view.sections)
    lines.push(`【${section.title}】`, section.body, "");
  const stances = [
    view.regime.direction === undefined
      ? null
      : `direction: ${view.regime.direction}`,
    view.regime.volatility === undefined
      ? null
      : `volatility: ${view.regime.volatility}`,
    view.regime.hedge === undefined ? null : `hedge: ${view.regime.hedge}`,
  ].filter((entry): entry is string => entry !== null);
  if (stances.length > 0) lines.push(stances.join(" | "), "");
  // No header without rows under it. An intraday brief has no candidates by
  // design, and a failed run's are withheld; a bare heading reads as content
  // that got lost on the way.
  if (view.candidates.length > 0) {
    lines.push("【候选结构】每张合约，不含数量", "");
    for (const candidate of view.candidates)
      lines.push(...candidateLines(candidate));
  }
  if (view.riskList.length > 0) {
    lines.push("【风险清单】");
    for (const entry of view.riskList)
      lines.push(`- ${entry.ticker}: ${entry.reason}`);
    lines.push("");
  }
  if (view.degradation !== undefined) lines.push(view.degradation, "");
  return lines.join("\n");
}
