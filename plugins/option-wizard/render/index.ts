/**
 * The tenant's deterministic renderer: the report in, the email out.
 *
 * What it refuses to do is the point. It does not print the roles' prose as the
 * brief (the 2026-09-02 emails were four agents' raw text concatenated, opening
 * with "Actually, let me simplify"), it does not print any number a role
 * computed (five of five `limitPrice` values disagreed with their own
 * rationale), and it says nothing about the run itself — run id, tokens, cost
 * and step count live in the audit table and the markdown report, never in the
 * mail.
 * @module dsh-plugin-tenant-option-wizard/render
 */
import type { RenderedReport, RunReport, TenantSpec } from "@helium/core";
import { priceStructure, width, type Leg, type Pricing } from "./math.js";
import { FLASH_BUDGET, trim } from "./budget.js";
import { chartsFrom, type Charts } from "./charts.js";
import { renderHtml } from "./html.js";
import { renderText } from "./text.js";

export type {
  Charts,
  CurvePoint,
  GexLevel,
  GexProfileChart,
  PolicyMeeting,
  PolicyPathChart,
  YieldCurveChart,
} from "./charts.js";

/**
 * One price that ends a thesis, and which way it has to go to do it.
 *
 * A number rather than the model's prose because this is the only field a
 * settlement can be CHECKED against: the close run compares it to a spot, and
 * a gate can ask whether a settled level ever appeared in the report. The
 * prose form it replaced ("XLK breaks 186 to upside OR breaks 175 to
 * downside") reads well and settles nothing.
 */
export interface Invalidation {
  level: number;
  side: "above" | "below";
}

export interface CandidateView {
  /** `<TICKER>-<report day>-<n>`, minted here, never written by the model.
   *  An id is bookkeeping, not judgement: asking the model to spell one
   *  invites typos and collisions, and those are the only two errors that
   *  can break a look-back. */
  id: string;
  /** The levels that kill this thesis, as the model committed to them in
   *  writing. This is what a later run settles against: 反转 is a breach of one
   *  of these on its own side, and nothing else. Usually one; a two-sided
   *  structure gets two. */
  invalidation: Invalidation[];
  ticker: string;
  strategy: string;
  expiry: string;
  /** Calendar days to expiry against the ET date; null when unparseable. */
  dte: number | null;
  legs: Leg[];
  pricing: Pricing;
  /** Widest strike span, per share; 0 when single-strike. */
  width: number;
  /** Where the thesis is trying to get to, in the model's own words. Prose,
   *  deliberately: 反转 triggers a 平仓建议 and so must be mechanical, while
   *  加强 / 不变 are judgement and read better as the sentence the designer
   *  actually wrote. */
  target: string;
  /** The declared entry trigger, when the designer wrote one as a level. Prose
   *  is dropped rather than parsed: the gate below compares it to a strike. */
  entry?: Invalidation;
  /** What the arithmetic gate could NOT check on this candidate, and why. A
   *  silent pass and a real pass look identical to a reader, and the run that
   *  shipped a QQQ 420/410 spread with QQQ at 707 looked like a pass. */
  unchecked?: string;
  /** The spot `ow_spot` (or an equivalent tool) priced this ticker at, so the
   *  card can print the level every strike was actually checked against.
   *  Absent means the arithmetic gate could not check this candidate either —
   *  the same condition `unchecked` already reports. */
  spot?: number;
  rationale: string;
  /** The next earnings date this structure spans, when the designer declared
   *  one. Display only: a malformed or absent declaration drops the field and
   *  never rejects the proposal — the gate on it is the reviewer's, and
   *  duplicating it here would reject twice for one fault. */
  earnings?: string;
}

export interface RegimeView {
  paragraph: string;
  direction?: string;
  volatility?: string;
  hedge?: string;
}

/** One narrative block: whatever the run chose to say, under its own title. */
export interface Section {
  title: string;
  body: string;
}

/** One tile in the masthead's tape strip — an index level, a rate, a
 *  commodity — as the regime step read it off a tool, never estimated. */
export interface TapeItem {
  label: string;
  value: string;
  /** Signed change string as the model wrote it, e.g. "+0.8bp" or "-0.36". */
  change?: string;
  /** Colour hint only. Absent means render neutral. */
  positive?: boolean;
}

/** One row of the day's dated calendar, as `ow_uw_calendar` answered it. */
export interface ScheduleRow {
  utc?: string;
  et?: string;
  event: string;
  consensus?: string;
  prior?: string;
  /** Grouping label the model chose, e.g. "Today" / "Tomorrow". */
  group?: string;
}

/**
 * Bumped ONLY on a breaking change to `BriefView` — a removed field, a renamed
 * field, or a changed meaning. Adding an optional field is not breaking.
 *
 * A consumer that stores the view and renders it days later, from a build that
 * may be older than the one that wrote it, otherwise sees a renamed field as a
 * silently missing section: a shorter page, with nothing to tell the reader
 * something was dropped. With a version it says "I was written for version N,
 * this is N+1" and the fix is a deploy rather than an investigation.
 */
export const BRIEF_VIEW_SCHEMA_VERSION = 1;

