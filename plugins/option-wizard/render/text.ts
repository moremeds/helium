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
import {
  formatScheduleMagnitude,
  invalidationLabel,
  scheduleTimeLabel,
} from "./math.js";

/**
 * The header of the payoff row, which says what its columns ARE. With a quoted
 * spot they are moves away from it; without one they are the strikes, and
 * saying so is what stops a reader reading a strike as a percentage.
 */
export function payoffLabel(quoted: boolean): string {
  return quoted
    ? "Payoff at expiry (spot ±%)"
    : "Payoff at expiry (by strike, no ow_spot quote)";
}

/** One column of the payoff row: "+10%: 320" or "750: -290". */
export function payoffCell(point: {
  pct: number | null;
  spot: number;
  pnl: number;
}): string {
  const head =
    point.pct === null
      ? point.spot.toFixed(2)
      : `${point.pct > 0 ? "+" : ""}${String(point.pct)}%`;
  return `${head}: ${point.pnl.toFixed(0)}`;
}

const money = (value: number | null): string =>
  value === null ? "unlimited" : `$${value.toFixed(2)}`;

function pricingLines(candidate: CandidateView): string[] {
  const pricing = candidate.pricing;
  if (pricing.kind !== "priced") return [`  ${pricing.reason}`];
  const flow = pricing.net >= 0 ? "Net credit" : "Net debit";
  const breakevens =
    pricing.breakevens.length === 0
      ? "none"
      : pricing.breakevens.map((value) => value.toFixed(2)).join(" / ");
  return [
    `  ${flow} $${Math.abs(pricing.net).toFixed(2)}/share`,
    `  max gain ${money(pricing.maxGain)} · max loss ${money(pricing.maxLoss)} · spread width ${candidate.width.toFixed(2)}`,
    `  breakeven ${breakevens}`,
    `  ${payoffLabel(pricing.pnlAt[0]?.pct !== null)}: ${pricing.pnlAt
      .map((point) => payoffCell(point))
      .join("  ")}`,
  ];
}

function candidateLines(candidate: CandidateView): string[] {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  const earnings =
    candidate.earnings === undefined ? "" : ` · earnings ${candidate.earnings}`;
  const spot =
    candidate.spot === undefined ? "" : ` · spot ${candidate.spot.toFixed(2)}`;
  return [
    `${candidate.ticker} — ${candidate.strategy}${dte}${spot}${earnings}`,
    `  entry ${candidate.entry === undefined ? "—" : invalidationLabel([candidate.entry])} · target ${candidate.target || "—"} · stop ${invalidationLabel(candidate.invalidation)}`,
    ...candidate.legs.map(
      (leg) =>
        `  ${leg.action} ${leg.right} ${String(leg.strike)} ${leg.expiry}` +
        (leg.mid === undefined ? " mid —" : ` mid ${leg.mid.toFixed(2)}`),
    ),
    ...pricingLines(candidate),
    ...(candidate.unchecked === undefined
      ? []
      : [`  ⚠ ${candidate.unchecked}`]),
    `  ${candidate.rationale}`,
    `  [${candidate.id}]`,
    "",
  ];
}

/** The decision block, under its own heading. Same block, same order, in
 *  both parts — rendered near the top as "Bottom line" because it is the one
 *  block that says what to DO. */
function decisionLines(view: BriefView): string[] {
  if (view.decision === undefined || view.decision.length === 0) return [];
  return [
    "【Bottom line】",
    ...view.decision.map((row) => `- ${row.label}: ${row.value}`),
    "",
  ];
}

function tapeLine(view: BriefView): string[] {
  if (view.tape.length === 0) return [];
  return [
    view.tape
      .map(
        (item) =>
          `${item.label} ${item.value}${
            item.change === undefined || item.change.trim() === ""
              ? ""
              : ` (${item.change})`
          }`,
      )
      .join(" | "),
    "",
  ];
}

function overnightLines(view: BriefView): string[] {
  const lines = ["【Overnight】"];
  if (view.overnight.length === 0) {
    lines.push("Nothing flagged overnight.");
  } else {
    for (const item of view.overnight) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines;
}

function scheduleLines(view: BriefView): string[] {
  if (view.schedule.length === 0) return [];
  const lines = ["【Today's schedule】"];
  for (const row of view.schedule) {
    const when = scheduleTimeLabel(row);
    const cp = [row.consensus, row.prior]
      .filter((entry): entry is string => entry !== undefined)
      .map(formatScheduleMagnitude)
      .join(" / ");
    lines.push(
      `- ${when === "" ? "" : `${when} `}${row.event}${cp === "" ? "" : ` (${cp})`}`,
    );
  }
  lines.push("");
  return lines;
}

export function renderText(view: BriefView): string {
  const lines: string[] = [
    view.headline === "" ? view.tenant : view.headline,
    `${view.date} — ${view.tenant} [${view.outcome}]`,
    "",
  ];
  lines.push(...tapeLine(view));
  lines.push(...decisionLines(view));
  lines.push(...overnightLines(view));
  lines.push(...scheduleLines(view));
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
    lines.push("【Candidates】per contract, no size", "");
    for (const candidate of view.candidates)
      lines.push(...candidateLines(candidate));
  }
  if (view.riskList.length > 0) {
    lines.push("【Risk register】");
    for (const entry of view.riskList)
      lines.push(`- ${entry.ticker}: ${entry.reason}`);
    lines.push("");
  }
  if (view.coverage !== undefined)
    lines.push(`【${view.coverage.title}】`, view.coverage.body, "");
  if (view.degradation !== undefined) lines.push(view.degradation, "");
  return lines.join("\n");
}
