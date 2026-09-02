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

/** Says what the +/-% row is measured from, because it is not always the spot. */
export function anchorLabel(candidate: CandidateView): string {
  return candidate.anchor.quoted
    ? `基准 spot ${candidate.anchor.price.toFixed(2)}`
    : `基准 ${candidate.anchor.price.toFixed(2)}，reviewer 未报 spot`;
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
    `  到期损益（${anchorLabel(candidate)}）${pricing.pnlAt
      .map(
        (point) =>
          `${point.pct > 0 ? "+" : ""}${String(point.pct)}%: ${point.pnl.toFixed(0)}`,
      )
      .join("  ")}`,
  ];
}

function candidateLines(candidate: CandidateView): string[] {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  return [
    `${candidate.ticker} — ${candidate.strategy}${dte}`,
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
    `${view.dateHkt} / ${view.dateEt} — ${view.tenant} [${view.outcome}]`,
    "",
  ];
  if (view.empty !== undefined) {
    lines.push(view.empty, "");
    if (view.degradation !== undefined) lines.push(view.degradation, "");
    return lines.join("\n");
  }
  lines.push("【今日 regime】", view.regime.paragraph, "");
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
  lines.push("【候选结构】每张合约，不含数量", "");
  for (const candidate of view.candidates)
    lines.push(...candidateLines(candidate));
  if (view.riskList.length > 0) {
    lines.push("【风险清单】");
    for (const entry of view.riskList)
      lines.push(`- ${entry.ticker}: ${entry.reason}`);
    lines.push("");
  }
  if (view.degradation !== undefined) lines.push(view.degradation, "");
  return lines.join("\n");
}
