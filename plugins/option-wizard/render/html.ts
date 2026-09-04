/**
 * The email's HTML part: one template literal, table layout, inline styles.
 *
 * Every constraint below was checked against caniemail.com data on 2026-09-02,
 * not remembered:
 *  - data-URI images have `src` rewritten to `nosrc` by all four Gmail
 *    channels, and inline <svg> is deleted WITH its fallback content. So there
 *    is no image and no svg here at all; every chart is a table cell with a
 *    background colour and a percentage width or a pixel height.
 *  - `prefers-color-scheme` is unsupported across Gmail web/iOS/Android, so
 *    dark mode is three layers: mid-tone inline colours that survive Gmail's
 *    own inversion, the media query for Apple Mail, and `[data-ogsc]` /
 *    `[data-ogsb]` attribute selectors for Outlook.com.
 *  - `rem` is unsupported in Yahoo, `box-shadow` in Gmail web, `position`
 *    everywhere in Gmail. All sizes are px and the sheet uses a 1px border.
 *  - The breakpoint is 359px, not 420px: an iPhone 15 is 390pt, and a 420px
 *    breakpoint stacked every multi-column row on the device the reader uses.
 *  - No web fonts: Gmail strips @font-face. Everything is the system sans
 *    stack, which is what Design 04 asks for anyway.
 *
 * DESIGN 04 — MINIMAL WHITE / QUANT RESEARCH (2026-09-04). The design of
 * record is `docs/design/design-spec-2026-09-04.md`, which replaced the warm
 * Morandi sheet this file used to draw. White canvas, 640px, 32px padding,
 * hierarchy from whitespace and type weight rather than from rules, fills and
 * cards. One accent (#1769E0) that is an accent, not the identity of every
 * component; green and red only ever colour a number or a bar, never a box.
 *
 * Section order (the spec's fixed daily structure, mapped onto the sections
 * this tenant actually has data for): header -> market snapshot (tape) ->
 * today in one sentence (the run's headline) -> bottom line (decision block)
 * -> overnight -> today's schedule -> the run's own narrative sections ->
 * rates & policy path -> candidates -> gamma profile -> risk register -> data
 * coverage -> footer. The spec's Movers and Watchlist modules have no data
 * behind them in this tenant and are not invented.
 * @module dsh-plugin-tenant-option-wizard/render/html
 */
import type {
  BriefView,
  CandidateView,
  ScheduleRow,
  TapeItem,
} from "./index.js";
import type { Priced } from "./math.js";
import {
  formatScheduleMagnitude,
  invalidationLabel,
  payoffAt,
  scheduleTimeLabel,
} from "./math.js";

/**
 * Design 04's tokens, verbatim from the spec. Blue is an accent; the two
 * semantic colours are spent on numbers and bars and on nothing else.
 */
const INK = "#111318";
const DIM = "#626A75";
const MUTED = "#9198A2";
const PAPER = "#FFFFFF";
const BORDER = "#E8EBEF";
const BORDER_STRONG = "#D7DCE2";
const ACCENT = "#1769E0";
const ACCENT_SOFT = "#EFF6FF";
const POS = "#168A54";
const NEG = "#D54141";
/** The unfilled half of a bar. The spec's chart grid colour. */
const GRID = "#EEF0F3";
/** Caution. The negative token, never an amber: an amber note in a financial
 *  mail is a Bloomberg quotation, and the brief forbids it. */
const WARN = NEG;

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif";

/** Tabular numerals, set ONCE on the wrapper and inherited. `font-variant-numeric`
 *  is an inherited property, so repeating it on every numeric cell only bought
 *  bytes: at five candidates it cost ~9KB of the 90KB Gmail-clip budget. */
const NUM = "font-variant-numeric:tabular-nums";
/** The small uppercase label used for every column head and tile caption. */
const LBL = `font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED}`;

const money = (value: number | null): string =>
  value === null ? "unlimited" : `$${value.toFixed(2)}`;

/**
 * A section heading. Design 04: 13px / 650, near-black, no rule, no bar, no
 * filled header — the 30px of whitespace above it is what separates sections.
 */
function eyebrow(text: string): string {
  return `<div class="ink" style="color:${INK};font-size:13px;font-weight:650;letter-spacing:-0.1px;margin-bottom:12px">${esc(text)}</div>`;
}

/** One section of the page: a table row, separated from the next by
 *  whitespace. The 09-03 build drew a hairline above every section; the spec
 *  asks for 32-40px of air instead, and air is what makes a white page read as
 *  a research note rather than as a form. */
function section(inner: string): string {
  return inner === ""
    ? ""
    : `<tr><td class="pad" style="padding:0 32px 30px">${inner}</td></tr>`;
}

/** A full-width hairline, as its own row. */
function hairline(): string {
  return `<tr><td class="pad" style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid ${BORDER};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>`;
}

/**
 * A tape value split from its source annotation.
 *
 * The regime step writes the provenance INTO the value —
 * `4.79% (DGS10, 2026-09-01, ~2d behind)` — and that is right: a rate quoted
 * two days behind is a different fact from a live one, so the annotation must
 * survive. Setting all of it as the value is what was wrong: it wrapped to
 * three bold lines and blew the cell's height.
 *
 * So the renderer splits, and only on a TRAILING parenthetical — the number
 * stays the number, the provenance becomes a quiet second line. Nothing is
 * dropped and no data changes; a value with no trailing `(...)` is untouched.
 */