export interface BriefView {
  /** Which shape this document is in. See `BRIEF_VIEW_SCHEMA_VERSION`. */
  schemaVersion: number;
  /** `yyyy-mm-dd` — the run's report day, ET. ONE date, one zone: a brief that
   *  printed the HK date beside the ET one made the reader do the conversion
   *  the harness had already done. */
  date: string;
  tenant: string;
  outcome: "completed" | "DEGRADED" | "FAILED";
  /** The masthead's one-sentence daily call, from the regime step's own
   *  `headline` field. Empty on a run that never reached regime — the
   *  masthead then falls back to the tenant/date line alone rather than
   *  printing a constant that would make every mail look the same. */
  headline: string;
  /** The tape strip: index/rate/commodity levels the regime step already
   *  read off its tools, surfaced structurally instead of only in prose. */
  tape: TapeItem[];
  /** Today's dated calendar rows — claims, NFP, Fed speech — with
   *  consensus/prior, from the regime step's `schedule` field. */
  schedule: ScheduleRow[];
  /** Earnings (universe + index-weight names) and overnight macro headlines,
   *  at most five, newest first. Empty means nothing was flagged, and the
   *  renderer prints one line saying so rather than omitting the section. */
  overnight: string[];
  /** The narrative blocks the run actually produced, in task order.
   *
   *  The renderer does not know what a phase is, and must not learn: which
   *  blocks exist is the team manifest's business. A premarket run returns
   *  its four regime sections and four scenario paths; an intraday run
   *  returns one "no change" line. Both render through the same loop because
   *  both are just a list. Excludes the Layer Coverage block, which is
   *  pulled out into `coverage` so it always lands as the final section. */
  sections: Section[];
  /** The regime step's own data-coverage table, held apart from `sections`
   *  so "data coverage (compact)" can always render last regardless of what
   *  task order produced it. */
  coverage?: Section;
  regime: RegimeView;
  candidates: CandidateView[];
  riskList: Array<{ ticker: string; reason: string }>;
  /** The reviewer's decision block, in the order it wrote it: every key it
   *  filled and no key it did not. This block is the only part of the reply
   *  that says what to DO, and a line invented here would be the harness's
   *  opinion wearing the reviewer's name. Carried on the no-candidate day
   *  too, where it is the only thing the reader gets. Rendered as "Bottom
   *  line", near the top — this is the block a reader most needs. */
  decision?: Array<{ label: string; value: string }>;
  /** ONE line, present only when something actually failed. */
  degradation?: string;
  /** When set, the brief IS this line: no candidates, no sections. */
  empty?: string;
  /** Drawn from the run's raw tool outputs, never from a model step. Empty
   *  `gex` and absent curve/path all mean the tool did not answer. */
  charts: Charts;
  /** True when an `edit` step's document supplied the prose. Display-only —
   *  the footer says which pipeline wrote the words the reader is reading. */
  edited?: boolean;
  /** The run's own label, carried verbatim from `report.phase` and printed
   *  into the Flash link and nowhere else. Opaque on purpose: the renderer
   *  must not learn what the labels ARE (`render.spec.ts` enforces it), and a
   *  string that is only ever concatenated into a URL cannot teach it. */
  runLabel?: string;
  /** argon's public origin, from `ARGON_APP_BASE`. Unset on a machine that has
   *  no Flash page to link to, and then no link is printed at all. */
  appBase?: string;
}

const RIGHTS = new Set(["call", "put"]);
const ACTIONS = new Set(["buy", "sell"]);

/** The last JSON object in a step's text, fenced or bare. */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  // Last resort: the widest brace span. A reviewer that forgets the fence still
  // gets read rather than costing the reader the whole brief.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first)
    candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function toLegs(raw: unknown): Leg[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const legs: Leg[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const leg = entry as Record<string, unknown>;
    if (typeof leg.right !== "string" || !RIGHTS.has(leg.right)) return null;
    if (typeof leg.action !== "string" || !ACTIONS.has(leg.action)) return null;
    if (typeof leg.strike !== "number" || typeof leg.expiry !== "string")
      return null;
    legs.push({
      right: leg.right as "call" | "put",
      action: leg.action as "buy" | "sell",
      strike: leg.strike,
      expiry: leg.expiry,
      ...(typeof leg.ratio === "number" ? { ratio: leg.ratio } : {}),
      ...(typeof leg.mid === "number" ? { mid: leg.mid } : {}),
    });
  }
  return legs;
}

/**
 * The model's `invalidation`, kept only when it is a level and a side.
 *
 * This replaced `horizon`, and the swap is the point: `horizon` asked the model
 * to pick one of three words, so it picked the one with least resistance —
 * thirteen of thirteen proposals came back `multiday` and the close run's
 * three-state settlement degraded to "not due yet". A level is not a word the
 * model can shrug at; it either states a number and a direction or it does not
 * get through.
 */
function toInvalidation(raw: unknown): Invalidation[] | null {
  // A single object rather than an array is the one shape worth tolerating:
  // it is the model writing the common case (one level) the natural way, and
  // dropping an otherwise-sound proposal over a bracket is a worse trade.
  const entries = Array.isArray(raw) ? raw : [raw];
  const out: Invalidation[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const side = row.side;
    if (typeof row.level !== "number" || !Number.isFinite(row.level)) continue;
    if (side !== "above" && side !== "below") continue;
    out.push({ level: row.level, side });
  }
  // Two is a two-sided structure; a third level means the thesis has no shape,
  // and settling against the wrong one of three is worse than not shipping it.
  return out.length === 0 || out.length > 2 ? null : out;
}

function regimeFrom(text: string): RegimeView {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("#"));
  const stance = (label: string): string | undefined => {
    const found = new RegExp(`${label}:\\s*([^.*\\n]+)`).exec(text);
    return found === null ? undefined : found[1]!.trim();
  };
  const direction = stance("Direction bias");
  const volatility = stance("Volatility stance");
  const hedge = stance("Hedge posture");
  return {
    paragraph: paragraphs[0] ?? "",
    ...(direction === undefined ? {} : { direction }),
    ...(volatility === undefined ? {} : { volatility }),
    ...(hedge === undefined ? {} : { hedge }),
  };
}

function degradationFrom(report: RunReport): string | undefined {
  const parts = [
    ...report.providersSkipped.map(
      (skip) => `provider ${skip.id} unavailable (${skip.reason})`,
    ),
    ...report.gatesSkipped.map(
      (skip) => `gate ${skip.id} not loaded (${skip.reason})`,
    ),
    ...report.steps
      .flatMap((step) => step.gateRefusals ?? [])
      .map((refusal) => `gate ${refusal.id} refused (${refusal.reason})`),
    ...report.steps
      .filter((step) => step.failure !== undefined)
      .map((step) => `step ${step.task} failed (${step.failure ?? ""})`),
  ];
  // `toolsUnconfigured` is NOT here. It is a known false positive today and its
  // root fix belongs to sub-project B; printing it would train the reader to
  // ignore the one line that is supposed to mean something.
  return parts.length === 0 ? undefined : `Data degraded: ${parts.join("; ")}`;
}

/** The masthead's one-sentence daily call, straight from the regime step's
 *  own `headline` field. Nothing here is invented — an absent or blank
 *  headline is simply undefined, and the masthead falls back to the
 *  tenant/date line. */
function headlineFrom(
  regimeJson: Record<string, unknown> | null,
): string | undefined {
  const headline = regimeJson?.headline;
  return typeof headline === "string" && headline.trim() !== ""
    ? headline.trim()
    : undefined;
}

/** The tape strip: whatever tiles the regime step reported, kept only when
 *  both `label` and `value` are strings it actually wrote. */
