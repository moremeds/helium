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
 *
 * Section order (2026-09-03 redesign, design of record
 * `ow-premarket-2026-09-03.min.html`): masthead (headline) -> tape strip ->
 * bottom line (decision block, moved up from the bottom) -> overnight ->
 * today's schedule -> the run's own narrative sections (macro read,
 * scenarios, positioning, rates & policy path — whatever task order
 * produced) -> candidates -> risk register (compact) -> data coverage
 * (compact, pulled out of sections so it always lands last).
 * @module dsh-plugin-tenant-option-wizard/render/html
 */
import type {
  BriefView,
  CandidateView,
  ScheduleRow,
  TapeItem,
} from "./index.js";
import { payoffLabel } from "./text.js";
import {
  formatScheduleMagnitude,
  invalidationLabel,
  scheduleTimeLabel,
} from "./math.js";

const INK = "#232830";
const DIM = "#6b7484";
const RULE = "#e0e4eb";
const CARD = "#ffffff";
const PAGE = "#eef0f4";
const CHIP = "#f5f7fb";
const ACCENT = "#0f4c5c";
const GREEN = "#1a7f47";
const RED = "#b3261e";
const AMBER = "#7a5300";

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const money = (value: number | null): string =>
  value === null ? "unlimited" : `$${value.toFixed(2)}`;

/** The uppercase eyebrow label every card section opens with. */
function eyebrow(text: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT};font-weight:600;padding:16px 0 4px 0">${esc(text)}</div>`;
}

function card(inner: string, extra = ""): string {
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px${extra}"><tr><td class="pad" style="padding:14px 18px">${inner}</td></tr></table>`;
}

/** The tape strip: up to four tiles per row, whatever the regime step
 *  reported. A table cell grid, not a chart — the same primitive as the
 *  credit-vs-width bar below. */
function tapeStrip(items: TapeItem[]): string {
  if (items.length === 0) return "";
  const tile = (item: TapeItem): string => {
    const colour =
      item.positive === undefined ? DIM : item.positive ? GREEN : RED;
    const change =
      item.change === undefined || item.change.trim() === ""
        ? ""
        : ` <span style="color:${colour};font-weight:400;font-size:12px">${esc(item.change)}</span>`;
    return `<td width="25%" style="width:25%;padding:8px 6px 4px 0;border-top:1px solid ${RULE}">
      <div class="ink-dim" style="color:${DIM};font-size:11px;letter-spacing:0.06em;text-transform:uppercase">${esc(item.label)}</div>
      <div class="ink" style="color:${INK};font-size:13px;font-weight:600">${esc(item.value)}${change}</div>
    </td>`;
  };
  // Four tiles to a row.
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 4)
    rows.push(
      `<tr>${items
        .slice(i, i + 4)
        .map(tile)
        .join("")}</tr>`,
    );
  return card(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed">${rows.join("")}</table>`,
  );
}

/** "NextTrigger" -> "Next Trigger": a display-only space insert before an
 *  interior capital, so a reviewer's camelCase JSON key reads as two words
 *  instead of running together under CSS uppercasing. */
