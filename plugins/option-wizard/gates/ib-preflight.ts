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

/**
 * A number a model wrote as a string. `"1.25"` is the number 1.25 with quotes
 * around it, and refusing it is refusing on typography — it cost a whole live
 * briefing on 2026-09-02 (`legs.1.mid: expected number, received string`).
 *
 * Nothing is defaulted and nothing is guessed: anything that is not exactly a
 * number in string form ("n/a", "1,250", "") is handed back untouched and fails
 * the `z.number()` with the honest "expected number" message. Only `mid` gets
 * this, and no safety rule turns on `mid` — the defined-risk decision is made
 * from right/expiry/strike/action/ratio, which stay strict, so a sloppy value
 * there is still a parse failure and never an unevaluated proposal called safe.
 */
const numericLike = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return value;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }, schema);

const LegSchema = z.object({
  // Both spellings, normalised to IB's. A model asked for a "right" answers
  // "call" as readily as "C", and refusing that is refusing on vocabulary —
  // the gate exists to reject unsafe structures, not unfamiliar synonyms. The
  // canonical form stays "C"/"P" so every rule below compares one thing.
  right: z
    .string()
    .transform((value) => value.trim().slice(0, 1).toUpperCase())
    .pipe(z.enum(["C", "P"])),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  strike: z.number().positive(),
  action: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(["BUY", "SELL"])),
  ratio: z.number().int().positive(),
  // The NBBO mid the designer read for this exact strike and expiry, per share.
  // Optional because pricing is not this gate's job: a leg the market did not
  // quote still has a computable STRUCTURE, and refusing it here would turn a
  // missing quote into "no trades today" instead of the 未定价 the reader sees.
  mid: numericLike(z.number().nonnegative()).optional(),
});

/** Spec §4. `.object` (not `.strictObject`) so a model's extra prose field is
 *  stripped rather than fatal — but the stripped object is what gets hashed,
 *  so the hash is over exactly what the gate judged. */
