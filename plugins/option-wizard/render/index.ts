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
import { renderHtml } from "./html.js";
import { renderText } from "./text.js";

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

export interface BriefView {
  /** `yyyy-mm-dd` — the run's report day, ET. ONE date, one zone: a brief that
   *  printed the HK date beside the ET one made the reader do the conversion
   *  the harness had already done. */
  date: string;
  tenant: string;
  outcome: "completed" | "DEGRADED" | "FAILED";
  /** The narrative blocks the run actually produced, in task order.
   *
   *  The renderer does not know what a phase is, and must not learn: which
   *  blocks exist is the team manifest's business. A premarket run returns
   *  its four regime sections and four scenario paths; an intraday run
   *  returns one "无变化" line. Both render through the same loop because
   *  both are just a list. */
  sections: Section[];
  regime: RegimeView;
  candidates: CandidateView[];
  riskList: Array<{ ticker: string; reason: string }>;
  /** ONE line, present only when something actually failed. */
  degradation?: string;
  /** When set, the brief IS this line: no candidates, no sections. */
  empty?: string;
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
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
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

/** Spot as the reviewer quoted it, e.g. "**SPY (spot 761.78):**". */
function spotsFrom(text: string): Map<string, number> {
  const spots = new Map<string, number>();
  for (const match of text.matchAll(
    /([A-Z]{1,6})\s*\(spot\s+([0-9]+(?:\.[0-9]+)?)\)/g,
  )) {
    spots.set(match[1]!, Number(match[2]));
  }
  return spots;
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
      (skip) => `provider ${skip.id} 不可用（${skip.reason}）`,
    ),
    ...report.gatesSkipped.map(
      (skip) => `gate ${skip.id} 未加载（${skip.reason}）`,
    ),
    ...report.steps
      .flatMap((step) => step.gateRefusals ?? [])
      .map((refusal) => `gate ${refusal.id} 拒绝（${refusal.reason}）`),
    ...report.steps
      .filter((step) => step.failure !== undefined)
      .map((step) => `${step.task} 步骤失败（${step.failure ?? ""}）`),
  ];
  // `toolsUnconfigured` is NOT here. It is a known false positive today and its
  // root fix belongs to sub-project B; printing it would train the reader to
  // ignore the one line that is supposed to mean something.
  return parts.length === 0 ? undefined : `数据降级：${parts.join("；")}`;
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
    sections.push({ title: "结算", body: kept.join("\n") });
  if (dropped.length > 0)
    sections.push({
      title: "未在账本中的结算，已剔除",
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
    const raws = parsed !== null && Array.isArray(parsed.sections) ? parsed.sections : null;
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
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
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

export function candidatesFrom(reviewText: string, dateEtDay: string): Ledger {
  const parsed = extractJson(reviewText);
  if (parsed === null || !Array.isArray(parsed.proposals))
    return { candidates: [], rejected: [] };
  const spots = spotsFrom(reviewText);

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
        reason: "失效价不是可结算的价位（需要 level + side），渲染层丢弃",
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
      id: `${proposal.ticker}-${dateEtDay}-${String(candidates.length + 1)}`,
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
      rationale:
        typeof proposal.rationale === "string" ? proposal.rationale : "",
      ...(earningsDate(proposal.earnings, expiry) === undefined
        ? {}
        : { earnings: earningsDate(proposal.earnings, expiry) }),
    });
  }
  return { candidates, rejected };
}

export function buildView(report: RunReport, cfg: TenantSpec): BriefView {
  const dateEtDay = report.day;
  const degradation = degradationFrom(report);
  const base: BriefView = {
    date: dateEtDay,
    tenant: cfg.tenant,
    outcome:
      report.outcome === "failed"
        ? "FAILED"
        : report.mode === "tool-only"
          ? "DEGRADED"
          : "completed",
    sections: [],
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
    ...(degradation === undefined ? {} : { degradation }),
  };

  // Resolved before the failure branch: a failed run still renders the steps
  // that finished, and the regime paragraph is the prose fallback for a step
  // that answered outside JSON.
  const regimeStep = report.steps.find((step) => step.task === "regime");
  const regime =
    regimeStep === undefined ? { paragraph: "" } : regimeFrom(regimeStep.text);

  // Every phase's content, resolved before any early return. Only premarket
  // and close carry a review step; intraday reports drift, weekly settles a
  // week and frank compares two documents. Treating "has candidates" as a
  // synonym for "has content" emptied three of the five briefs.
  const sections = sectionsFrom(report, regime);

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
      return { ...base, empty: `今日无候选：${detail}` };
    return {
      ...base,
      sections: [{ title: "本次运行未完成", body: detail }, ...done],
    };
  }
  if (report.mode === "tool-only") {
    return {
      ...base,
      empty: "今日无候选：无可用 provider，本次没有任何模型推理",
    };
  }

  const review = report.steps.find((step) => step.task === "review");
  const parsed = review === undefined ? null : extractJson(review.text);
  if (parsed === null || !Array.isArray(parsed.proposals)) {
    if (sections.length > 0) return { ...base, sections, regime };
    return {
      ...base,
      empty:
        review === undefined
          ? "本次运行没有产出任何区块"
          : "今日无候选：review 步骤没有可解析的 JSON",
    };
  }

  const { candidates, rejected } = candidatesFrom(review?.text ?? "", dateEtDay);

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
      reason: `财报 ${when} 在到期日 ${candidate.expiry} 之前`,
    });
    return false;
  });

  if (survived.length === 0 && riskList.length === 0) {
    if (sections.length > 0) return { ...base, sections, regime };
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "reviewer 未给出候选";
    return { ...base, empty: `今日无候选：${reason}` };
  }
  // At most five reach the reader; the reviewer's own rule, enforced here too.
  return {
    ...base,
    sections,
    regime,
    candidates: survived.slice(0, 5),
    riskList,
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
  };
}