function spacedLabel(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

function bottomLine(view: BriefView): string {
  if (view.decision === undefined || view.decision.length === 0) return "";
  const rows = view.decision
    .map(
      (row) => `<tr>
        <td valign="top" width="100" style="width:100px;padding:8px 10px 8px 0;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${ACCENT};font-weight:600">${esc(spacedLabel(row.label))}</td>
        <td valign="top" class="ink" style="padding:8px 0;color:${INK};font-size:13px;line-height:1.45">${esc(row.value)}</td>
      </tr>`,
    )
    .join("");
  return card(
    `${eyebrow("Bottom line")}
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="chip" style="border-collapse:collapse;background-color:${CHIP};border-left:3px solid ${ACCENT}"><tr><td style="padding:6px 14px">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${rows}</table>
     </td></tr></table>`,
  );
}

function overnightSection(items: string[]): string {
  const body =
    items.length === 0
      ? `<div class="ink-dim" style="color:${DIM};font-size:13px">Nothing flagged overnight.</div>`
      : items
          .map(
            (item) =>
              `<div class="ink" style="color:${INK};font-size:13px;line-height:1.5;margin-bottom:6px">${esc(item)}</div>`,
          )
          .join("");
  return card(`${eyebrow("Overnight")}${body}`);
}

function scheduleSection(rows: ScheduleRow[]): string {
  if (rows.length === 0) return "";
  const head = `<tr>
    <td style="padding:0 8px 4px 0;color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">Time</td>
    <td style="padding:0 8px 4px 0;color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">Event</td>
    <td align="right" style="padding:0 0 4px 0;color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">Cons / prior</td>
  </tr>`;
  let lastGroup: string | undefined;
  const body = rows
    .map((row) => {
      const groupRow =
        row.group === undefined || row.group === lastGroup
          ? ""
          : `<tr><td colspan="3" class="ink-dim" style="padding:8px 0 2px;border-top:1px solid ${RULE};color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">${esc(row.group)}</td></tr>`;
      lastGroup = row.group;
      const when = scheduleTimeLabel(row);
      const cp = [row.consensus, row.prior]
        .filter((v): v is string => v !== undefined)
        .map(formatScheduleMagnitude)
        .join(" / ");
      return `${groupRow}<tr>
        <td valign="top" class="ink-dim" style="padding:6px 8px 6px 0;border-top:1px solid ${RULE};color:${DIM};font-size:12px;white-space:nowrap">${esc(when)}</td>
        <td valign="top" class="ink" style="padding:6px 8px 6px 0;border-top:1px solid ${RULE};color:${INK};font-size:13px">${esc(row.event)}</td>
        <td valign="top" align="right" class="ink-dim" style="padding:6px 0 6px 0;border-top:1px solid ${RULE};color:${DIM};font-size:12px">${esc(cp)}</td>
      </tr>`;
    })
    .join("");
  return card(
    `${eyebrow("Today's schedule")}
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${head}${body}</table>`,
  );
}

function badge(text: string): string {
  return `<span class="chip" style="display:inline-block;padding:2px 8px;margin:0 6px 4px 0;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${INK};font-size:12px">${esc(text)}</span>`;
}

/** The payoff row as a horizontal bar chart: one row per pnlAt point, bar
 *  width proportional to |pnl| against the largest |pnl| among the six
 *  points, coloured green for a gain and red for a loss. A table cell with
 *  a background colour is the only chart primitive every mail client
 *  renders; there is no image and no svg here. */
function payoffBars(
  pnlAt: Array<{ pct: number | null; spot: number; pnl: number }>,
): string {
  const maxAbs = Math.max(1, ...pnlAt.map((point) => Math.abs(point.pnl)));
  const rows = pnlAt
    .map((point) => {
      const gain = point.pnl >= 0;
      const trackPct = Math.max(
        2,
        Math.round((Math.abs(point.pnl) / maxAbs) * 100),
      );
      const head =
        point.pct === null
          ? point.spot.toFixed(2)
          : `${point.pct > 0 ? "+" : ""}${String(point.pct)}%`;
      return `<tr>
        <td width="34" style="width:34px;padding:3px 6px 3px 0;color:${DIM};font-size:11px;white-space:nowrap">${esc(head)}</td>
        <td style="padding:3px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="track" width="${String(trackPct)}%" style="background-color:${gain ? GREEN : RED};font-size:1px;line-height:9px;height:9px">&nbsp;</td>
            <td class="track" width="${String(100 - trackPct)}%" style="font-size:1px;line-height:9px;height:9px">&nbsp;</td>
          </tr></table>
        </td>
        <td width="52" align="right" style="width:52px;padding:3px 0 3px 6px;color:${gain ? GREEN : RED};font-size:12px;font-weight:600;white-space:nowrap">${point.pnl >= 0 ? "+" : ""}${point.pnl.toFixed(0)}</td>
      </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${rows}</table>`;
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
  const breakevens =
    pricing.breakevens.length === 0
      ? "none"
      : esc(pricing.breakevens.map((value) => value.toFixed(2)).join(" / "));
  const quoted = pricing.pnlAt[0]?.pct !== null;
  return `<div class="ink" style="margin-top:8px;font-size:13px;color:${INK}">
      ${credit ? "Net credit" : "Net debit"} <strong>$${Math.abs(pricing.net).toFixed(2)}</strong> per share ·
      max gain <strong style="color:${GREEN}">${money(pricing.maxGain)}</strong> ·
      max loss <strong style="color:${RED}">${money(pricing.maxLoss)}</strong>
    </div>
    <div class="ink-dim" style="font-size:13px;color:${DIM}">Breakeven ${breakevens} · spread width ${candidate.width.toFixed(2)}</div>
    <div class="ink-dim" style="margin-top:10px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${DIM}">${esc(payoffLabel(quoted))}</div>
    ${payoffBars(pricing.pnlAt)}
    <div class="ink-dim" style="color:${DIM};font-size:11px;margin-top:2px">per contract, no size</div>`;
}

/** The Entry / Target / Invalidation three-tile row — the level that starts
 *  the thesis, what it is aiming at, and the level that kills it, side by
 *  side rather than a stop with nothing either side of it. */
function trigger(candidate: CandidateView): string {
  const entry =
    candidate.entry === undefined ? "—" : invalidationLabel([candidate.entry]);
  const target = candidate.target === "" ? "—" : esc(candidate.target);
  const stop = esc(invalidationLabel(candidate.invalidation));
  const tile = (label: string, value: string, colour: string) =>
    `<td width="33%" class="chip" style="width:33%;padding:8px;background-color:${CHIP}">
       <div class="ink-dim" style="color:${DIM};font-size:11px;letter-spacing:0.06em;text-transform:uppercase">${label}</div>
       <div class="ink" style="color:${colour};font-size:13px;font-weight:600">${value}</div>
     </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fill" style="border-collapse:collapse;margin-top:8px">
    <tr>${tile("Entry", esc(entry), INK)}${tile("Target", target, INK)}${tile("Invalidation", stop, RED)}</tr>
  </table>`;
}

function candidateCard(candidate: CandidateView): string {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  const earnings =
    candidate.earnings === undefined ? "" : ` · earnings ${candidate.earnings}`;
  const spot =
    candidate.spot === undefined ? "" : `Spot ${candidate.spot.toFixed(2)}`;
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px">
      <tr><td class="pad" style="padding:14px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="top" class="ink" style="color:${INK};font-size:16px;font-weight:700">${esc(candidate.ticker)} <span class="ink-dim" style="color:${DIM};font-size:13px;font-weight:400">${esc(candidate.strategy)}</span></td>
          <td valign="top" align="right" class="ink-dim" style="color:${DIM};font-size:13px">Exp ${esc(candidate.expiry)}${esc(dte)}${esc(earnings)}</td>
        </tr></table>
        ${spot === "" ? "" : `<div class="ink-dim" style="color:${DIM};font-size:13px">${spot}</div>`}
        ${trigger(candidate)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ink" style="margin-top:10px;color:${INK}">
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
        ${
          candidate.unchecked === undefined
            ? ""
            : `<div class="ink-dim" style="color:${AMBER};font-size:12px;margin-top:8px">⚠ ${esc(candidate.unchecked)}</div>`
        }
        <div class="ink-dim" style="color:${DIM};font-size:13px;margin-top:8px">${esc(candidate.rationale)}</div>
        <div class="ink-dim" style="color:${DIM};font-size:10px;font-family:ui-monospace,Menlo,monospace;margin-top:6px">${esc(candidate.id)}</div>
      </td></tr>
    </table>`;
}

/** Risk register: a compact ticker/reason table, not one card per row. */
function riskRegister(riskList: BriefView["riskList"]): string {
  if (riskList.length === 0) return "";
  const head = `<tr>
    <td style="padding:0 10px 4px 0;color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">Ticker</td>
    <td style="padding:0 0 4px 0;color:${DIM};font-size:10px;letter-spacing:0.06em;text-transform:uppercase">Reason</td>
  </tr>`;
  const rows = riskList
    .map(
      (entry) => `<tr>
        <td valign="top" style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};color:${INK};font-size:13px;font-weight:600;white-space:nowrap">${esc(entry.ticker)}</td>
        <td valign="top" style="padding:6px 0 6px 0;border-top:1px solid ${RULE};color:${DIM};font-size:12px">${esc(entry.reason)}</td>
      </tr>`,
    )
    .join("");
  return card(
    `${eyebrow("Risk register")}
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${head}${rows}</table>`,
  );
}

/** The Layer Coverage block's body is the regime step's own prose, one layer
 *  per " | "-separated segment (the format `team.yaml` asks the regime step
 *  for). Splitting on that literal separator is safe regardless of wording;
 *  the ✓/skipped colour hint is a substring check on the same real text, not
 *  a parse of it. A segment that doesn't split cleanly still renders, just
 *  without the colour hint. */
function coverageRows(body: string): string {
  const segments = body
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length === 0) return "";
  const rows = segments
    .map((segment) => {
      const skipped = /skipped/iu.test(segment);
      const dash = segment.indexOf("—");
      const label = dash === -1 ? segment : segment.slice(0, dash).trim();
      const rest = dash === -1 ? "" : segment.slice(dash + 1).trim();
      // Skipped rows already start with the word "skipped" in `rest` (the
      // regime step's own prose); a mark there would repeat it, so colour
      // the whole line amber instead of prefixing a redundant symbol.
      const restHtml = skipped
        ? `<span style="color:${AMBER}">${esc(rest)}</span>`
        : `<span style="color:${GREEN}">✓</span> ${esc(rest)}`;
      return `<tr>
        <td valign="top" style="padding:5px 10px 5px 0;border-top:1px solid ${RULE};color:${INK};font-size:12px;font-weight:600;white-space:nowrap">${esc(label)}</td>
        <td valign="top" style="padding:5px 8px 5px 0;border-top:1px solid ${RULE};color:${DIM};font-size:11px">${restHtml}</td>
      </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${rows}</table>`;
}

function coverageSection(coverage: BriefView["coverage"]): string {
  if (coverage === undefined) return "";
  return card(`${eyebrow("Data coverage")}${coverageRows(coverage.body)}`);
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

  const statusBadge =
    view.outcome === "completed"
      ? ""
      : `<span class="chip" style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${outcomeColour};font-size:12px">${esc(view.outcome)}</span>`;
  const masthead = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background-color:${CARD};border:1px solid ${RULE};border-top:3px solid ${ACCENT};border-radius:10px;margin-bottom:12px"><tr><td class="pad" style="padding:16px 18px">
     <div class="ink" style="color:${ACCENT};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">${esc(view.tenant)}</div>
     ${view.headline === "" ? "" : `<div class="ink" style="color:${INK};font-size:21px;font-weight:700;line-height:1.3;padding-top:4px">${esc(view.headline)}</div>`}
     <div class="ink-dim" style="color:${DIM};font-size:13px;padding-top:6px">${esc(view.date)}${statusBadge}</div>
   </td></tr></table>`;

  const bottomLineSection = bottomLine(view);

  const body =
    view.empty !== undefined
      ? `${card(
          `${eyebrow("Candidates")}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="chip" style="border-collapse:collapse;background-color:${CHIP};border-left:3px solid ${ACCENT}"><tr><td style="padding:10px 14px">
             <div class="ink" style="color:${INK};font-size:14px;line-height:1.5">${esc(view.empty)}</div>
           </td></tr></table>`,
        )}
         ${bottomLineSection}
         ${overnightSection(view.overnight)}
         ${scheduleSection(view.schedule)}`
      : `${bottomLineSection}
         ${overnightSection(view.overnight)}
         ${scheduleSection(view.schedule)}
         ${card(
           `${view.sections
             .map(
               (section) =>
                 `<div class="ink" style="color:${INK};font-size:14px;line-height:1.55;margin-bottom:10px"><strong>${esc(section.title)}.</strong> ${esc(section.body).replace(/\n/g, "<br>")}</div>`,
             )
             .join("")}
           <div style="margin-top:8px">${stances}</div>`,
         )}
         ${
           view.candidates.length === 0
             ? ""
             : `<div class="ink-dim" style="color:${DIM};font-size:12px;margin:14px 0 8px">Candidates — per contract, no size</div>
         ${view.candidates.map(candidateCard).join("")}`
         }
         ${riskRegister(view.riskList)}
         ${coverageSection(view.coverage)}`;

  const degradationRow =
    view.degradation === undefined
      ? ""
      : `<tr><td class="pad" style="padding:12px 4px 0;color:${AMBER};font-size:12px">${esc(view.degradation)}</td></tr>`;

  const footer = `<tr><td class="pad" style="padding:16px 4px 4px">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${RULE};padding-top:10px">
       <div class="ink-dim" style="color:${DIM};font-size:11px;line-height:1.5">All structures are defined-risk. No quantities, position sizes or account information appear anywhere in this note.</div>
       <div class="ink-dim" style="color:${DIM};font-size:11px;margin-top:4px">[${esc(view.tenant)}] ${esc(view.date)}</div>
     </td></tr></table>
   </td></tr>`;

  return `<!doctype html>
<html lang="en"><head>
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
   <tr><td class="pad" style="padding:0 4px 12px">${masthead}${tapeStrip(view.tape)}</td></tr>
   <tr><td style="padding:0 4px">${body}</td></tr>
   ${degradationRow}
   ${footer}
  </table>
 </td></tr>
</table>
</body></html>`;
}