function tapeFrom(raw: unknown): TapeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TapeItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    // Models emit numbers as JSON numbers as often as strings; accept both.
    const value =
      typeof row.value === "string"
        ? row.value
        : typeof row.value === "number" && Number.isFinite(row.value)
          ? String(row.value)
          : undefined;
    if (typeof row.label !== "string" || value === undefined) continue;
    const change =
      typeof row.change === "string"
        ? row.change
        : typeof row.change === "number" && Number.isFinite(row.change)
          ? String(row.change)
          : undefined;
    out.push({
      label: row.label,
      value,
      ...(change !== undefined ? { change } : {}),
      ...(typeof row.positive === "boolean" ? { positive: row.positive } : {}),
    });
  }
  return out;
}

/** The dated calendar rows the regime step read off `ow_uw_calendar`. A row
 *  with no `event` string is not a row — the whole point is that a reader can
 *  see what is dated, and a blank event says nothing. */
function scheduleFrom(raw: unknown): ScheduleRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleRow[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.event !== "string" || row.event.trim() === "") continue;
    out.push({
      event: row.event.trim(),
      ...(typeof row.utc === "string" ? { utc: row.utc } : {}),
      ...(typeof row.et === "string" ? { et: row.et } : {}),
      ...(typeof row.consensus === "string"
        ? { consensus: row.consensus }
        : {}),
      ...(typeof row.prior === "string" ? { prior: row.prior } : {}),
      ...(typeof row.group === "string" ? { group: row.group } : {}),
    });
  }
  return out;
}

/** Earnings and overnight-macro items from the `overnight` task's own JSON —
 *  never guessed at from the regime step, which has no earnings tool.
 *  Missing task, unparseable reply, or an empty array all mean the same
 *  thing to the reader: nothing was flagged, and the renderer says so with
 *  one line rather than an absent section. Capped at five here too, not only
 *  in the prompt — a prompt is not a boundary.
 *
 *  Item shape is `{ticker?, what, why_it_matters, source}` — `what` and
 *  `why_it_matters` are required prose, `source` is the citation (a
 *  headline's timestamp, or the earnings tool), `ticker` is absent for a
 *  macro headline. Flattened here into one line per item because that is
 *  all `overnightSection`/`overnightLines` render — a struct with nowhere
 *  downstream to read its fields would be a boundary drawn for no reader. */
function overnightFrom(report: RunReport): string[] {
  const step = report.steps.find((entry) => entry.task === "overnight");
  if (step === undefined) return [];
  const parsed = extractJson(step.text);
  const raw = parsed === null ? null : parsed.overnight;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const {
      ticker,
      what,
      why_it_matters: why,
      source,
    } = entry as Record<string, unknown>;
    if (typeof what !== "string" || what.trim() === "") continue;
    let line = what.trim();
    if (typeof why === "string" && why.trim() !== "")
      line = `${line} — ${why.trim()}`;
    if (typeof ticker === "string" && ticker.trim() !== "")
      line = `${ticker.trim()} — ${line}`;
    if (typeof source === "string" && source.trim() !== "")
      line = `${line} (${source.trim()})`;
    out.push(line);
  }
  return out.slice(0, 5);
}

/**
 * The DAY is `report.day`, never a clock read in here: the runner resolves it
 * once per run in the tenant's `reportTimezone` (America/New_York), and the
 * report file name, the mail subject and the daily mail counter all carry that
 * same date. A renderer that formatted `new Date()` itself would be a fifth
 * opinion about what day it is, and near either midnight it would be a
 * different one.
 */
/**
 * Every `sections` array the run's steps returned, concatenated in task order.
 *
 * A step that answered in prose instead of JSON is not dropped silently: the
 * regime paragraph is recovered, because one disobedient model must not empty
 * the mail. Nothing else is recoverable without guessing at structure, and
 * guessing is how a model's scratch notes ("Wait, I need to double-check…",
 * seen in the 2026-09-02 report) end up quoted to the reader.
 */
/**
 * markout's per-id settlements, split into the ones the run can prove it was
 * asked to settle and the ones it invented.
 *
 * The check is the id and nothing else: an id is minted by `candidatesFrom`
 * from a report file that already went out, so an id in the ledger is an id a
 * reader was mailed. A settlement of anything else is dropped and NAMED —
 * silently dropping it would leave a reader with a shorter list and no way to
 * tell a quiet day from a broken look-back, the same reason rejected proposals
 * land in the risk list instead of vanishing.
 */
function settlementSections(
  raws: readonly unknown[],
  ledger: ReadonlySet<string>,
): Section[] {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of raws) {
    if (raw === null || typeof raw !== "object") continue;
    const { id, ticker, state, note } = raw as Record<string, unknown>;
    if (typeof id !== "string" || typeof ticker !== "string") continue;
    const line = `${id} ${ticker} ${typeof state === "string" ? state : "?"}${
      typeof note === "string" && note.trim() !== "" ? ` — ${note.trim()}` : ""
    }`;
    if (ledger.has(id)) kept.push(line);
    else dropped.push(line);
  }
  const sections: Section[] = [];
  if (kept.length > 0)
    sections.push({ title: "Settlements", body: kept.join("\n") });
  if (dropped.length > 0)
    sections.push({
      title: "Settlements not in the ledger, dropped",
      body: dropped.join("\n"),
    });
  return sections;
}

function sectionsFrom(report: RunReport, regime: RegimeView): Section[] {
  const sections: Section[] = [];
  const ledger = ledgerIds(report);
  for (const step of report.steps) {
    const parsed = extractJson(step.text);
    if (parsed !== null && Array.isArray(parsed.settlements))
      sections.push(...settlementSections(parsed.settlements, ledger));
    const raws =
      parsed !== null && Array.isArray(parsed.sections)
        ? parsed.sections
        : null;
    if (raws === null) {
      if (step.task === "regime" && regime.paragraph !== "")
        sections.push({ title: "今日 regime", body: regime.paragraph });
      continue;
    }
    for (const raw of raws) {
      if (raw === null || typeof raw !== "object") continue;
      const { title, body } = raw as Record<string, unknown>;
      if (typeof title !== "string" || typeof body !== "string") continue;
      // An empty body under a title is worse than no block at all: the reader
      // reads it as content that got lost on the way.
      if (title.trim() === "" || body.trim() === "") continue;
      sections.push({ title: title.trim(), body: body.trim() });
    }
  }
  return sections;
}