function splitTapeValue(value: string): { value: string; note?: string } {
  const trimmed = value.trim();
  if (!trimmed.endsWith(")")) return { value: trimmed };
  const open = trimmed.lastIndexOf("(");
  // A leading "(" is not an annotation on anything, and an empty "()" is not
  // an annotation at all.
  if (open <= 0) return { value: trimmed };
  const head = trimmed.slice(0, open).trim();
  const note = trimmed.slice(open + 1, -1).trim();
  return head === "" || note === ""
    ? { value: trimmed }
    : { value: head, note };
}

/** Market snapshot: small outlined cells, three to a row, label small / value
 *  large / change coloured. The spec's five-cell strip, widened to however
 *  many levels the regime step actually reported. */
function tapeStrip(items: TapeItem[]): string {
  if (items.length === 0) return "";
  const cell = (item: TapeItem): string => {
    const split = splitTapeValue(item.value);
    const note =
      split.note === undefined
        ? ""
        : `<div class="ink-dim" style="color:${MUTED};font-size:10px;line-height:1.35;padding-top:3px">${esc(split.note)}</div>`;
    const change =
      item.change === undefined || item.change.trim() === ""
        ? ""
        : `<span class="${item.positive === undefined ? "ink-dim" : item.positive ? "pos" : "neg"}" style="color:${
            item.positive === undefined ? MUTED : item.positive ? POS : NEG
          };font-weight:600;font-size:11px"> ${esc(item.change)}</span>`;
    return `<td width="33%" valign="top" style="width:33.33%;padding:0 8px 8px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" height="100%" class="card" style="height:100%;border-collapse:separate;background-color:${PAPER};border:1px solid ${BORDER};border-radius:7px"><tr><td valign="top" style="padding:9px 11px">
        <div class="ink-dim" style="${LBL};white-space:nowrap">${esc(item.label)}</div>
        <div class="ink" style="color:${INK};font-size:18px;font-weight:650;padding-top:3px">${esc(split.value)}${change}</div>
        ${note}
      </td></tr></table>
    </td>`;
  };
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 3) {
    const slice = items.slice(i, i + 3);
    const fill = '<td width="33%" style="width:33.33%">&nbsp;</td>'.repeat(
      3 - slice.length,
    );
    rows.push(`<tr>${slice.map(cell).join("")}${fill}</tr>`);
  }
  return section(
    `${eyebrow("Market snapshot")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed">${rows.join("")}</table>`,
  );
}

/** The run's one-sentence call. It used to be the masthead headline set in
 *  23px serif, which made a 40-word sentence the loudest object on the page;
 *  the spec gives the header a fixed title and puts the day's sentence here,
 *  right under the numbers it is about. */
