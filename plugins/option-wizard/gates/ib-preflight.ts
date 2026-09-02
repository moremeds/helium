/**
 * The preflight gate: five sub-gates over one proposal, run as an output gate
 * on the two roles that can emit a proposal (spec §4).
 *
 * Two deliberate divergences from the spec, both by the orchestrator's
 * decision, both recorded here because the spec text still says otherwise:
 *
 * 1. **No gate record file.** Spec §4 writes `${OW_GATE_DIR}/gates/<hash>.json`
 *    and re-reads it in `validate()`. Sandbox kind `none` has zero write roots
 *    (spec §5, and §8 open question 6 admits the contradiction), so the file
 *    can never be written. The audited `gate:ib-preflight` span the runner
 *    already appends IS the record; `contentHash` travels in the reason string,
 *    which keeps the tamper-evidence the hash buys at the cost of one sha256.
 *    Deleting the file resolves the contradiction by deletion (doctrine 6).
 * 2. **Four of the five sub-gates can only refuse today.** Their numeric limits
 *    were lost with the original spec (§8.4, §9) and IB Gateway speaks a wire
 *    protocol this tenant does not implement. An unconfigured risk limit is a
 *    refusal, never a pass — the same fail-closed rule `runGates` applies to a
 *    gate that throws.
 * @module dsh-plugin-tenant-option-wizard/gates/ib-preflight
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseTenantYaml, type Gate, type GateCtx } from "@helium/core";

const LegSchema = z.object({
  right: z.enum(["C", "P"]),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  strike: z.number().positive(),
  action: z.enum(["BUY", "SELL"]),
  ratio: z.number().int().positive(),
});

/** Spec §4. `.object` (not `.strictObject`) so a model's extra prose field is
 *  stripped rather than fatal — but the stripped object is what gets hashed,
 *  so the hash is over exactly what the gate judged. */