/**
 * The reviewer's surviving proposals, as the ledger a later run settles.
 *
 * Exported because `ow_reports` calls it too. That is not tidiness: the id is
 * minted here from a positional counter, so if the tool re-implemented the
 * formula the two could silently drift and a settlement would cite an id that
 * was never mailed. One function over one immutable report file means the id
 * the reader saw and the id the close run settles are the same bytes by
 * construction.
 */
/**
 * A rejection is not a silent `continue`.
 *
 * On 2026-09-02 the reviewer itself dropped eight proposals for a missing
 * `horizon` and wrote all eight into its own risk list, so the reader could see
 * why the brief was empty. A drop that happens HERE has no such author, and an
 * unexplained 今日无候选 is the one output that looks identical whether the
 * gate worked or the pipeline broke. So the gate reports its own refusals and
 * the brief prints them beside the model's.
 */
export interface Ledger {
  candidates: CandidateView[];
  rejected: Array<{ ticker: string; reason: string }>;
}

/** The date out of an `earnings` declaration, or undefined. Display only, so
 *  anything that is not a plain YYYY-MM-DD is simply not shown: printing half
 *  a declaration would read as a fact the designer never asserted.
 *
 *  A date after the expiry is not shown either. 2026-09-03 premarket: the
 *  designer wrote "none require earnings declaration", then declared META's
 *  2026-11-04 print on a 2026-09-11 spread anyway, with a risk sentence about
 *  a gap the position cannot live to see. A declaration the structure cannot
 *  be exposed to is as false as a denied one, and this is the one half of the
 *  contract the renderer can check without the tool: both dates are in the
 *  proposal. */
function earningsDate(value: unknown, expiry: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const date = (value as Record<string, unknown>).date;
  return typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(date) &&
    date <= expiry
    ? date
    : undefined;
}

/**
 * Every JSON object a tool in this run returned, parsed. The tool that produced
 * it is not recorded, so each reader below identifies its own payload by shape
 * — which is why `ledgerIds` looks for `reports[].candidates[].id` and
 * `earningsFromTools` for `rows[].nextEarningsDate` rather than for a tool
 * name. A tool result that is not JSON is skipped, not guessed at.
 */
function toolPayloads(report: RunReport): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const step of report.steps) {
    for (const raw of step.toolOutputs ?? []) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        )
          payloads.push(parsed as Record<string, unknown>);
      } catch {
        continue;
      }
    }
  }
  return payloads;
}

/**
 * The proposal ids `ow_reports` actually returned to this run.
 *
 * This is the denominator for a settlement. On 2026-09-02 the close mail
 * settled six theses that were never proposed — the model was holding a ticker
 * table and settled the ticker table. A settlement is a claim about a past
 * promise, and the only thing that makes it checkable is the list of promises
 * the run was handed.
 */
