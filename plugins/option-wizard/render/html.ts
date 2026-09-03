/**
 * The email's HTML part: one template literal, table layout, inline styles.
 *
 * Every constraint below was checked against caniemail.com data on 2026-09-02,
 * not remembered:
 *  - data-URI images have `src` rewritten to `nosrc` by all four Gmail
 *    channels, and inline <svg> is deleted WITH its fallback content. So there
 *    is no image and no svg here at all; the one chart is a table cell with a
 *    background colour and a percentage width.
 *  - `prefers-color-scheme` is unsupported across Gmail web/iOS/Android, so
 *    dark mode is three layers: mid-tone inline colours that survive Gmail's
 *    own inversion, the media query for Apple Mail, and `[data-ogsc]` /
 *    `[data-ogsb]` attribute selectors for Outlook.com.
 *  - `rem` is unsupported in Yahoo, `box-shadow` in Gmail web, `position`
 *    everywhere in Gmail. All sizes are px and cards use a 1px border.
 *  - The breakpoint is 359px, not 420px: an iPhone 15 is 390pt, and a 420px
 *    breakpoint stacked every multi-column row on the device the reader uses.
 * @module dsh-plugin-tenant-option-wizard/render/html
 */
import type { BriefView, CandidateView } from "./index.js";
import { payoffCell, payoffLabel } from "./text.js";

const INK = "#232830";
const DIM = "#6b7484";
const RULE = "#e0e4eb";
const CARD = "#ffffff";
const PAGE = "#eef0f4";
const CHIP = "#f5f7fb";
const GREEN = "#1a7f47";
const RED = "#b3261e";
const AMBER = "#7a5300";
const SLATE = "#5a6376";

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const money = (value: number | null): string =>
  value === null ? "无上限" : `$${value.toFixed(2)}`;

function badge(text: string): string {
  return `<span class="chip" style="display:inline-block;padding:2px 8px;margin:0 6px 4px 0;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${INK};font-size:12px">${esc(text)}</span>`;
}

/** The credit-vs-width bar. A table cell with a background colour is the only
 *  chart primitive every mail client renders; there is no image to block. */
function bar(fraction: number, credit: boolean): string {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const fill = credit ? GREEN : SLATE;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0"><tr>
    <td class="track" width="${String(pct)}%" style="background-color:${fill};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
    <td class="track" width="${String(100 - pct)}%" style="background-color:${RULE};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
  </tr></table>
  <div class="ink-dim" style="color:${DIM};font-size:12px">净权利金 / 价差宽度 = ${String(pct)}%</div>`;
}

function legRows(candidate: CandidateView): string {
  return candidate.legs
    .map(
      (leg) => `<tr>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};color:${leg.action === "buy" ? GREEN : RED};font-size:13px">${esc(leg.action)}</td>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${esc(leg.right)}</td>
        <td align="right" style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${leg.strike.toFixed(2)}</td>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${esc(leg.expiry)}</td>
        <td align="right" style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${leg.mid === undefined ? "—" : leg.mid.toFixed(2)}</td>
      </tr>`,
    )
    .join("");
}

function pricingBlock(candidate: CandidateView): string {
  const pricing = candidate.pricing;
  if (pricing.kind !== "priced") {
    const colour = pricing.kind === "invalid" ? RED : AMBER;
    return `<div style="margin-top:8px;color:${colour};font-size:13px">${esc(pricing.reason)}</div>`;
  }
  const credit = pricing.net >= 0;
  const fraction =
    candidate.width === 0 ? 0 : Math.abs(pricing.net) / candidate.width;
  const cells = pricing.pnlAt
    .map(
      (point) => `<td align="center" style="padding:4px 2px;font-size:12px;color:${point.pnl >= 0 ? GREEN : RED}">
        <div class="ink-dim" style="color:${DIM}">${esc(payoffCell(point).split(":")[0] ?? "")}</div>
        <div>${point.pnl.toFixed(0)}</div>
      </td>`,
    )
    .join("");
  const breakevens =
    pricing.breakevens.length === 0
      ? "无"
      : esc(pricing.breakevens.map((value) => value.toFixed(2)).join(" / "));
  return `<div class="ink" style="margin-top:8px;font-size:13px;color:${INK}">
      ${credit ? "净收权利金" : "净付权利金"} <strong>$${Math.abs(pricing.net).toFixed(2)}</strong>/股 ·
      max gain <strong style="color:${GREEN}">${money(pricing.maxGain)}</strong> ·
      max loss <strong style="color:${RED}">${money(pricing.maxLoss)}</strong>
    </div>
    <div class="ink-dim" style="font-size:13px;color:${DIM}">breakeven ${breakevens}</div>
    ${bar(fraction, credit)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border-top:1px solid ${RULE}"><tr>${cells}</tr></table>
    <div class="ink-dim" style="color:${DIM};font-size:11px;margin-top:2px">${esc(payoffLabel(pricing.pnlAt[0]?.pct !== null))}，每张合约，不含数量</div>`;
}

function candidateCard(candidate: CandidateView): string {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px">
      <tr><td class="pad" style="padding:12px 15px">
        <div class="ink" style="color:${INK};font-size:16px;font-weight:700">${esc(candidate.ticker)}</div>
        <div class="ink-dim" style="color:${DIM};font-size:13px">${esc(candidate.strategy)}${esc(dte)} · horizon ${esc(candidate.horizon)}</div>
        <div class="ink-dim" style="color:${DIM};font-size:11px;font-family:ui-monospace,Menlo,monospace">${esc(candidate.id)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ink" style="margin-top:8px;color:${INK}">
          <tr>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">action</th>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">right</th>
            <th align="right" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">strike</th>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">expiry</th>
            <th align="right" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">mid</th>
          </tr>
          ${legRows(candidate)}
        </table>
        ${pricingBlock(candidate)}
        <div class="ink-dim" style="color:${DIM};font-size:13px;margin-top:8px">${esc(candidate.rationale)}</div>
      </td></tr>
    </table>`;
}

