/**
 * The email's plain-text part. Same sections as the html, in the same order.
 *
 * It is not a fallback nobody reads: a text/plain alternative is what keeps the
 * message scoring like mail rather than like a flyer, and it is what a text
 * client shows. The markdown channel keeps writing the generic transcript, so
 * this file is never the durable record.
 *
 * ABRIDGED (2026-09-05), the same four blocks the html keeps: the tape, the
 * headline, the decision block and one line per candidate, then the Flash
 * link. Everything else the run produced is in the document argon renders.
 * @module dsh-plugin-tenant-option-wizard/render/text
 */
import type { BriefView, CandidateView } from "./index.js";
import { invalidationLabel } from "./math.js";
import { flashUrl } from "./week.js";

const money = (value: number | null): string =>
  value === null ? "unlimited" : `$${value.toFixed(2)}`;

/** One candidate, one block: what it is, what it costs, what it can lose, and
 *  the level that kills it. The rationale, the breakevens and the payoff row
 *  moved to the Flash page with the rest of the brief. */
function candidateLines(candidate: CandidateView): string[] {
  const pricing = candidate.pricing;
  const priced = pricing.kind === "priced";
  const flow = priced
    ? `${pricing.net >= 0 ? "net credit" : "net debit"} $${Math.abs(pricing.net).toFixed(2)}/share · max loss ${money(pricing.maxLoss)}/contract`
    : pricing.reason;
  return [
    `${candidate.ticker} — ${candidate.strategy} · exp ${candidate.expiry}`,
    `  ${candidate.legs
      .map(
        (leg) =>
          `${leg.action} ${leg.right} ${String(leg.strike)}` +
          (leg.mid === undefined ? "" : ` @ ${leg.mid.toFixed(2)}`),
      )
      .join(" / ")}`,
    `  ${flow}`,
    `  invalidation ${invalidationLabel(candidate.invalidation)}`,
    ...(candidate.unchecked === undefined
      ? []
      : [`  ⚠ ${candidate.unchecked}`]),
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

/** The one line that says where the rest of the brief is. Absent when
 *  `ARGON_APP_BASE` is unset — see `flashLink` in html.ts. */
function flashLine(view: BriefView): string[] {
  const href = flashUrl(view.appBase ?? "", view.date, view.runLabel ?? "");
  return href === "" ? [] : [`Full brief: ${href}`, ""];
}

export function renderText(view: BriefView): string {
  const lines: string[] = [
    view.headline === "" ? view.tenant : view.headline,
    `${view.date} — ${view.tenant} [${view.outcome}]`,
    "",
  ];
  lines.push(...tapeLine(view));
  lines.push(...decisionLines(view));
  if (view.empty !== undefined) {
    lines.push(view.empty, "");
    lines.push(...flashLine(view));
    if (view.degradation !== undefined) lines.push(view.degradation, "");
    return lines.join("\n");
  }
  // No header without rows under it. An intraday brief has no candidates by
  // design, and a failed run's are withheld; a bare heading reads as content
  // that got lost on the way.
  if (view.candidates.length > 0) {
    lines.push("【Candidates】per contract, no size", "");
    for (const candidate of view.candidates)
      lines.push(...candidateLines(candidate));
  }
  lines.push(...flashLine(view));
  if (view.degradation !== undefined) lines.push(view.degradation, "");
  return lines.join("\n");
}