function ledgerIds(report: RunReport): Set<string> {
  const ids = new Set<string>();
  for (const payload of toolPayloads(report)) {
    if (!Array.isArray(payload.reports)) continue;
    for (const row of payload.reports) {
      if (row === null || typeof row !== "object") continue;
      const candidates = (row as Record<string, unknown>).candidates;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (candidate === null || typeof candidate !== "object") continue;
        const id = (candidate as Record<string, unknown>).id;
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

/** Next earnings date per ticker, as `ow_uw_earnings` answered it. A null date
 *  (an ETF) and a ticker the tool could not answer for are both absent here:
 *  only a date is grounds to drop anything. */
function earningsFromTools(report: RunReport): Map<string, string> {
  const dates = new Map<string, string>();
  for (const payload of toolPayloads(report)) {
    if (!Array.isArray(payload.rows)) continue;
    for (const row of payload.rows) {
      if (row === null || typeof row !== "object") continue;
      const { ticker, nextEarningsDate } = row as Record<string, unknown>;
      if (
        typeof ticker === "string" &&
        typeof nextEarningsDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(nextEarningsDate)
      )
        dates.set(ticker, nextEarningsDate);
    }
  }
  return dates;
}

/** Spot per ticker, from whichever tool priced it. Deliberately never the
 *  reviewer's prose: a model that miscopied the price would then have its
 *  strikes checked against its own mistake, which is not a check.
 *
 *  Three payload shapes answer with a spot, and reading only the first of them
 *  cost a real candidate on run-87284561: the reviewer priced SHY through
 *  ow_strike_check and never through ow_spot, so a ticker with a perfectly good
 *  tool spot rendered "无工具现货，未校验" and lost its ±% grid. `ow_spot`
 *  answers `quotes[].last`; `ow_strike_check` and `ow_uw_chain` both answer a
 *  top-level `ticker` and `spot`. Later payloads win, so the freshest quote in
 *  the run is the one the gate uses. */
function spotsFromTools(report: RunReport): Map<string, number> {
  const spots = new Map<string, number>();
  for (const payload of toolPayloads(report)) {
    const { ticker, spot } = payload;
    if (
      typeof ticker === "string" &&
      typeof spot === "number" &&
      Number.isFinite(spot)
    )
      spots.set(ticker, spot);
    if (!Array.isArray(payload.quotes)) continue;
    for (const row of payload.quotes) {
      if (row === null || typeof row !== "object") continue;
      const { ticker: symbol, last } = row as Record<string, unknown>;
      if (
        typeof symbol === "string" &&
        typeof last === "number" &&
        Number.isFinite(last)
      )
        spots.set(symbol, last);
    }
  }
  return spots;
}

/** How far a strike may sit from the tool's spot and still be a trade. 25% is
 *  wide enough for a real hedge and narrow enough to catch the two failures
 *  that shipped: a QQQ 420/410 spread with QQQ at 707, and SPY 570/580 at 765. */
const STRIKE_BAND = 0.25;

/**
 * Which leg order a structure NAME commits to, or null when it commits to none.
 *
 * "bull"/"bear" say it outright. So do the four debit/credit phrases, and only
 * those four: a debit is paid for the leg you are long, so "call debit" is long
 * the lower strike and "put debit" long the higher, with the credit forms
 * inverted. Run-87284561 named its structures "Short 30Y duration via put debit
 * spread" and "Long short-duration bonds via call debit spread" — unambiguous
 * to a reader and, before this, unrecognised by the gate.
 *
 * Separators are normalised first: a real run wrote `put_debit_spread_hedge`
 * and another wrote "via put debit spread", and a gate that only sees one of
 * those two spellings has a hole exactly where the models actually write.
 */
function declaredShape(
  name: string,
): "condor" | "bull-call" | "bear-put" | "bear-call" | "bull-put" | null {
  if (name.includes("condor")) return "condor";
  if (
    name.includes("call debit") ||
    (name.includes("bull") && name.includes("call"))
  )
    return "bull-call";
  if (
    name.includes("put debit") ||
    (name.includes("bear") && name.includes("put"))
  )
    return "bear-put";
  if (
    name.includes("call credit") ||
    (name.includes("bear") && name.includes("call"))
  )
    return "bear-call";
  if (
    name.includes("put credit") ||
    (name.includes("bull") && name.includes("put"))
  )
    return "bull-put";
  return null;
}

/**
 * Geometry, but only for a structure whose name says what the leg order should
 * be. Unrecognised means unchecked and said so, never silently passed.
 */
function geometryFaults(
  candidate: CandidateView,
  spot: number | undefined,
): { faults: string[]; unchecked: string[] } {
  const shape = declaredShape(
    candidate.strategy.toLowerCase().replace(/[_-]/gu, " "),
  );
  const faults: string[] = [];
  const strike = (right: "call" | "put", action: "buy" | "sell") =>
    candidate.legs.find((leg) => leg.right === right && leg.action === action)
      ?.strike;
  const ordered = (
    right: "call" | "put",
    label: string,
    longIsHigher: boolean,
  ): string[] => {
    const long = strike(right, "buy");
    const short = strike(right, "sell");
    if (long === undefined || short === undefined) return [];
    if (longIsHigher ? long > short : long < short) return [];
    return [
      `${label}: long ${String(long)} is not ${longIsHigher ? "above" : "below"} short ${String(short)}`,
    ];
  };
  switch (shape) {
    case "condor": {
      if (spot === undefined) return { faults, unchecked: [] };
      for (const leg of candidate.legs) {
        if (leg.right === "put" && leg.strike >= spot)
          faults.push(
            `condor put ${String(leg.strike)} is not below spot ${String(spot)}`,
          );
        if (leg.right === "call" && leg.strike <= spot)
          faults.push(
            `condor call ${String(leg.strike)} is not above spot ${String(spot)}`,
          );
      }
      return { faults, unchecked: [] };
    }
    case "bull-call":
      return {
        faults: ordered("call", "bull call spread", false),
        unchecked: [],
      };
    case "bear-put":
      return { faults: ordered("put", "bear put spread", true), unchecked: [] };
    case "bear-call":
      return {
        faults: ordered("call", "bear call spread", true),
        unchecked: [],
      };
    case "bull-put":
      return {
        faults: ordered("put", "bull put spread", false),
        unchecked: [],
      };
    default:
      return {
        faults,
        unchecked: [
          `strategy name ${candidate.strategy} not recognised; leg order not checked`,
        ],
      };
  }
}

/**
 * The arithmetic gate: comparisons and subtractions over the TOOL's numbers.
 *
 * The model declares; the harness verifies. Every fault carries the numbers it
 * was computed from, because "strikes not near spot" and "空头 put 180 已价内：
 * 现货 183.60" are the same verdict and different evidence.
 */
function arithmeticFaults(
  candidate: CandidateView,
  spot: number | undefined,
): { faults: string[]; unchecked: string[] } {
  const faults: string[] = [];
  const unchecked: string[] = [];
  // A structure that expires on the report day is not a position anyone can
  // take. An unparseable expiry is left alone: a drop rests on two real dates.
  if (candidate.dte !== null && candidate.dte < 1)
    faults.push(`expiry ${candidate.expiry} is not after the report day`);
  const shorts = candidate.legs.filter((leg) => leg.action === "sell");
  if (spot === undefined) {
    unchecked.push("no tool spot; not verified");
  } else {
    for (const leg of candidate.legs) {
      if (Math.abs(leg.strike - spot) / spot > STRIKE_BAND)
        faults.push(
          `strike ${String(leg.strike)} is more than ${String(STRIKE_BAND * 100)}% from spot ${String(spot)}`,
        );
    }
    for (const leg of shorts) {
      if (leg.right === "put" && leg.strike >= spot)
        faults.push(
          `short put ${String(leg.strike)} is already ITM: spot ${String(spot)}`,
        );
      if (leg.right === "call" && leg.strike <= spot)
        faults.push(
          `short call ${String(leg.strike)} is already ITM: spot ${String(spot)}`,
        );
    }
  }
  const geometry = geometryFaults(candidate, spot);
  faults.push(...geometry.faults);
  unchecked.push(...geometry.unchecked);
  // An entry trigger that only fires once price is PAST the short strike is a
  // trade that can never be entered on its own terms.
  const entry = candidate.entry;
  if (entry !== undefined) {
    for (const leg of shorts) {
      if (
        leg.right === "call" &&
        entry.side === "above" &&
        entry.level > leg.strike
      )
        faults.push(
          `entry trigger ${String(entry.level)}↑ is past short call ${String(leg.strike)}`,
        );
      if (
        leg.right === "put" &&
        entry.side === "below" &&
        entry.level < leg.strike
      )
        faults.push(
          `entry trigger ${String(entry.level)}↓ is past short put ${String(leg.strike)}`,
        );
    }
  }
  return { faults, unchecked };
}

export function candidatesFrom(
  reviewText: string,
  dateEtDay: string,
  /** The phase this proposal list belongs to. REQUIRED — leaving it out is
   *  exactly the 2026-09-03 defect: `design` and `review` declare
   *  `phases: [premarket, close]`, so the close run mints a FRESH list for the
   *  same ET day, and without a phase segment `QQQ-2026-09-03-1` can name one
   *  structure in the morning and a different one in the afternoon. The ledger
   *  gate checks id membership and nothing else, so such a collision passes
   *  validation and the settlement section settles the wrong structure.
   *  The index alone cannot fix this: it runs over the SURVIVING proposals, so
   *  two different lists that drop different members both start at `-1`.
   *  A default would let a future call site silently reintroduce the collision,
   *  which is why there is none. */
  phase: string,
  /** Spot per ticker as `ow_spot` ANSWERED it. The payoff grid used to be
   *  anchored on a regex over the reviewer's prose ("**SPY (spot 761.78):**"),
   *  which is the model's transcription of a tool result and was wrong in 8 of
   *  11 numbers audited on 09-02/09-03. No tool spot, no grid: the row falls
   *  back to the strikes and the header says why. */
  spots: ReadonlyMap<string, number> = new Map(),
): Ledger {
  const parsed = extractJson(reviewText);
  if (parsed === null || !Array.isArray(parsed.proposals))
    return { candidates: [], rejected: [] };

  const candidates: CandidateView[] = [];
  const rejected: Array<{ ticker: string; reason: string }> = [];
  for (const entry of parsed.proposals) {
    if (entry === null || typeof entry !== "object") continue;
    const proposal = entry as Record<string, unknown>;
    const legs = toLegs(proposal.legs);
    if (legs === null || typeof proposal.ticker !== "string") continue;
    // A thesis with no level to breach cannot be settled: the close run would
    // not know whether silence about it means "still open" or "nobody looked".
    // Refusing it here is cheaper than carrying a debt nobody can collect.
    const invalidation = toInvalidation(proposal.invalidation);
    if (invalidation === null) {
      rejected.push({
        ticker: proposal.ticker,
        reason:
          "invalidation is not a settleable level (needs level + side); dropped by the renderer",
      });
      continue;
    }
    const expiry = legs[0]!.expiry;
    const spot = spots.get(proposal.ticker);
    const days = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) -
        Date.parse(`${dateEtDay}T00:00:00Z`)) /
        86_400_000,
    );
    candidates.push({
      id: `${proposal.ticker}-${dateEtDay}-${phase}-${String(candidates.length + 1)}`,
      invalidation,
      ticker: proposal.ticker,
      strategy: typeof proposal.strategy === "string" ? proposal.strategy : "",
      expiry,
      dte: Number.isFinite(days) ? days : null,
      legs,
      // Without a quoted spot the extremes and breakevens are still exact —
      // only the +/-% row needs one, and priceStructure prints the payoff at
      // the strikes instead of inventing a price to measure from.
      pricing: priceStructure(legs, spot),
      width: width(legs),
      target: typeof proposal.target === "string" ? proposal.target : "",
      // Reuses the invalidation parser: an entry trigger is the same shape —
      // one level and the side price has to reach it from.
      ...(toInvalidation(proposal.entry)?.length === 1
        ? { entry: toInvalidation(proposal.entry)![0]! }
        : {}),
      rationale:
        typeof proposal.rationale === "string" ? proposal.rationale : "",
      ...(earningsDate(proposal.earnings, expiry) === undefined
        ? {}
        : { earnings: earningsDate(proposal.earnings, expiry) }),
    });
  }
  return { candidates, rejected };
}