export function renderHtml(view: BriefView): string {
  const outcomeColour =
    view.outcome === "completed"
      ? GREEN
      : view.outcome === "DEGRADED"
        ? AMBER
        : RED;
  const stances = [
    view.regime.direction === undefined
      ? ""
      : badge(`direction: ${view.regime.direction}`),
    view.regime.volatility === undefined
      ? ""
      : badge(`vol: ${view.regime.volatility}`),
    view.regime.hedge === undefined ? "" : badge(`hedge: ${view.regime.hedge}`),
  ].join("");

  const riskSection =
    view.riskList.length === 0
      ? ""
      : `<div class="ink-dim" style="color:${DIM};font-size:12px;margin:14px 0 8px">【风险清单】</div>
         <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px">
           ${view.riskList
             .map(
               (entry) => `<tr><td class="pad ink" style="padding:10px 15px;border-top:1px solid ${RULE};color:${INK};font-size:13px"><strong>${esc(entry.ticker)}</strong> — ${esc(entry.reason)}</td></tr>`,
             )
             .join("")}
         </table>`;

  const body =
    view.empty !== undefined
      ? `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px">
           <tr><td class="pad ink" style="padding:15px;color:${INK};font-size:15px">${esc(view.empty)}</td></tr>
         </table>`
      : `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px">
           <tr><td class="pad" style="padding:12px 15px">
             ${view.sections
               .map(
                 (section) =>
                   `<div class="ink" style="color:${INK};font-size:14px;line-height:1.55;margin-bottom:10px"><strong>${esc(section.title)}</strong><br>${esc(section.body).replace(/\n/g, "<br>")}</div>`,
               )
               .join("")}
             <div style="margin-top:8px">${stances}</div>
           </td></tr>
         </table>
         <div class="ink-dim" style="color:${DIM};font-size:12px;margin:14px 0 8px">【候选结构】每张合约，不含数量</div>
         ${view.candidates.map(candidateCard).join("")}
         ${riskSection}`;

  const degradationRow =
    view.degradation === undefined
      ? ""
      : `<tr><td class="pad" style="padding:12px 4px 0;color:${AMBER};font-size:12px">${esc(view.degradation)}</td></tr>`;

  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(view.tenant)} ${esc(view.date)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .bg { background-color: #12151a !important; }
  .card { background-color: #1b1f27 !important; border-color: #2c3340 !important; }
  .ink { color: #e6e9ef !important; }
  .ink-dim { color: #a2abbb !important; }
  .chip { background-color: #222836 !important; border-color: #2c3340 !important; }
}
[data-ogsc] .ink { color: #e6e9ef !important; }
[data-ogsc] .ink-dim { color: #a2abbb !important; }
[data-ogsb] .card { background-color: #1b1f27 !important; }
@media only screen and (max-width: 359px) {
  .pad { padding-left: 12px !important; padding-right: 12px !important; }
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background-color:${PAGE}">
 <tr><td align="center" style="padding:16px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif">
   <tr><td class="pad" style="padding:0 4px 12px">
     <div class="ink" style="color:${INK};font-size:20px;font-weight:700">${esc(view.tenant)}</div>
     <div class="ink-dim" style="color:${DIM};font-size:13px">${esc(view.date)}
       <span class="chip" style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${outcomeColour};font-size:12px">${esc(view.outcome)}</span>
     </div>
   </td></tr>
   <tr><td style="padding:0 4px">${body}</td></tr>
   ${degradationRow}
  </table>
 </td></tr>
</table>
</body></html>`;
}