export const ProposalSchema = z.object({
  ticker: z.string().min(1),
  strategy: z.string().min(1),
  legs: z.array(LegSchema),
  quantity: z.number().int().positive(),
  limitPrice: z.number(),
  rationale: z.string(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export interface SubGate {
  pass: boolean;
  detail: string;
}

export type GateId =
  | "defined_risk"
  | "buying_power"
  | "liquidity"
  | "event_window"
  | "position_conflict";

export interface PreflightResult {
  contentHash: string;
  gates: Record<GateId, SubGate>;
  pass: boolean;
}

/** One option contract covers 100 shares. Not configurable: it is a fact about
 *  US listed equity options, not a policy knob. */
const CONTRACT_MULTIPLIER = 100;

/**
 * RFC-8785-flavoured canonicalisation: keys sorted, no whitespace. Only what
 * `JSON.stringify` already guarantees for numbers and strings is relied on —
 * the proposal schema admits no `undefined`, no `NaN` and no cycles.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

export function contentHash(proposal: unknown): string {
  return createHash("sha256").update(canonicalJson(proposal), "utf8").digest("hex");
}

/**
 * Sub-gate 1 — the only one that is fully computable today, and the fatal one.
 *
 * Coverage rule: a short leg is covered only by a long leg of the SAME right
 * AND THE SAME EXPIRY, in at least equal ratio. A calendar or diagonal — short
 * near-dated, long far-dated — therefore FAILS. That is not an oversight: at
 * the short leg's expiry the long leg's value is a model output, not an
 * arithmetic one, so max loss is not "computable from the legs alone" (spec §4
 * gate 1). The gate refuses what it cannot compute rather than guessing a vol
 * surface.
 *
 * Held stock is likewise not counted as cover: it lives in the IB account, and
 * account state is unreachable (see the module header). A covered call that
 * really is covered fails here today, which is the fail-closed direction.
 */
export function checkDefinedRisk(proposal: Proposal): SubGate {
  const { legs, quantity, limitPrice } = proposal;
  if (legs.length === 0) {
    return { pass: false, detail: "no legs; max loss is not computable" };
  }

  const byExpiry = new Map<string, Proposal["legs"]>();
  for (const leg of legs) {
    const group = byExpiry.get(leg.expiry) ?? [];
    group.push(leg);
    byExpiry.set(leg.expiry, group);
  }

  let intrinsicLoss = 0;
  for (const [expiry, group] of [...byExpiry.entries()].sort()) {
    for (const right of ["C", "P"] as const) {
      const sameRight = group.filter((leg) => leg.right === right);
      const shortRatio = sum(sameRight.filter((l) => l.action === "SELL").map((l) => l.ratio));
      const longRatio = sum(sameRight.filter((l) => l.action === "BUY").map((l) => l.ratio));
      if (shortRatio > longRatio) {
        return {
          pass: false,
          detail:
            `uncovered short ${right === "C" ? "call" : "put"} at ${expiry}: ` +
            `short ratio ${shortRatio} exceeds long ratio ${longRatio} of the same ` +
            `right and expiry — max loss is unbounded or margin-leveraged`,
        };
      }
    }

    // Expiry payoff is piecewise linear in the underlying, so its minimum sits
    // at a strike or at an endpoint. `2 * maxStrike` stands in for "far above
    // every strike": with the ratio check above the slope there is >= 0, and
    // the explicit comparison below is what proves it rather than assuming it.
    const strikes = group.map((leg) => leg.strike);
    const far = Math.max(...strikes) * 2;
    const probes = [0, ...strikes, far];
    const values = probes.map((price) => expiryValue(group, price));
    if (expiryValue(group, far) < expiryValue(group, Math.max(...strikes))) {
      return {
        pass: false,
        detail: `payoff at ${expiry} still falls above the highest strike; max loss is unbounded`,
      };
    }
    intrinsicLoss += Math.max(0, -Math.min(...values));
  }

  // limitPrice is a net debit (+) / credit (-) per spread per share (spec §4).
  const maxLoss = (intrinsicLoss + limitPrice) * CONTRACT_MULTIPLIER * quantity;
  if (!Number.isFinite(maxLoss)) {
    return { pass: false, detail: "max loss did not evaluate to a finite number" };
  }
  return {
    pass: true,
    detail: `max loss ${maxLoss.toFixed(2)} USD over ${quantity} spread(s), computable from the legs alone`,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Net intrinsic value of one expiry group at `price`, per share, longs positive. */
function expiryValue(legs: Proposal["legs"], price: number): number {
  return legs.reduce((total, leg) => {
    const intrinsic =
      leg.right === "C" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
    return total + (leg.action === "BUY" ? 1 : -1) * leg.ratio * intrinsic;
  }, 0);
}

/**
 * The tenant's opaque `extensions:` block, keyed by sub-gate id. The host never
 * reads inside it (design §3), so the gate does: it walks up from its own file
 * to the tenant dir and parses `tenant.yaml` with core's own parser.
 *
 * ponytail: read once per process, no watcher, no schema for the block. A
 * tenant.yaml edit needs a restart — which is what a cron-driven tenant gets
 * anyway. Upgrade path if that ever bites: pass the spec into the gate at load
 * time, which means one new argument in `loadGates`.
 */
export type GateThresholds = Record<string, Record<string, unknown>>;

export function readThresholds(tenantDir: string): GateThresholds {
  const file = join(tenantDir, "tenant.yaml");
  if (!existsSync(file)) return {};
  const spec = parseTenantYaml(readFileSync(file, "utf8"), file);
  const block = spec.extensions.gates;
  return block !== null && typeof block === "object" ? (block as GateThresholds) : {};
}

function findTenantDir(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, "tenant.yaml"))) return dir;
    dir = dirname(dir);
  }
  return from;
}

/**
 * A limit that is absent is a refusal naming the key an operator must set. It
 * is never a pass and never a default: a fabricated threshold is a fabricated
 * risk limit.
 */
function requireNumbers(
  thresholds: GateThresholds,
  gate: GateId,
  keys: string[],
): string | null {
  const block = thresholds[gate] ?? {};
  const missing = keys.filter((key) => typeof block[key] !== "number");
  if (missing.length === 0) return null;
  return missing.map((key) => `extensions.gates.${gate}.${key}`).join(", ");
}

/**
 * What the four live sub-gates are still missing beyond configuration. IB
 * Gateway is reachable over TCP at best; nobody here speaks the TWS wire
 * protocol, so quotes, margin impact and open positions cannot be fetched.
 * See the same ponytail note in `tools/index.ts`.
 */
const NO_IB_DATA =
  "IB Gateway account and quote data unavailable: the TWS wire protocol is not implemented";

export function evaluateProposal(
  proposal: Proposal,
  thresholds: GateThresholds,
): PreflightResult {
  const definedRisk = checkDefinedRisk(proposal);

  const live = (gate: GateId, keys: string[], detail: string): SubGate => {
    const missing = requireNumbers(thresholds, gate, keys);
    if (missing !== null) {
      return { pass: false, detail: `unconfigured risk limit: ${missing}` };
    }
    return { pass: false, detail: `${detail}: ${NO_IB_DATA}` };
  };

  const gates: Record<GateId, SubGate> = {
    defined_risk: definedRisk,
    buying_power: live(
      "buying_power",
      ["maxMarginFractionOfNetLiq", "minBuyingPowerUsd"],
      "margin impact not measured",
    ),
    liquidity: live(
      "liquidity",
      ["maxSpreadFractionOfMid", "minOpenInterest"],
      "no leg quoted",
    ),
    event_window: live("event_window", ["minDte", "maxDte"], "expiry calendar not fetched"),
    position_conflict: live(
      "position_conflict",
      ["maxPerUnderlyingFractionOfNetLiq", "maxPortfolioFractionOfNetLiq"],
      "open positions not fetched",
    ),
  };

  return {
    contentHash: contentHash(proposal),
    gates,
    pass: Object.values(gates).every((sub) => sub.pass),
  };
}

/**
 * A model told to answer with JSON and nothing else will still fence it about
 * half the time, and refusing that is refusing on presentation rather than on
 * risk — the one thing this gate must never do. Only a fence is stripped:
 * prose around the JSON stays a refusal, because it means the role did
 * something other than what it was asked.
 */
export function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\r?\n?/, "");
  return withoutOpen.replace(/\r?\n?```$/, "").trim();
}

/**
 * Output-gate input is whatever the role produced. A proposal that cannot be
 * parsed out of it is a refusal, not a skip: an unreadable proposal is
 * indistinguishable from an unsafe one.
 */
export function extractProposals(input: unknown): { proposals: unknown[]; error?: string } {
  let candidate: unknown = input;
  if (candidate !== null && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    if (record.structured !== undefined) candidate = record.structured;
    else if (typeof record.text === "string") {
      try {
        candidate = JSON.parse(unfence(record.text));
      } catch {
        return { proposals: [], error: "role output is not JSON" };
      }
    }
  }
  if (Array.isArray(candidate)) return { proposals: candidate };
  if (candidate !== null && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.proposals)) return { proposals: record.proposals };
    if (record.legs !== undefined) return { proposals: [candidate] };
  }
  return { proposals: [], error: "no proposal found in role output" };
}

const TENANT_DIR = findTenantDir(dirname(fileURLToPath(import.meta.url)));

/** The tenant's own `extensions.gates` block, resolved from this file's
 *  location so tools and the gate cannot disagree about which file they read. */
export function tenantThresholds(): GateThresholds {
  return readThresholds(TENANT_DIR);
}

const gate: Gate = {
  id: "ib-preflight",
  phase: "output",
  appliesTo: ["structure-designer", "risk-reviewer"],
  async check(input: unknown, _ctx: GateCtx): Promise<{ pass: boolean; reason: string }> {
    const extracted = extractProposals(input);
    if (extracted.error !== undefined) {
      return { pass: false, reason: extracted.error };
    }
    if (extracted.proposals.length === 0) {
      return { pass: false, reason: "role produced an empty proposal list" };
    }
    const thresholds = readThresholds(TENANT_DIR);
    const lines: string[] = [];
    let allPass = true;
    for (const raw of extracted.proposals) {
      const parsed = ProposalSchema.safeParse(raw);
      if (!parsed.success) {
        allPass = false;
        lines.push(
          `malformed proposal: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
        continue;
      }
      const result = evaluateProposal(parsed.data, thresholds);
      if (!result.pass) allPass = false;
      const failing = (Object.entries(result.gates) as Array<[GateId, SubGate]>)
        .filter(([, sub]) => !sub.pass)
        .map(([id, sub]) => `${id}: ${sub.detail}`);
      lines.push(
        `${parsed.data.ticker} ${parsed.data.strategy} ${result.contentHash} ` +
          (result.pass ? "PASS" : `FAIL — ${failing.join(" | ")}`),
      );
    }
    return { pass: allPass, reason: lines.join("\n") };
  },
};

export default gate;