/**
 * The 决策块, flattened to label/value pairs in the order the reviewer wrote
 * them. Any key whose value is not a non-empty string is dropped rather than
 * filled in: a blank 最大风险 line printed under the heading reads as "no risk"
 * to the only person who acts on it.
 */
function decisionFrom(raw: unknown): Array<{ label: string; value: string }> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(
    ([label, value]) =>
      typeof value === "string" && value.trim() !== ""
        ? [{ label, value: value.trim() }]
        : [],
  );
}

/**
 * The `edit` step's document, applied over the per-step assembly.
 *
 * WHY there is an editor at all: the brief was seven small JSON fragments
 * stitched by a template, each written by an agent that could not see the
 * others. The approved mockup was written by one author holding all the data,
 * and the gap between the two is not a template problem — it is an authorship
 * problem. The editor is that one author; this function is the seam where its
 * document wins.
 *
 * FIELD BY FIELD, and only where the editor actually wrote something usable.
 * A missing or malformed field falls back to the per-step assembly rather than
 * blanking the section: a run whose editor step was refused, timed out or
 * answered in prose still delivers the brief the pipeline already knew how to
 * build.
 *
 * `candidates` is the exception that defines the rule. The editor may rewrite
 * a `rationale` and NOTHING else on a candidate — every strike, price, width,
 * payoff point, invalidation level and id stays exactly as `candidatesFrom`
 * and `priceStructure` computed it. Eight of eleven model-written numbers
 * audited across the 2026-09-02 and 09-03 runs were wrong; an editing pass is
 * a place for prose to improve, never for arithmetic to be re-entered by hand.
 * Numeric keys on an editor candidate are dropped silently here because the
 * prompt already forbids them and a refusal would cost the reader the brief.
 */
interface EditorDoc {
  headline?: string;
  tape?: TapeItem[];
  schedule?: ScheduleRow[];
  overnight?: string[];
  sections?: Section[];
  coverage?: Section;
  decision?: Array<{ label: string; value: string }>;
  riskList?: Array<{ ticker: string; reason: string }>;
  /** id -> rationale. Prose only; every other key on the entry is ignored. */
  rationales?: Map<string, string>;
}

function sectionList(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  const out: Section[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const { title, body } = entry as Record<string, unknown>;
    if (typeof title !== "string" || typeof body !== "string") continue;
    if (title.trim() === "" || body.trim() === "") continue;
    out.push({ title: title.trim(), body: body.trim() });
  }
  return out;
}

/** Gate refusals that must NOT discard the editor's document. `flash-budget`
 *  is a MEASUREMENT: `enforceBudget` below already cuts what it complained
 *  about, so throwing the document away would cost the reader a written brief
 *  in exchange for a seven-fragment one that is also over budget. Every other
 *  refusal still discards — a step the harness could not trust is not prose it
 *  can print. */
const ADVISORY_GATES = new Set(["flash-budget"]);

function advisoryOnly(step: RunReport["steps"][number]): boolean {
  const refusals = step.gateRefusals ?? [];
  return (
    step.failure === "gate-refused" &&
    refusals.length > 0 &&
    refusals.every((refusal) => ADVISORY_GATES.has(refusal.id))
  );
}

