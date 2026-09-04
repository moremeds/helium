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
 * ABRIDGED (2026-09-05). The mail is no longer the whole brief: argon's Flash
 * page is, and this is the part a reader acts on without opening a browser.
 * Section order: header -> market snapshot (tape) -> today in one sentence
 * (the run's headline) -> bottom line (decision block) -> candidates, one row
 * each -> the Flash link. The narrative sections, per-candidate rationales,
 * payoff figures, schedule, overnight list, rates/gamma charts, risk register
 * and data-coverage table were REMOVED from the mail, not from the document:
 * `renderReport` still hands the full `BriefView` to the argon channel, which
 * is where they are read now.
 *
 * @module dsh-plugin-tenant-option-wizard/render/html
 */
import type { BriefView, CandidateView, TapeItem } from "./index.js";
import { invalidationLabel } from "./math.js";
import { flashUrl } from "./week.js";

/**
 * Design 04's tokens, verbatim from the spec. Blue is an accent; the two
 * semantic colours are spent on numbers and bars and on nothing else.
 */
const INK = "#111318";
const DIM = "#626A75";
const MUTED = "#9198A2";
const PAPER = "#FFFFFF";
const BORDER = "#E8EBEF";
const ACCENT = "#1769E0";
const ACCENT_SOFT = "#EFF6FF";
const POS = "#168A54";
const NEG = "#D54141";

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
/** Row sizes for `n` tiles, at most three across and as even as possible. */
export function tapeRowSizes(n: number): number[] {
  if (n <= 0) return [];
  const rowCount = Math.ceil(n / 3);
  const base = Math.floor(n / rowCount);
  const extra = n % rowCount;
  return Array.from({ length: rowCount }, (_, r) => base + (r < extra ? 1 : 0));
}

function tapeStrip(items: TapeItem[]): string {
  if (items.length === 0) return "";
  const cell = (item: TapeItem, widthPct: number): string => {
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
    return `<td width="${widthPct}%" valign="top" style="width:${widthPct}%;padding:0 8px 8px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" height="100%" class="card" style="height:100%;border-collapse:separate;background-color:${PAPER};border:1px solid ${BORDER};border-radius:7px"><tr><td valign="top" style="padding:9px 11px">
        <div class="ink-dim" style="${LBL};white-space:nowrap">${esc(item.label)}</div>
        <div class="ink" style="color:${INK};font-size:18px;font-weight:650;padding-top:3px">${esc(split.value)}${change}</div>
        ${note}
      </td></tr></table>
    </td>`;
  };
  // Balanced rows, at most three across: 10 tiles are 3/3/2/2, never 3/3/3/1.
  // A lone tile on the last row reads as a missing one — the same rule the
  // Flash page uses for its tape.
  const rows: string[] = [];
  let i = 0;
  for (const size of tapeRowSizes(items.length)) {
    const slice = items.slice(i, i + size);
    i += size;
    const widthPct = Math.round((100 / size) * 100) / 100;
    // One table per row: a fixed-layout table takes its column widths from
    // the first row, so a two-tile row inside a three-column table would sit
    // at two thirds width instead of stretching.
    rows.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed"><tr>${slice.map((item) => cell(item, widthPct)).join("")}</tr></table>`,
    );
  }
  return section(`${eyebrow("Market snapshot")}${rows.join("")}`);
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


/**
 * The candidate table: ONE row per candidate, and only the five fields a
 * reader acts on — which ticker, what the structure is, what it costs, what it
 * can lose, and the level that kills it.
 *
 * The card this replaced carried a payoff figure, a leg-by-leg grid, a
 * breakeven line and the reviewer's rationale paragraph. All of that still
 * exists, in the document argon's Flash page renders; the mail links to it
 * rather than duplicating it at 8KB a candidate.
 */
function candidateRows(candidates: CandidateView[]): string {
  const head = `<tr>
    <td class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Ticker</td>
    <td class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Structure</td>
    <td align="right" class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Net · share</td>
    <td align="right" class="ink-dim" style="padding:0 10px 7px 0;${LBL}">Max loss</td>
    <td align="right" class="ink-dim" style="padding:0 0 7px 0;${LBL}">Invalidation</td>
  </tr>`;
  const body = candidates
    .map((candidate) => {
      const pricing = candidate.pricing;
      const priced = pricing.kind === "priced";
      const net = priced
        ? `${pricing.net >= 0 ? "" : "−"}$${Math.abs(pricing.net).toFixed(2)}${pricing.net >= 0 ? " cr" : ""}`
        : "—";
      const maxLoss = priced ? money(pricing.maxLoss) : "—";
      const legs = candidate.legs
        .map(
          (leg) =>
            `${leg.action} ${leg.right} ${String(leg.strike)}${leg.mid === undefined ? "" : ` @ ${leg.mid.toFixed(2)}`}`,
        )
        .join(" / ");
      const cell = `padding:9px 10px 9px 0;border-top:1px solid ${BORDER}`;
      return `<tr>
        <td valign="top" class="ink rule" style="${cell};color:${INK};font-size:14px;font-weight:650;white-space:nowrap">${esc(candidate.ticker)}</td>
        <td valign="top" class="ink rule" style="${cell};color:${INK};font-size:13px;line-height:1.45">${esc(candidate.strategy)}
          <div class="ink-dim" style="color:${DIM};font-size:11px;line-height:1.45;padding-top:3px">${esc(legs)} · exp ${esc(candidate.expiry)}</div>
          ${priced ? "" : `<div class="neg" style="color:${WARN};font-size:11px;line-height:1.45;padding-top:3px">${esc(pricing.reason)}</div>`}
        </td>
        <td valign="top" align="right" class="ink rule" style="${cell};color:${INK};font-size:13px;white-space:nowrap">${esc(net)}</td>
        <td valign="top" align="right" class="ink rule" style="${cell};color:${INK};font-size:13px;white-space:nowrap">${esc(maxLoss)}</td>
        <td valign="top" align="right" class="neg rule" style="padding:9px 0 9px 0;border-top:1px solid ${BORDER};color:${NEG};font-size:13px;white-space:nowrap">${esc(invalidationLabel(candidate.invalidation))}</td>
      </tr>`;
    })
    .join("");
  return section(
    `${eyebrow("Candidates")}<div class="ink-dim" style="color:${MUTED};font-size:11px;margin:-6px 0 12px">Per contract, no size. Net is per share; max loss is per contract.</div>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${head}${body}</table>`,
  );
}

/**
 * The one line that says where the rest of the brief is.
 *
 * Absent when `ARGON_APP_BASE` is unset: the mail is abridged either way — the
 * link is what makes the abridgement recoverable, not what causes it.
 */
function flashLink(view: BriefView): string {
  const href = flashUrl(view.appBase ?? "", view.date, view.runLabel ?? "");
  if (href === "") return "";
  return section(
    `<div style="font-size:13px;line-height:1.55"><span class="ink-dim" style="color:${DIM}">Full brief: </span><a class="accent" href="${esc(href)}" style="color:${ACCENT};text-decoration:underline">${esc(href)}</a></div>`,
  );
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

  // The abridged mail (2026-09-05): the tape, the day's sentence, the decision
  // block, one row per candidate, and the link. Nothing else. The narrative
  // sections, the payoff figures, the rationales, the schedule, the overnight
  // list, the charts and the risk register are all still in `view` — argon's
  // Flash page renders them from the same document — and none of them is
  // printed here.
  const body =
    view.empty !== undefined
      ? `${tapeStrip(view.tape)}
         ${oneSentence(view.headline)}
         ${bottomLine(view)}
         ${section(
           `${eyebrow("Candidates")}
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="chip" style="border-collapse:separate;background-color:${ACCENT_SOFT};border:1px solid ${BORDER};border-radius:7px"><tr><td style="padding:12px 16px">
             <div class="ink" style="color:${INK};font-size:14px;line-height:1.55">${esc(view.empty)}</div>
           </td></tr></table>`,
         )}
         ${flashLink(view)}`
      : `${tapeStrip(view.tape)}
         ${oneSentence(view.headline)}
         ${bottomLine(view)}
         ${view.candidates.length === 0 ? "" : candidateRows(view.candidates)}
         ${flashLink(view)}`;

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