function oneSentence(headline: string): string {
  if (headline === "") return "";
  return section(
    `${eyebrow("Today in one sentence")}<div class="ink" style="color:${INK};font-size:15px;line-height:1.55">${esc(headline)}</div>`,
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
        <td valign="top" width="92" class="ink-dim" style="width:92px;padding:8px 12px 8px 0;${LBL};font-weight:600">${esc(spacedLabel(row.label))}</td>
        <td valign="top" class="ink" style="padding:8px 0;color:${INK};font-size:13px;line-height:1.55">${esc(row.value)}</td>
      </tr>`,
    )
    .join("");
  return section(
    `${eyebrow("Bottom line")}
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="chip" style="border-collapse:separate;background-color:${ACCENT_SOFT};border:1px solid ${BORDER};border-radius:7px"><tr><td style="padding:6px 16px">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${rows}</table>
     </td></tr></table>`,
  );
}

/** The spec's Key Points marker: a small outlined blue circle, not a bullet
 *  glyph and not an icon. */
const DOT = `<td width="16" valign="top" style="width:16px;padding:6px 10px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="6" style="width:6px;height:6px;line-height:6px;font-size:1px;border:1px solid ${ACCENT};border-radius:4px">&nbsp;</td></tr></table></td>`;

function overnightSection(items: string[]): string {
  const body =
    items.length === 0
      ? `<div class="ink-dim" style="color:${DIM};font-size:13px">Nothing flagged overnight.</div>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${items
          .map(
            (item) =>
              `<tr>${DOT}<td class="ink" style="color:${INK};font-size:13px;line-height:1.6;padding-bottom:8px">${esc(item)}</td></tr>`,
          )
          .join("")}</table>`;
  return section(`${eyebrow("Overnight")}${body}`);
}

function scheduleSection(rows: ScheduleRow[]): string {
  if (rows.length === 0) return "";
  const head = `<tr>
    <td class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Time</td>
    <td class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Event</td>
    <td align="right" class="ink-dim" style="padding:0 0 7px 0;${LBL}">Cons / prior</td>
  </tr>`;
  let lastGroup: string | undefined;
  const body = rows
    .map((row) => {
      const groupRow =
        row.group === undefined || row.group === lastGroup
          ? ""
          : `<tr><td colspan="3" class="ink-dim rule" style="padding:12px 0 4px;border-top:1px solid ${BORDER};${LBL}">${esc(row.group)}</td></tr>`;
      lastGroup = row.group;
      const when = scheduleTimeLabel(row);
      const cp = [row.consensus, row.prior]
        .filter((v): v is string => v !== undefined)
        .map(formatScheduleMagnitude)
        .join(" / ");
      return `${groupRow}<tr>
        <td valign="top" class="ink-dim rule" style="padding:8px 10px 8px 0;border-top:1px solid ${BORDER};color:${DIM};font-size:12px;white-space:nowrap">${esc(when)}</td>
        <td valign="top" class="ink rule" style="padding:8px 10px 8px 0;border-top:1px solid ${BORDER};color:${INK};font-size:13px;line-height:1.45">${esc(row.event)}</td>
        <td valign="top" align="right" class="ink-dim rule" style="padding:8px 0;border-top:1px solid ${BORDER};color:${DIM};font-size:12px;white-space:nowrap">${esc(cp)}</td>
      </tr>`;
    })
    .join("");
  return section(
    `${eyebrow("Today's schedule")}
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${head}${body}</table>`,
  );
}

/** The regime stances as three plain label/value pairs. Colour carries no
 *  meaning here, so it is not spent. */
function stanceRow(view: BriefView): string {
  const rows = [
    ["Direction", view.regime.direction],
    ["Volatility", view.regime.volatility],
    ["Hedge", view.regime.hedge],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (rows.length === 0) return "";
  const cells = rows
    .map(
      ([label, value]) =>
        `<td valign="top" width="33%" style="width:33.33%;padding:0 10px 0 0">
           <div class="ink-dim" style="${LBL}">${esc(label)}</div>
           <div class="ink" style="color:${INK};font-size:14px;font-weight:650;padding-top:3px">${esc(value)}</div>
         </td>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;margin-top:16px"><tr>${cells}</tr></table>`;
}

/** The payoff profile's geometry. Twelve columns divide 100% evenly enough for
 *  a fixed-layout table, and adjacent columns of equal height are merged with
 *  `colspan` — a vertical spread's profile is two flats and a ramp, so twelve
 *  columns cost about five cells, which is what keeps the figure inside the
 *  90KB Gmail-clip budget at five candidates. */
const PAYOFF_COLS = 12;
const PAYOFF_H = 42;
/** The gutter that carries the max-gain / max-loss axis labels. */
const PAYOFF_GUTTER = 64;
const GUT = `<td width="${String(PAYOFF_GUTTER)}" style="width:${String(PAYOFF_GUTTER)}px;font-size:1px;line-height:1px">&nbsp;</td>`;
const FIXED =
  'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed"';

/**
 * The payoff at expiry, as an actual payoff diagram.
 *
 * What this replaced (2026-09-04): one horizontal bar per `pnlAt` point, bar
 * length proportional to |P&L|. Six bars of two colours pointing the same way
 * is not a payoff — nothing in it said which end was the underlying going up,
 * and a max-loss bar and a max-gain bar of similar size looked identical.
 *
 * This draws the real thing: P&L on the vertical, spot at expiry on the
 * horizontal, a zero line, gains above it in green and losses below in red,
 * with the spot and every breakeven marked on the axis. Every column's value
 * comes from `payoffAt` — the same function that produced `maxGain`, `maxLoss`
 * and the `pnlAt` table below — evaluated at that column's centre price, so
 * the picture cannot disagree with the numbers beside it. Nothing is sampled,
 * smoothed or invented.
 *
 * The axis spans the strikes, the breakevens and the spot, padded 18% each
 * side so the flat max-gain and max-loss ends are visible. That range is a
 * display choice and is printed under the chart; it is not data.
 */
function payoffFigure(candidate: CandidateView, pricing: Priced): string {
  const anchors = [
    ...candidate.legs.map((leg) => leg.strike),
    ...pricing.breakevens,
  ];
  if (candidate.spot !== undefined) anchors.push(candidate.spot);
  const low = Math.min(...anchors);
  const high = Math.max(...anchors);
  const spread = high - low;
  const pad = spread > 0 ? spread * 0.18 : Math.max(1, high * 0.05);
  const lo = low - pad;
  const hi = high + pad;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return "";
  const step = (hi - lo) / PAYOFF_COLS;
  const values = Array.from({ length: PAYOFF_COLS }, (_, i) =>
    payoffAt(candidate.legs, pricing.net, lo + step * (i + 0.5)),
  );
  const posMax = Math.max(0, ...values, pricing.maxGain ?? 0);
  const negMax = Math.max(0, ...values.map((v) => -v), pricing.maxLoss ?? 0);
  const scale = Math.max(posMax, negMax, 1);
  const height = (magnitude: number): number =>
    Math.round((PAYOFF_H * magnitude) / scale);
  const gainH = posMax > 0 ? Math.max(4, height(posMax)) : 0;
  const lossH = negMax > 0 ? Math.max(4, height(negMax)) : 0;

  /** One half of the profile, run-length encoded: consecutive columns of the
   *  same bar height become one `colspan` cell. */
  const half = (up: boolean, areaH: number): string => {
    if (areaH === 0) return "";
    const bars = values.map((value) => {
      const magnitude = up ? value : -value;
      return magnitude > 0
        ? Math.max(1, Math.min(areaH, height(magnitude)))
        : 0;
    });
    const cells: string[] = [];
    for (let i = 0; i < bars.length;) {
      let span = 1;
      while (i + span < bars.length && bars[i + span] === bars[i]) span += 1;
      const width = ((span * 100) / PAYOFF_COLS).toFixed(2);
      const box = `width:${width}%;height:${String(areaH)}px;font-size:1px;line-height:1px`;
      const barH = bars[i]!;
      cells.push(
        barH === 0
          ? `<td colspan="${String(span)}" style="${box}">&nbsp;</td>`
          : `<td colspan="${String(span)}" valign="${up ? "bottom" : "top"}" style="${box}"><div style="height:${String(barH)}px;line-height:${String(barH)}px;background-color:${up ? POS : NEG}">&nbsp;</div></td>`,
      );
      i += span;
    }
    return `<table ${FIXED}><tr>${cells.join("")}</tr></table>`;
  };

  /** A price marker under the axis, positioned by percentage. Each marker gets
   *  its own row, which is what makes overlap impossible without any
   *  collision arithmetic. */
  const marker = (
    at: number,
    label: string,
    colour: string,
    cls: string,
  ): string => {
    const pct = Math.max(0, Math.min(100, ((at - lo) / (hi - lo)) * 100));
    const left = pct <= 50;
    const gap = `<td width="${(left ? pct : 100 - pct).toFixed(1)}%" style="font-size:1px;line-height:1px">&nbsp;</td>`;
    const text = `<td align="${left ? "left" : "right"}" class="${cls}" style="color:${colour};font-size:10px;white-space:nowrap;padding-top:3px">${left ? "&#9650; " : ""}${esc(label)}${left ? "" : " &#9650;"}</td>`;
    return `<tr>${GUT}<td><table ${FIXED}><tr>${left ? gap + text : text + gap}</tr></table></td></tr>`;
  };

  const gutter = (inner: string, align: "top" | "bottom"): string =>
    `<td width="${String(PAYOFF_GUTTER)}" valign="${align}" align="right" style="width:${String(PAYOFF_GUTTER)}px;padding-right:8px">${inner}</td>`;

  const gainRow =
    gainH === 0
      ? ""
      : `<tr>${gutter(
          `<div class="ink-dim" style="${LBL}">max gain</div><div class="pos" style="color:${POS};font-size:11px;font-weight:650">${esc(money(pricing.maxGain))}</div>`,
          "top",
        )}<td valign="bottom">${half(true, gainH)}</td></tr>`;
  const lossRow =
    lossH === 0
      ? ""
      : `<tr>${gutter(
          `<div class="neg" style="color:${NEG};font-size:11px;font-weight:650">${esc(money(pricing.maxLoss))}</div><div class="ink-dim" style="${LBL}">max loss</div>`,
          "bottom",
        )}<td valign="top">${half(false, lossH)}</td></tr>`;

  const markers = [
    candidate.spot === undefined
      ? ""
      : marker(
          candidate.spot,
          `spot ${candidate.spot.toFixed(2)}`,
          ACCENT,
          "accent",
        ),
    ...pricing.breakevens.map((value) =>
      marker(value, `breakeven ${value.toFixed(2)}`, DIM, "ink-dim"),
    ),
  ].join("");

  return `<table ${FIXED.replace("table-layout:fixed", "table-layout:fixed;margin-top:6px")}>
    ${gainRow}
    <tr>${GUT}<td class="rule" style="border-top:1px solid ${BORDER_STRONG};font-size:1px;line-height:1px">&nbsp;</td></tr>
    ${lossRow}
    <tr>${GUT}<td><table ${FIXED}><tr>
      <td align="left" class="ink-dim" style="color:${MUTED};font-size:10px;padding-top:4px">${lo.toFixed(2)}</td>
      <td align="right" class="ink-dim" style="color:${MUTED};font-size:10px;padding-top:4px">${hi.toFixed(2)}</td>
    </tr></table></td></tr>
    ${markers}
  </table>`;
}

/** The exact P&L at the six points `math.ts` measured: percentage moves off a
 *  quoted spot, or the strikes themselves when no tool quoted one. Two rows,
 *  under the same gutter as the figure above. */
function payoffPoints(pricing: Priced): string {
  const quoted = pricing.pnlAt[0]?.pct !== null;
  const head = pricing.pnlAt
    .map((point) => {
      const move =
        point.pct === null
          ? ""
          : `<br><span class="ink-dim" style="color:${MUTED};font-size:9px">${point.pct > 0 ? "+" : ""}${String(point.pct)}%</span>`;
      return `<td align="right" class="ink" style="padding:0 0 0 6px;color:${INK};font-size:11px;line-height:1.3">${point.spot.toFixed(2)}${move}</td>`;
    })
    .join("");
  const body = pricing.pnlAt
    .map(
      (point) =>
        `<td align="right" class="${point.pnl >= 0 ? "pos" : "neg"} rule" style="padding:5px 0 0 6px;border-top:1px solid ${BORDER};color:${point.pnl >= 0 ? POS : NEG};font-size:12px;font-weight:650">${point.pnl >= 0 ? "+" : "−"}${Math.abs(point.pnl).toFixed(0)}</td>`,
    )
    .join("");
  return `<table ${FIXED.replace("table-layout:fixed", "table-layout:fixed;margin-top:14px")}>
    <tr><td width="11%" valign="bottom" class="ink-dim" style="width:11%;${LBL}">${quoted ? "Spot" : "Strike"}</td>${head}</tr>
    <tr><td class="ink-dim rule" style="padding-top:5px;border-top:1px solid ${BORDER};${LBL}">P&amp;L</td>${body}</tr>
  </table>`;
}

function legRows(candidate: CandidateView): string {
  return candidate.legs
    .map(
      (leg) => `<tr>
        <td class="${leg.action === "buy" ? "pos" : "neg"} rule" style="padding:6px 6px 6px 0;border-top:1px solid ${BORDER};color:${leg.action === "buy" ? POS : NEG};font-size:12px;font-weight:600">${esc(leg.action)}</td>
        <td class="ink rule" style="padding:6px;border-top:1px solid ${BORDER};color:${INK};font-size:12px">${esc(leg.right)}</td>
        <td align="right" class="ink rule" style="padding:6px;border-top:1px solid ${BORDER};color:${INK};font-size:12px">${leg.strike.toFixed(2)}</td>
        <td class="ink-dim rule" style="padding:6px;border-top:1px solid ${BORDER};color:${DIM};font-size:12px">${esc(leg.expiry)}</td>
        <td align="right" class="ink rule" style="padding:6px 0 6px 6px;border-top:1px solid ${BORDER};color:${INK};font-size:12px">${leg.mid === undefined ? "—" : leg.mid.toFixed(2)}</td>
      </tr>`,
    )
    .join("");
}

function pricingBlock(candidate: CandidateView): string {
  const pricing = candidate.pricing;
  if (pricing.kind !== "priced") {
    return `<div class="${pricing.kind === "invalid" ? "neg" : "ink-dim"}" style="margin-top:12px;color:${pricing.kind === "invalid" ? NEG : WARN};font-size:13px">${esc(pricing.reason)}</div>`;
  }
  const credit = pricing.net >= 0;
  return `<div class="ink" style="margin-top:12px;font-size:13px;line-height:1.5;color:${INK}">
      ${credit ? "Net credit" : "Net debit"} <strong>$${Math.abs(pricing.net).toFixed(2)}</strong> per share · spread width ${candidate.width.toFixed(2)}
    </div>
    <div class="ink-dim" style="margin-top:16px;${LBL}">Payoff at expiry · $ per contract</div>
    ${payoffFigure(candidate, pricing)}
    ${payoffPoints(pricing)}
    <div class="ink-dim" style="color:${MUTED};font-size:10px;margin-top:6px">per contract, no size</div>`;
}

/** Entry / Target / Invalidation, side by side: the level that starts the
 *  thesis, what it is aiming at, and the level that kills it. Three outlined
 *  boxes, per the spec's watchlist module — outline only, no fill. */
function trigger(candidate: CandidateView): string {
  const entry =
    candidate.entry === undefined ? "—" : invalidationLabel([candidate.entry]);
  const target = candidate.target === "" ? "—" : esc(candidate.target);
  const stop = esc(invalidationLabel(candidate.invalidation));
  const tile = (
    label: string,
    value: string,
    colour: string,
    cls: string,
  ): string =>
    `<td width="33%" valign="top" style="width:33.33%;padding:0 8px 0 0">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border-collapse:separate;background-color:${PAPER};border:1px solid ${BORDER};border-radius:6px"><tr><td valign="top" style="padding:8px 10px">
         <div class="ink-dim" style="${LBL}">${label}</div>
         <div class="${cls}" style="color:${colour};font-size:13px;font-weight:600;padding-top:3px;line-height:1.4">${value}</div>
       </td></tr></table>
     </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;margin-top:12px">
    <tr>${tile("Entry", esc(entry), INK, "ink")}${tile("Target", target, INK, "ink")}${tile("Invalidation", stop, NEG, "neg")}</tr>
  </table>`;
}

function candidateCard(candidate: CandidateView): string {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  const earnings =
    candidate.earnings === undefined ? "" : ` · earnings ${candidate.earnings}`;
  const spot =
    candidate.spot === undefined ? "" : `Spot ${candidate.spot.toFixed(2)}`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="bottom" class="ink" style="color:${INK};font-size:18px;font-weight:650;letter-spacing:-0.2px">${esc(candidate.ticker)}</td>
          <td valign="bottom" align="right" class="ink-dim" style="color:${MUTED};font-size:11px">Exp ${esc(candidate.expiry)}${esc(dte)}${esc(earnings)}</td>
        </tr></table>
        <div class="ink-dim" style="color:${DIM};font-size:13px;padding-top:3px">${esc(candidate.strategy)}${spot === "" ? "" : ` · ${spot}`}</div>
        ${trigger(candidate)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ink" style="margin-top:14px;border-collapse:collapse;color:${INK}">
          <tr>
            <th align="left" class="ink-dim" style="padding:0 6px 6px 0;${LBL};font-weight:400">action</th>
            <th align="left" class="ink-dim" style="padding:0 6px 6px;${LBL};font-weight:400">right</th>
            <th align="right" class="ink-dim" style="padding:0 6px 6px;${LBL};font-weight:400">strike</th>
            <th align="left" class="ink-dim" style="padding:0 6px 6px;${LBL};font-weight:400">expiry</th>
            <th align="right" class="ink-dim" style="padding:0 0 6px 6px;${LBL};font-weight:400">mid</th>
          </tr>
          ${legRows(candidate)}
        </table>
        ${pricingBlock(candidate)}
        ${
          candidate.unchecked === undefined
            ? ""
            : `<div class="neg" style="color:${WARN};font-size:12px;margin-top:12px">⚠ ${esc(candidate.unchecked)}</div>`
        }
        <div class="ink" style="color:${INK};font-size:13px;line-height:1.6;margin-top:12px">${esc(candidate.rationale)}</div>
        <div class="ink-dim" style="color:${MUTED};font-size:10px;font-family:ui-monospace,Menlo,monospace;margin-top:10px">${esc(candidate.id)}</div>`;
}

/**
 * The two data charts. Same primitive as the payoff figure and for the same
 * reason: a table cell with a background colour is the only chart every mail
 * client draws. Gmail rewrites a data-URI `src` to `nosrc` and deletes an
 * inline `<svg>` WITH its fallback, so there is no image and no svg anywhere
 * in this file.
 *
 * Every number below comes from `view.charts`, which `chartsFrom` built out of
 * the run's raw tool outputs. No model step is read here, and a chart whose
 * tool did not answer returns "" — omitted, never faked.
 */
function bar(pct: number, colour: string): string {
  const filled = Math.max(1, Math.min(100, Math.round(pct)));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
    <td width="${String(filled)}%" style="background-color:${colour};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
    <td class="grid" width="${String(100 - filled)}%" style="background-color:${GRID};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
  </tr></table>`;
}

/** A sub-heading inside a section. */
function subhead(text: string, top = 18): string {
  return `<div class="ink-dim" style="margin-top:${String(top)}px;${LBL};font-weight:600">${esc(text)}</div>`;
}

function yieldCurveChart(chart: BriefView["charts"]["yieldCurve"]): string {
  if (chart === undefined) return "";
  const top = Math.max(...chart.points.map((point) => point.value));
  // The axis does NOT start at zero, and the caption says so. 4.375 and 4.788
  // differ by 9% of their own size and by everything anyone trades on; a
  // zero-based axis draws them as the same bar and hides the curve's shape,
  // which is the only thing this chart exists to show.
  const span = Math.max(0.05, top - chart.baseline);
  const rows = chart.points
    .map((point) => {
      // A yield RISING is not a gain: the colour follows the level, and the
      // reader reads the sign, so both directions get the semantic pair.
      const change =
        point.change === undefined
          ? ""
          : ` <span class="${point.change >= 0 ? "neg" : "pos"}" style="color:${point.change >= 0 ? NEG : POS};font-size:11px">${point.change >= 0 ? "+" : ""}${point.change.toFixed(3)}</span>`;
      return `<tr>
        <td width="34" class="ink-dim" style="width:34px;padding:3px 8px 3px 0;color:${DIM};font-size:11px;white-space:nowrap">${esc(point.label)}</td>
        <td style="padding:3px 0">${bar(((point.value - chart.baseline) / span) * 100, ACCENT)}</td>
        <td width="86" align="right" class="ink" style="width:86px;padding:3px 0 3px 8px;color:${INK};font-size:12px;font-weight:600;white-space:nowrap">${point.value.toFixed(3)}%${change}</td>
      </tr>`;
    })
    .join("");
  const spread =
    chart.spread2s10s === undefined
      ? ""
      : ` · 2s10s ${chart.spread2s10s >= 0 ? "+" : ""}${chart.spread2s10s.toFixed(1)}bp`;
  return `${subhead("Treasury curve", 0)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px">${rows}</table>
    <div class="ink-dim" style="color:${MUTED};font-size:10px;margin-top:5px">Axis starts at ${chart.baseline.toFixed(2)}%, not zero${esc(spread)}</div>`;
}

function policyPathChart(chart: BriefView["charts"]["policyPath"]): string {
  if (chart === undefined) return "";
  const rows = chart.meetings
    .map((meeting) => {
      const detail = [meeting.impliedRate, meeting.targetRange]
        .filter((value): value is string => value !== undefined)
        .join(" · ");
      // Hold is the neutral outcome and gets the accent; a move in either
      // direction is the thing worth seeing at a glance.
      const hold =
        meeting.stance === undefined || /hold/iu.test(meeting.stance);
      const cut = !hold && /cut/iu.test(meeting.stance ?? "");
      const colour = hold ? DIM : cut ? POS : NEG;
      const cls = hold ? "ink-dim" : cut ? "pos" : "neg";
      return `<tr>
        <td width="46" valign="top" class="ink" style="width:46px;padding:3px 8px 3px 0;color:${INK};font-size:12px;font-weight:600;white-space:nowrap">${esc(meeting.label)}</td>
        <td valign="top" style="padding:3px 0">${bar(meeting.probability, hold ? ACCENT : colour)}
          <div class="ink-dim" style="color:${MUTED};font-size:10px;padding-top:2px">${esc(detail)}</div></td>
        <td width="72" valign="top" align="right" class="${cls}" style="width:72px;padding:3px 0 3px 8px;color:${colour};font-size:12px;font-weight:600;white-space:nowrap">${esc(meeting.stance ?? "")} ${meeting.probability.toFixed(0)}%</td>
      </tr>`;
    })
    .join("");
  return `${subhead("Priced policy path")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px">${rows}</table>
    <div class="ink-dim" style="color:${MUTED};font-size:10px;margin-top:5px">Fed-funds futures via argon${chart.snapshotDate === undefined ? "" : `, snapshot ${esc(chart.snapshotDate)}`}; not CME FedWatch</div>`;
}

function ratesCard(charts: BriefView["charts"]): string {
  const inner = `${yieldCurveChart(charts.yieldCurve)}${policyPathChart(charts.policyPath)}`;
  return inner === ""
    ? ""
    : section(`${eyebrow("Rates & policy path")}${inner}`);
}

/** One ticker's gamma ladder: the levels argon returned around spot, bar
 *  length proportional to |gamma| against the largest on that ticker, spot
 *  shown as its own row so the reader can see which side of each wall it is
 *  on. Positive gamma is a damping wall, negative an amplifying one. */
function gexLadder(chart: BriefView["charts"]["gex"][number]): string {
  const maxAbs = Math.max(
    1,
    ...chart.levels.map((level) => Math.abs(level.gamma)),
  );
  const rows = chart.levels
    .map((level) => {
      const positive = level.gamma >= 0;
      const width = (Math.abs(level.gamma) / maxAbs) * 100;
      const here =
        chart.spot !== undefined && Math.abs(level.strike - chart.spot) < 0.005;
      return `<tr>
        <td width="52" valign="top" class="ink" style="width:52px;padding:5px 8px 5px 0;color:${INK};font-size:12px;font-weight:600;white-space:nowrap">${level.strike.toFixed(2)}${here ? " ◂" : ""}</td>
        <td valign="top" style="padding:5px 0">${bar(width, positive ? ACCENT : NEG)}
          <div class="ink-dim" style="color:${MUTED};font-size:10px;padding-top:2px">${esc(level.label)}${level.role === undefined ? "" : ` · ${esc(level.role)}`}</div></td>
        <td width="76" valign="top" align="right" class="${positive ? "ink" : "neg"}" style="width:76px;padding:5px 0 5px 8px;color:${positive ? INK : NEG};font-size:11px;white-space:nowrap">${level.gamma >= 0 ? "+" : "−"}${Math.abs(level.gamma).toFixed(0)}</td>
      </tr>`;
    })
    .join("");
  const spot =
    chart.spot === undefined
      ? ""
      : `<div class="ink-dim" style="color:${MUTED};font-size:10px">Spot ${chart.spot.toFixed(2)}${chart.asOf === undefined ? "" : ` · as of ${esc(chart.asOf)}`}</div>`;
  return `${subhead(chart.ticker)}
    ${spot}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:6px">${rows}</table>`;
}

function gexCard(charts: BriefView["charts"]): string {
  if (charts.gex.length === 0) return "";
  return section(
    `${eyebrow("Gamma profile")}${charts.gex.map(gexLadder).join("")}
     <div class="ink-dim" style="color:${MUTED};font-size:10px;margin-top:12px;line-height:1.5">Dealer gamma per strike from argon. A bar is its size, the colour its sign — red is negative gamma, where hedging amplifies rather than damps.</div>`,
  );
}

/** Risk register: a compact ticker/reason table, not one card per row. */
function riskRegister(riskList: BriefView["riskList"]): string {
  if (riskList.length === 0) return "";
  const head = `<tr>
    <td class="ink-dim" style="padding:0 12px 7px 0;${LBL}">Ticker</td>
    <td class="ink-dim" style="padding:0 0 7px 0;${LBL}">Reason</td>
  </tr>`;
  const rows = riskList
    .map(
      (entry) => `<tr>
        <td valign="top" class="ink rule" style="padding:8px 12px 8px 0;border-top:1px solid ${BORDER};color:${INK};font-size:13px;font-weight:600;white-space:nowrap">${esc(entry.ticker)}</td>
        <td valign="top" class="ink-dim rule" style="padding:8px 0;border-top:1px solid ${BORDER};color:${DIM};font-size:12px;line-height:1.5">${esc(entry.reason)}</td>
      </tr>`,
    )
    .join("");
  return section(
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
      // regime step's own prose); a mark there would repeat it, so the line
      // is left dim instead of prefixing a redundant symbol.
      const restHtml = skipped
        ? esc(rest)
        : `<span class="pos" style="color:${POS}">✓</span> ${esc(rest)}`;
      return `<tr>
        <td valign="top" class="ink rule" style="padding:7px 12px 7px 0;border-top:1px solid ${BORDER};color:${INK};font-size:12px;font-weight:600;white-space:nowrap">${esc(label)}</td>
        <td valign="top" class="ink-dim rule" style="padding:7px 0;border-top:1px solid ${BORDER};color:${MUTED};font-size:11px;line-height:1.5">${restHtml}</td>
      </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${rows}</table>`;
}

function coverageSection(coverage: BriefView["coverage"]): string {
  if (coverage === undefined) return "";
  return section(`${eyebrow("Data coverage")}${coverageRows(coverage.body)}`);
}

/** The run's own narrative blocks, each its own section: title as the 13px
 *  section head, body as 13px prose. No serif, no underline, no accent — the
 *  spec's hierarchy is weight and whitespace. */
function narrative(view: BriefView): string {
  const stance = stanceRow(view);
  if (view.sections.length === 0 && stance === "") return "";
  const blocks = view.sections
    .map((block) =>
      section(
        `${eyebrow(block.title)}<div class="ink" style="color:${INK};font-size:13px;line-height:1.7">${esc(block.body).replace(/\n/g, "<br>")}</div>`,
      ),
    )
    .join("");
  return `${blocks}${stance === "" ? "" : section(stance)}`;
}

export function renderHtml(view: BriefView): string {
  const statusBadge =
    view.outcome === "completed"
      ? ""
      : ` <span class="neg" style="color:${NEG};font-weight:600">· ${esc(view.outcome)}</span>`;

  // Header: wordmark left, date right, fixed title, the 36x3 accent bar, then
  // a hairline. The day's own sentence is NOT here — it is the section under
  // the snapshot, where the spec puts it.
  const header = `<tr><td class="pad" style="padding:32px 32px 0">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
       <td class="ink-dim" style="color:${MUTED};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600">${esc(view.tenant)}</td>
       <td align="right" class="ink-dim" style="color:${MUTED};font-size:11px">${esc(view.date)}${statusBadge}</td>
     </tr></table>
     <div class="ink" style="color:${INK};font-size:29px;font-weight:650;letter-spacing:-0.5px;line-height:1.2;padding-top:16px">Daily Market Report</div>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:14px"><tr><td width="36" style="width:36px;height:3px;line-height:3px;font-size:1px;background-color:${ACCENT};border-radius:2px">&nbsp;</td></tr></table>
   </td></tr>
   <tr><td class="pad" style="padding:22px 32px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid ${BORDER};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>`;

  const body =
    view.empty !== undefined
      ? `${tapeStrip(view.tape)}
         ${oneSentence(view.headline)}
         ${section(
           `${eyebrow("Candidates")}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="chip" style="border-collapse:separate;background-color:${ACCENT_SOFT};border:1px solid ${BORDER};border-radius:7px"><tr><td style="padding:12px 16px">
             <div class="ink" style="color:${INK};font-size:14px;line-height:1.55">${esc(view.empty)}</div>
           </td></tr></table>`,
         )}
         ${bottomLine(view)}
         ${overnightSection(view.overnight)}
         ${scheduleSection(view.schedule)}
         ${ratesCard(view.charts)}`
      : `${tapeStrip(view.tape)}
         ${oneSentence(view.headline)}
         ${bottomLine(view)}
         ${overnightSection(view.overnight)}
         ${scheduleSection(view.schedule)}
         ${narrative(view)}
         ${ratesCard(view.charts)}
         ${
           view.candidates.length === 0
             ? ""
             : section(
                 `${eyebrow("Candidates")}<div class="ink-dim" style="color:${MUTED};font-size:11px;margin:-6px 0 16px">Per contract, no size.</div>${view.candidates
                   .map(
                     (candidate, index) =>
                       `<div class="${index === 0 ? "" : "rule"}" style="${index === 0 ? "" : `margin-top:22px;padding-top:22px;border-top:1px solid ${BORDER}`}">${candidateCard(candidate)}</div>`,
                   )
                   .join("")}`,
               )
         }
         ${gexCard(view.charts)}
         ${riskRegister(view.riskList)}
         ${coverageSection(view.coverage)}`;

  const degradationRow =
    view.degradation === undefined
      ? ""
      : `<tr><td class="pad neg" style="padding:0 32px 20px;color:${WARN};font-size:12px">${esc(view.degradation)}</td></tr>`;

  const footer = `${hairline()}
   <tr><td class="pad" style="padding:14px 32px 32px">
     <div class="ink-dim" style="color:${MUTED};font-size:10px;line-height:1.6">All structures are defined-risk. No quantities, position sizes or account information appear anywhere in this note.</div>
     <div class="ink-dim" style="color:${MUTED};font-size:10px;margin-top:4px">[${esc(view.tenant)}] ${esc(view.date)}</div>
   </td></tr>`;

  // The template literals below are indented for the human reading this file,
  // and that indentation is ~4KB of the 102KB Gmail clip budget at three
  // candidates. Whitespace that sits BETWEEN two tags is a whitespace-only
  // text node with nothing to separate, so it is dropped; anything adjacent to
  // real text (`</span> word`, `text\n</div>`) does not match this pattern and
  // survives untouched.
  const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(view.tenant)} ${esc(view.date)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .bg { background-color: #0D0F12 !important; }
  .card { background-color: #14171B !important; border-color: #262B31 !important; }
  .ink { color: #E9ECF1 !important; }
  .ink-dim { color: #A2ABB6 !important; }
  .chip { background-color: #131C29 !important; border-color: #26313F !important; }
  .rule { border-top-color: #262B31 !important; border-bottom-color: #262B31 !important; }
  .grid { background-color: #1E242B !important; }
  .accent { color: #6FA8F5 !important; }
  .pos { color: #3FBF83 !important; }
  .neg { color: #F07070 !important; }
}
[data-ogsc] .ink { color: #E9ECF1 !important; }
[data-ogsc] .ink-dim { color: #A2ABB6 !important; }
[data-ogsc] .accent { color: #6FA8F5 !important; }
[data-ogsc] .pos { color: #3FBF83 !important; }
[data-ogsc] .neg { color: #F07070 !important; }
[data-ogsb] .card { background-color: #14171B !important; }
[data-ogsb] .chip { background-color: #131C29 !important; }
@media only screen and (max-width: 359px) {
  .pad { padding-left: 16px !important; padding-right: 16px !important; }
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background-color:${PAPER}">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="max-width:640px;background-color:${PAPER};font-family:${SANS};${NUM}">
   ${header}${body}${degradationRow}${footer}
  </table>
 </td></tr>
</table>
</body></html>`;
  return page.replace(/>\n\s+</gu, "><");
}