function editorDocFrom(report: RunReport): EditorDoc | undefined {
  const step = report.steps.find((entry) => entry.task === "edit");
  if (step === undefined) return undefined;
  if (step.failure !== undefined && !advisoryOnly(step)) return undefined;
  const parsed = extractJson(step.text);
  if (parsed === null) return undefined;

  const headline =
    typeof parsed.headline === "string" && parsed.headline.trim() !== ""
      ? parsed.headline.trim()
      : undefined;
  const tape = tapeFrom(parsed.tape);
  const schedule = scheduleFrom(parsed.schedule);
  const overnight = Array.isArray(parsed.overnight)
    ? parsed.overnight
        .filter(
          (line): line is string =>
            typeof line === "string" && line.trim() !== "",
        )
        .map((line) => line.trim())
        .slice(0, 5)
    : [];
  const sections = sectionList(parsed.sections);
  const coverage = sectionList([parsed.coverage])[0];
  const decision = decisionFrom(parsed.decision);
  const riskList = Array.isArray(parsed.riskList)
    ? parsed.riskList.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        return typeof row.ticker === "string" && typeof row.reason === "string"
          ? [{ ticker: row.ticker, reason: row.reason }]
          : [];
      })
    : [];
  const rationales = new Map<string, string>();
  if (Array.isArray(parsed.candidates)) {
    for (const entry of parsed.candidates) {
      if (entry === null || typeof entry !== "object") continue;
      const { id, rationale } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof rationale !== "string") continue;
      if (rationale.trim() === "") continue;
      rationales.set(id, rationale.trim());
      // The minted id is `<TICKER>-<day>-<n>` and the editor never sees one —
      // it reads the reviewer's proposals, which carry no id by design. The
      // 2026-09-03 run keyed its three rationales "SPY", "QQQ" and "IWM", and
      // all three were dropped on an exact-id miss. The prompt now spells the
      // format out; this keeps a bare ticker working too, and `applyEditor`
      // consults it only when the id missed AND the ticker is unique among
      // the cards.
      const ticker = id.split("-")[0];
      if (ticker !== undefined && ticker !== "")
        rationales.set(`ticker:${ticker}`, rationale.trim());
    }
  }

  return {
    ...(headline === undefined ? {} : { headline }),
    ...(tape.length === 0 ? {} : { tape }),
    ...(schedule.length === 0 ? {} : { schedule }),
    ...(overnight.length === 0 ? {} : { overnight }),
    ...(sections.length === 0 ? {} : { sections }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(decision.length === 0 ? {} : { decision }),
    ...(riskList.length === 0 ? {} : { riskList }),
    ...(rationales.size === 0 ? {} : { rationales }),
  };
}

/** The editor's document laid over the assembled view. Nothing numeric moves. */
function applyEditor(view: BriefView, doc: EditorDoc | undefined): BriefView {
  if (doc === undefined) return view;
  return {
    ...view,
    edited: true,
    ...(doc.headline === undefined ? {} : { headline: doc.headline }),
    ...(doc.tape === undefined ? {} : { tape: doc.tape }),
    ...(doc.schedule === undefined ? {} : { schedule: doc.schedule }),
    ...(doc.overnight === undefined ? {} : { overnight: doc.overnight }),
    ...(doc.sections === undefined ? {} : { sections: doc.sections }),
    ...(doc.coverage === undefined ? {} : { coverage: doc.coverage }),
    ...(doc.decision === undefined ? {} : { decision: doc.decision }),
    ...(doc.riskList === undefined ? {} : { riskList: doc.riskList }),
    candidates:
      doc.rationales === undefined
        ? view.candidates
        : view.candidates.map((candidate) => {
            // Ambiguity loses: two cards on one ticker mean a bare-ticker key
            // cannot say which rationale belongs to which, and the reviewer's
            // own words beat the wrong editor sentence.
            const unique =
              view.candidates.filter((row) => row.ticker === candidate.ticker)
                .length === 1;
            const rationale =
              doc.rationales!.get(candidate.id) ??
              (unique
                ? doc.rationales!.get(`ticker:${candidate.ticker}`)
                : undefined);
            return rationale === undefined
              ? candidate
              : { ...candidate, rationale };
          }),
  };
}

/**
 * The per-step assembly: seven agents' fragments stitched into one view.
 *
 * Still the fallback path, and still the only path on a run with no `edit`
 * step — an intraday run, a close run, a premarket run whose editor was gated
 * or timed out. `buildView` below is what the renderer calls.
 */
