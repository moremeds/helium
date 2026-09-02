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

export interface CandidateView {
  ticker: string;
  strategy: string;
  expiry: string;
  /** Calendar days to expiry against the ET date; null when unparseable. */
  dte: number | null;
  legs: Leg[];
  /** The price the +/-% row is measured from, and whether it is a real spot.
   *  Without this the reader reads "-20%" as 20% below spot when the reviewer
   *  never quoted one; the row would be arithmetic off an unstated anchor. */
  anchor: { price: number; quoted: boolean };
  pricing: Pricing;
  /** Widest strike span, per share; 0 when single-strike. */
  width: number;
  rationale: string;
}

export interface RegimeView {
  paragraph: string;
  direction?: string;
  volatility?: string;
  hedge?: string;
}

export interface BriefView {
  dateHkt: string;
  dateEt: string;
  tenant: string;
  outcome: "completed" | "DEGRADED" | "FAILED";
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

function dayIn(zone: string, now: Date): string {
  // en-CA gives YYYY-MM-DD, which is the only reason that locale is named here.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

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

export function buildView(
  report: RunReport,
  cfg: TenantSpec,
  now: Date,
): BriefView {
  const dateEtDay = dayIn("America/New_York", now);
  const degradation = degradationFrom(report);
  const base: BriefView = {
    dateHkt: `${dayIn("Asia/Hong_Kong", now)} (HKT)`,
    dateEt: `${dateEtDay} (ET)`,
    tenant: cfg.tenant,
    outcome:
      report.outcome === "failed"
        ? "FAILED"
        : report.mode === "tool-only"
          ? "DEGRADED"
          : "completed",
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
    ...(degradation === undefined ? {} : { degradation }),
  };

  if (report.outcome === "failed") {
    const failure = report.failure;
    return {
      ...base,
      empty: `今日无候选：${failure?.class ?? "unknown"} — ${failure?.detail ?? ""}`,
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
    return { ...base, empty: "今日无候选：review 步骤没有可解析的 JSON" };
  }

  const regimeStep = report.steps.find((step) => step.task === "regime");
  const regime =
    regimeStep === undefined ? { paragraph: "" } : regimeFrom(regimeStep.text);
  const spots = spotsFrom(review?.text ?? "");

  const candidates: CandidateView[] = [];
  for (const entry of parsed.proposals) {
    if (entry === null || typeof entry !== "object") continue;
    const proposal = entry as Record<string, unknown>;
    const legs = toLegs(proposal.legs);
    if (legs === null || typeof proposal.ticker !== "string") continue;
    const expiry = legs[0]!.expiry;
    const spot = spots.get(proposal.ticker);
    const days = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) -
        Date.parse(`${dateEtDay}T00:00:00Z`)) /
        86_400_000,
    );
    candidates.push({
      ticker: proposal.ticker,
      strategy: typeof proposal.strategy === "string" ? proposal.strategy : "",
      expiry,
      dte: Number.isFinite(days) ? days : null,
      legs,
      anchor: {
        price: spot ?? Math.min(...legs.map((leg) => leg.strike)),
        quoted: spot !== undefined,
      },
      // Without a quoted spot the payoff extremes and breakevens are still
      // exact — only the +/-% row needs one, so it is anchored on the lowest
      // strike rather than on an invented price.
      pricing: priceStructure(
        legs,
        spot ?? Math.min(...legs.map((leg) => leg.strike)),
      ),
      width: width(legs),
      rationale:
        typeof proposal.rationale === "string" ? proposal.rationale : "",
    });
  }

  const riskList = Array.isArray(parsed.riskList)
    ? parsed.riskList.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        return typeof row.ticker === "string" && typeof row.reason === "string"
          ? [{ ticker: row.ticker, reason: row.reason }]
          : [];
      })
    : [];

  if (candidates.length === 0 && riskList.length === 0) {
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "reviewer 未给出候选";
    return { ...base, empty: `今日无候选：${reason}` };
  }
  // At most five reach the reader; the reviewer's own rule, enforced here too.
  return { ...base, regime, candidates: candidates.slice(0, 5), riskList };
}

export default function renderReport(
  report: RunReport,
  cfg: TenantSpec,
): RenderedReport {
  const view = buildView(report, cfg, new Date());
  const tag = view.outcome === "completed" ? "" : ` [${view.outcome}]`;
  return {
    subject: `${view.tenant} ${view.dateHkt.slice(0, 10)}${tag}`,
    text: renderText(view),
    html: renderHtml(view),
  };
}