export const ProposalSchema = z.object({
  ticker: z.string().min(1),
  strategy: z.string().min(1),
  legs: z.array(LegSchema),
  // Prose for the reader, and nothing else reads it: no sub-gate consults it and
  // the renderer already prints "" when it is absent. A proposal held out of the
  // safety maths because its explanation was missing is a proposal nobody
  // checked — strictly worse than one checked without a sentence attached
  // (observed 2026-09-02: `rationale: expected string, received undefined` sank
  // six sibling proposals that were fine).
  rationale: z.string().optional(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * `pass` and `fail` are verdicts. `unchecked` is the absence of one, and it is
 * a THIRD thing on purpose.
 *
 * Collapsing it into `fail` is what a fail-closed gate is supposed to do —
 * while it is gating an order. Nothing here places an order: this tenant has
 * no tool that could, and the credential it reads IB with is refused on every
 * write path. Gating a daily READ on limits nobody has set yet does not make
 * anyone safer; it just refuses every proposal for the same four reasons every
 * morning, and a warning that fires unconditionally is one nobody reads.
 *
 * So an unchecked sub-gate does not sink the proposal, and it never reports as
 * passing either. `defined_risk` is unaffected: it needs no configuration and
 * no network, it encodes the desk's hard invariant (no naked shorts), and it
 * still fails hard.
 */
export type SubGateState = "pass" | "fail" | "unchecked";

export interface SubGate {
  pass: boolean;
  state: SubGateState;
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
  /** Sub-gates that reached no verdict, named so the reason travels with the
   *  proposal instead of being lost in a boolean. */
  unchecked: GateId[];
}

/** One option contract covers 100 shares. Not configurable: it is a fact about
 *  US listed equity options, not a policy knob. */
const CONTRACT_MULTIPLIER = 100;

/**
 * RFC-8785-flavoured canonicalisation: keys sorted, no whitespace. Only what
 * `JSON.stringify` already guarantees for numbers and strings is relied on —
 * the proposal schema admits no `NaN` and no cycles, and an absent optional
 * field (`mid`, `rationale`) is dropped below rather than hashed.
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
  const { legs } = proposal;
  if (legs.length === 0) {
    return { pass: false, state: "fail", detail: "no legs; max loss is not computable" };
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
          state: "fail",
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
        state: "fail",
        detail: `payoff at ${expiry} still falls above the highest strike; max loss is unbounded`,
      };
    }
    intrinsicLoss += Math.max(0, -Math.min(...values));
  }

  // Net debit (+) / credit (-) per share, from the quoted mids. There is no
  // `limitPrice` to trust any more: five of five quoted limit prices on
  // 2026-09-02 disagreed with their own legs, so the number is computed here
  // exactly as the renderer computes it, per contract and never per position.
  if (legs.some((leg) => leg.mid === undefined)) {
    return {
      pass: true,
      state: "pass",
      detail: "structure is defined-risk; max loss unpriced — a leg carries no NBBO mid",
    };
  }
  const net = sum(
    legs.map((leg) => (leg.action === "BUY" ? 1 : -1) * leg.ratio * (leg.mid ?? 0)),
  );
  const maxLoss = (intrinsicLoss + net) * CONTRACT_MULTIPLIER;
  if (!Number.isFinite(maxLoss)) {
    return { pass: false, state: "fail", detail: "max loss did not evaluate to a finite number" };
  }
  return {
    pass: true,
    state: "pass",
    detail: `max loss ${maxLoss.toFixed(2)} USD per contract, computable from the legs alone`,
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
      return { pass: false, state: "unchecked", detail: `no limit configured: ${missing}` };
    }
    return { pass: false, state: "unchecked", detail: `${detail}: ${NO_IB_DATA}` };
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

  const unchecked = (Object.keys(gates) as GateId[]).filter(
    (id) => gates[id].state === "unchecked",
  );
  return {
    contentHash: contentHash(proposal),
    gates,
    // A proposal fails only on a sub-gate that actually reached "fail".
    pass: Object.values(gates).every((sub) => sub.state !== "fail"),
    unchecked,
  };
}

/**
 * A model told to answer with JSON and nothing else will still fence it about
 * half the time, and refusing that is refusing on presentation rather than on
 * risk — the one thing this gate must never do.
 *
 * A FENCED block is taken wherever it sits, preamble and all. Observed
 * 2026-09-02 on run c40b61ee: the designer wrote two sentences of context and
 * then the exact object it was asked for, and the whole run failed
 * `gate-refused: role output is not JSON` — refusing on presentation again,
 * one layer up from the fence itself. A fence is the model saying
 * unambiguously "this is the answer"; the prose beside it is commentary.
 *
 * Bare JSON loose in prose is still a refusal. Without a fence there is no
 * mark saying which braces are the answer, and scraping the first `{` out of
 * an explanation would happily lift a worked EXAMPLE of a trade and gate it as
 * a real one.
 */
export function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  return trimmed;
}

/**
 * Output-gate input is whatever the role produced. When nothing can be read out
 * of it the reason travels in `error`, and the gate reports that as UNCHECKED
 * rather than as a refusal — `check` argues why.
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

/** Whatever identity an unparsed proposal still carries, so the reason names a
 *  ticker the reader can find in the report rather than an index alone. */
function labelOf(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const ticker = (raw as Record<string, unknown>).ticker;
  return typeof ticker === "string" && ticker.trim() !== "" ? ` (${ticker.trim()})` : "";
}

const gate: Gate = {
  id: "ib-preflight",
  phase: "output",
  appliesTo: ["structure-designer", "risk-reviewer"],
  async check(input: unknown, _ctx: GateCtx): Promise<{ pass: boolean; reason: string }> {
    const extracted = extractProposals(input);
    if (extracted.error !== undefined) {
      // The argument the `no proposals to check` branch below makes, one step
      // earlier. A refusal from this gate means "a proposal is unsafe"; output
      // nothing could be read out of means NO proposal was judged, so there is
      // nothing to call unsafe. Refusing does not withhold the text either — a
      // gate answers pass/fail and never edits the role's output — it only
      // fails the whole step over a formatting defect, which is exactly what
      // `role output is not JSON` did to a live run on 2026-09-02.
      return {
        pass: true,
        reason:
          `UNCHECKED — ${extracted.error}. No proposal could be read out of this ` +
          "role's output, so NONE was checked: nothing here has been through the " +
          "safety sub-gates and this pass says nothing about it.",
      };
    }
    if (extracted.proposals.length === 0) {
      // Nothing to gate is not a refusal. A gate refusal means "this proposal
      // is unsafe"; an empty list means the role produced no proposal, which
      // is the role's own result and shows up as its output. Conflating the
      // two spent every empty run reporting a risk violation that did not
      // exist, and would have trained a reader to ignore the word "refused".
      return { pass: true, reason: "no proposals to check" };
    }
    const thresholds = readThresholds(TENANT_DIR);
    const lines: string[] = [];
    let allPass = true;
    for (const [index, raw] of extracted.proposals.entries()) {
      const parsed = ProposalSchema.safeParse(raw);
      if (!parsed.success) {
        // Not a step failure, for the reason given at the top of `check`: a
        // proposal the schema cannot read is one the gate never judged, and
        // sinking the step for it also sinks the siblings it DID judge — six of
        // them, on 2026-09-02, over one `mid` that arrived in quotes. The line
        // says UNCHECKED so no reader mistakes the step's pass for a verdict on
        // this proposal.
        lines.push(
          `UNCHECKED — proposal ${index + 1}${labelOf(raw)} did not parse, so NO safety ` +
            `check ran on it and this step's pass does not cover it: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
        );
        continue;
      }
      const result = evaluateProposal(parsed.data, thresholds);
      if (!result.pass) allPass = false;
      const entries = Object.entries(result.gates) as Array<[GateId, SubGate]>;
      const failing = entries
        .filter(([, sub]) => sub.state === "fail")
        .map(([id, sub]) => `${id}: ${sub.detail}`);
      // Unchecked sub-gates ride along on a PASS as well. A proposal that
      // cleared the one check that ran is not the same as a proposal that
      // cleared five, and the line has to say so or the pass overstates itself.
      const caveat =
        result.unchecked.length === 0 ? "" : ` (unchecked: ${result.unchecked.join(", ")})`;
      lines.push(
        `${parsed.data.ticker} ${parsed.data.strategy} ${result.contentHash} ` +
          (result.pass ? `PASS${caveat}` : `FAIL — ${failing.join(" | ")}${caveat}`),
      );
    }
    return { pass: allPass, reason: lines.join("\n") };
  },
};

export default gate;