function assembleView(report: RunReport, cfg: TenantSpec): BriefView {
  const dateEtDay = report.day;
  const degradation = degradationFrom(report);

  // Resolved before the failure branch: a failed run still renders the steps
  // that finished, and the regime paragraph is the prose fallback for a step
  // that answered outside JSON. The regime step's own JSON is also where the
  // masthead headline, the tape strip and the day's schedule come from.
  const regimeStep = report.steps.find((step) => step.task === "regime");
  const regime =
    regimeStep === undefined ? { paragraph: "" } : regimeFrom(regimeStep.text);
  const regimeJson =
    regimeStep === undefined ? null : extractJson(regimeStep.text);

  // Every phase's content, resolved before any early return. Only premarket
  // and close carry a review step; intraday reports drift, weekly settles a
  // week and frank compares two documents. Treating "has candidates" as a
  // synonym for "has content" emptied three of the five briefs.
  const rawSections = sectionsFrom(report, regime);
  // The Layer Coverage block is pulled out so "data coverage (compact)" can
  // always render last, regardless of which task actually produced it.
  const coverageIdx = rawSections.findIndex((entry) =>
    /layer coverage/iu.test(entry.title),
  );
  const coverage = coverageIdx === -1 ? undefined : rawSections[coverageIdx];
  const sections =
    coverageIdx === -1
      ? rawSections
      : rawSections.filter((_entry, index) => index !== coverageIdx);

  const base: BriefView = {
    schemaVersion: BRIEF_VIEW_SCHEMA_VERSION,
    date: dateEtDay,
    tenant: cfg.tenant,
    outcome:
      report.outcome === "failed"
        ? "FAILED"
        : report.mode === "tool-only"
          ? "DEGRADED"
          : "completed",
    headline: headlineFrom(regimeJson) ?? "",
    tape: tapeFrom(regimeJson?.tape),
    schedule: scheduleFrom(regimeJson?.schedule),
    overnight: overnightFrom(report),
    sections: [],
    ...(coverage === undefined ? {} : { coverage }),
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
    // Filled by `buildView`, which knows which tickers reached a card.
    charts: { gex: [] },
    ...(degradation === undefined ? {} : { degradation }),
  };

  if (report.outcome === "failed") {
    const failure = report.failure;
    const detail = `${failure?.class ?? "unknown"} — ${failure?.detail ?? ""}`;
    const done = sections;
    // A run that failed one step out of four still did three steps' work, and
    // throwing it away is the same single-point failure the tenant is under
    // orders not to have: on 2026-09-02 a stale IB timestamp refused the
    // regime gate and voided an intraday brief whose drift step had already
    // answered the only question that brief exists to answer.
    if (done.length === 0)
      return { ...base, empty: `No candidates today: ${detail}` };
    return {
      ...base,
      sections: [{ title: "This run did not finish", body: detail }, ...done],
    };
  }
  if (report.mode === "tool-only") {
    return {
      ...base,
      empty:
        "No candidates today: no provider available, no model reasoning ran",
    };
  }

  const review = report.steps.find((step) => step.task === "review");
  const parsed = review === undefined ? null : extractJson(review.text);
  // Resolved before every early return below. The block matters MOST on the
  // day nothing survived: "no candidates today" alone does not tell the
  // reader whether to sit still or to cut, and the reviewer already wrote
  // which it is.
  const rows = decisionFrom(parsed === null ? null : parsed.decision);
  const decision = rows.length === 0 ? {} : { decision: rows };
  if (parsed === null || !Array.isArray(parsed.proposals)) {
    if (sections.length > 0) return { ...base, ...decision, sections, regime };
    return {
      ...base,
      ...decision,
      empty:
        review === undefined
          ? "This run produced no blocks"
          : "No candidates today: the review step had no parseable JSON",
    };
  }

  const toolSpots = spotsFromTools(report);
  const { candidates, rejected } = candidatesFrom(
    review?.text ?? "",
    dateEtDay,
    report.phase,
    toolSpots,
  );

  const riskList = Array.isArray(parsed.riskList)
    ? parsed.riskList.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        return typeof row.ticker === "string" && typeof row.reason === "string"
          ? [{ ticker: row.ticker, reason: row.reason }]
          : [];
      })
    : [];
  riskList.push(...rejected);

  // A structure that expires AFTER the next earnings print carries an event the
  // designer may not have priced. The declaration on the proposal is the
  // model's own word for it; this is the tool's. An expiry that is not a plain
  // date is left alone — a drop has to rest on two real dates, never on a
  // parse that failed.
  const earnings = earningsFromTools(report);
  const survived = candidates.filter((candidate) => {
    const when = earnings.get(candidate.ticker);
    if (when === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.expiry))
      return true;
    if (when > candidate.expiry) return true;
    riskList.push({
      ticker: candidate.ticker,
      reason: `earnings ${when} is before expiry ${candidate.expiry}`,
    });
    return false;
  });

  // The arithmetic gate. It runs on what the TOOLS answered, so it can only
  // judge a ticker ow_spot actually priced; a candidate it could not judge is
  // carried with the reason it could not, never as a quiet pass.
  const checked: CandidateView[] = [];
  for (const candidate of survived) {
    const spot = toolSpots.get(candidate.ticker);
    const verdict = arithmeticFaults(candidate, spot);
    if (verdict.faults.length > 0) {
      riskList.push({
        ticker: candidate.ticker,
        reason: verdict.faults.join("; "),
      });
      continue;
    }
    checked.push({
      ...candidate,
      ...(spot === undefined ? {} : { spot }),
      ...(verdict.unchecked.length === 0
        ? {}
        : { unchecked: verdict.unchecked.join("; ") }),
    });
  }

  if (checked.length === 0 && riskList.length === 0) {
    if (sections.length > 0) return { ...base, ...decision, sections, regime };
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason
        : "the reviewer gave no candidates";
    return { ...base, ...decision, empty: `No candidates today: ${reason}` };
  }
  // At most five reach the reader; the reviewer's own rule, enforced here too.
  return {
    ...base,
    ...decision,
    sections,
    regime,
    candidates: checked.slice(0, 5),
    riskList,
  };
}

/**
 * The view the renderer draws: the per-step assembly, the editor's document
 * laid over it, and the charts drawn from the raw tool outputs underneath
 * both.
 *
 * Order matters. Charts are computed LAST and from `toolPayloads` alone, so no
 * arrangement of editor fields can reach them: an editor that renamed a
 * candidate's ticker would move which profile is shown and could not touch a
 * single number inside it.
 */
/** Deterministic trim to `FLASH_BUDGET`. Sections beyond the fifth are
 *  DROPPED, not merged — merging would invent a paragraph no author wrote.
 *  Bodies, the headline, decision values and rationales are cut by `trim`
 *  (last sentence end inside the budget; word cut with "…" only when the
 *  first sentence alone is over). `coverage` is exempt: it is the as-of table
 *  the `as-of-verbatim` gate protects, and a trim there would delete
 *  evidence to save words. Runs after `applyEditor` so the editor's prose is
 *  what gets measured, and before charts, which it cannot touch. */
function enforceBudget(view: BriefView): BriefView {
  const cut = (text: string, max: number): string => trim(text, max).text;
  return {
    ...view,
    headline: cut(view.headline, FLASH_BUDGET.headlineWords),
    sections: view.sections.slice(0, FLASH_BUDGET.sectionCount).map((s) => ({
      ...s,
      body: cut(s.body, FLASH_BUDGET.sectionBodyWords),
    })),
    ...(view.decision === undefined
      ? {}
      : {
          decision: view.decision.map((row) => ({
            ...row,
            value: cut(row.value, FLASH_BUDGET.decisionValueWords),
          })),
        }),
    candidates: view.candidates.map((c) => ({
      ...c,
      rationale: cut(c.rationale, FLASH_BUDGET.rationaleWords),
    })),
  };
}

export function buildView(report: RunReport, cfg: TenantSpec): BriefView {
  const view = enforceBudget(
    applyEditor(assembleView(report, cfg), editorDocFrom(report)),
  );
  // The two fields the mail's Flash link is built from. `ARGON_APP_BASE` is
  // read here, once, rather than inside the renderer: the html and text parts
  // must link to the same page, and a second read is a second chance to
  // disagree. An unset variable is not an error — it is a machine with no
  // Flash page, and the mail simply carries no link.
  const appBase = (process.env.ARGON_APP_BASE ?? "").trim();
  const runLabel = report.phase;
  return {
    ...view,
    ...(runLabel === undefined ? {} : { runLabel }),
    ...(appBase === "" ? {} : { appBase }),
    charts: chartsFrom(
      toolPayloads(report),
      view.candidates.map((candidate) => candidate.ticker),
    ),
  };
}

export default function renderReport(
  report: RunReport,
  cfg: TenantSpec,
): RenderedReport {
  const view = buildView(report, cfg);
  // NO SUBJECT. The renderer does not know the phase — render.spec.ts forbids
  // it naming one — so every subject it could mint reads `option-wizard
  // 2026-09-03`, and the day's five mails arrive indistinguishable. The runner
  // already builds `[TEST] intraday 2026-09-03`; omitting the field is how the
  // channel gets to use it.
  return {
    text: renderText(view),
    html: renderHtml(view),
    // The same document the prose was rendered FROM, for a channel that stores
    // the data instead of mailing the rendering. Core never reads inside it.
    data: view as unknown as Record<string, unknown>,
  };
}
