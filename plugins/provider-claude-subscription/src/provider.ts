/**
 * The Claude subscription as a v2 `Provider`: what the runner discovers by
 * glob and routes to. `catalog.ts` stays the vendor's own target list; this is
 * the small, core-shaped face over it.
 *
 * Every model here is UNMETERED. A subscription bills a month, not a token, so
 * declaring a per-token price would be a fabricated number — and a zero one
 * would make the router prefer it over every metered model for the wrong
 * reason. The token columns in the audit table are still real.
 * @module dsh-plugin-provider-claude-subscription/provider
 */
import type {
  AgentRequest,
  LogEvent,
  ModelRun,
  ModelSelection,
  Provider,
  ProviderModel,
  WorkOrder,
} from "@helium/core";
import { ExecutionTargetId, ProviderRunFailure } from "@helium/core";
import { probeEgress } from "@helium/provider-sdk/probe";
import { selectedTools } from "@helium/provider-sdk/tool-loop";
import type { ClaudeEffort } from "./catalog.js";
import { invokeClaude, turnEvents } from "./invoke.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

/**
 * MEASURED, not estimated (design §3.1 rule 3). 2026-09-02, through this
 * plugin's own transport: a 1-character prompt bills 22 input tokens and a
 * 108-character prompt bills 45, so the per-character rate is ~4.7 chars/token
 * and both points agree on an intercept of 22 — one of which is the prompt
 * itself. The remainder is the mandatory Claude Code identity block.
 * `provider-overhead.live.contract.spec.ts` re-measures it against the wire.
 */
export const CLAUDE_OVERHEAD_TOKENS = 21;

const CONTEXT = 200_000;

/** All three draw on the one subscription session; they run out together. */
const POOL = "claude-subscription-session";

/**
 * Ordered cheapest-first: `select` takes the FIRST model that covers, so an
 * overlapping tag silently hides everything below it. Each tier therefore
 * carries only what it is actually the right answer for — `sonnet` does NOT
 * claim `reason.deep`, or `opus` could never be selected.
 */
/**
 * A model's caps describe what THIS PLUGIN can execute, not what the vendor's
 * API is capable of.
 *
 * `tool.use` was removed once and that removal was correct at the time: it was
 * listed while `run()` refused any work order carrying tools, and since every
 * model here is `unmetered` this provider is always the cheapest capable
 * target — so it WON every tool-using step and then failed it at execution
 * with "performs inference only". The rule that came out of it is the one
 * being honoured now, not overturned: the tag goes back only together with a
 * tool loop. `invoke.ts` has one (`MAX_TOOL_TURNS` turns of the Messages API
 * tool protocol, tool spans folded into the audit), so the tag is true again.
 *
 * `cheap.bulk` on haiku still does NOT claim it: a chore tier exists to be
 * chosen for extraction and formatting, and letting it win tool-using steps
 * would route real work to the smallest model in the list.
 */
export const CLAUDE_MODELS: ProviderModel[] = [
  {
    // Chores: extraction, formatting, classification.
    id: "claude-haiku-4-5-20251001",
    caps: ["cheap.bulk", "reason.fast", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // The labour tier: writing and editing code, reviewing a diff.
    id: "claude-sonnet-5",
    caps: ["reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // Reserved for work that genuinely needs it; `reason.deep` lives only here.
    id: "claude-opus-5",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
];

/**
 * Extended thinking is billed in tokens, so it is asked for by the shape of the
 * request and never defaulted on. Chores get none at all.
 */
function effortFor(requires: readonly string[]): ClaudeEffort | undefined {
  if (requires.includes("reason.deep")) return "high";
  if (requires.includes("code.edit") || requires.includes("code.review")) {
    return "medium";
  }
  return undefined;
}

export function claudeTargetId(modelId: string) {
  return ExecutionTargetId(`claude-subscription:${modelId}`);
}

export class ClaudeSubscriptionProvider implements Provider {
  readonly id = "claude-subscription";
  readonly models = CLAUDE_MODELS;
  readonly overheadTokens = CLAUDE_OVERHEAD_TOKENS;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get capabilities(): string[] {
    return [...new Set(this.models.flatMap((model) => model.caps))].sort();
  }

  #token(): string | undefined {
    return this.env.CLAUDE_CODE_OAUTH_TOKEN ?? this.env.ANTHROPIC_API_KEY;
  }

  #reason = "";

  /**
   * Two separate questions, asked in the order that makes the answer useful:
   * do we hold a credential, and can this machine reach the vendor at all.
   */
  async probe(): Promise<boolean> {
    const token = this.#token();
    if (token === undefined || token.trim() === "") {
      this.#reason =
        "neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set; run `claude setup-token` and put it in ~/.config/helium/helium.env";
      return false;
    }
    const verdict = await probeEgress({
      url: ENDPOINT,
      headers: { "anthropic-version": "2023-06-01" },
      ...(this.#proxy() === undefined ? {} : { proxy: this.#proxy()! }),
    });
    if (!verdict.reachable) {
      this.#reason = verdict.reason;
      return false;
    }
    return true;
  }

  probeReason(): string {
    return this.#reason;
  }

  #proxy(): string | undefined {
    const proxy = this.env.HELIUM_PROXY;
    return proxy === undefined || proxy === "" ? undefined : proxy;
  }

  /**
   * Cheapest-capable within this provider. Every model is unmetered, so "cheap"
   * is the declared order of the list — small first — and a request that needs
   * deep reasoning simply cannot be served by the small one.
   */
  select(request: AgentRequest): ModelSelection {
    const chosen = this.models.find((model) =>
      request.requires.every((tag) => model.caps.includes(tag)),
    );
    if (chosen === undefined) {
      throw new Error(
        `claude-subscription has no model covering [${request.requires.join(", ")}] for role ${request.role}`,
      );
    }
    const effort = effortFor(request.requires);
    return {
      targetId: claudeTargetId(chosen.id),
      model: chosen.id,
      ...(effort === undefined ? {} : { effort }),
    };
  }

  async run(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<ModelRun> {
    // The work order carries tool NAMES; the runner puts the IMPLEMENTATIONS
    // in `selection.options.tools`. Intersecting the two is what keeps the
    // role's declared permissions authoritative — an implementation that
    // arrived but was not named in the order is not offered to the model.
    const wanted = new Set(work.constraints.tools);
    const tools = selectedTools(selection.options).filter((tool) =>
      wanted.has(tool.name),
    );
    if (tools.length < wanted.size) {
      // Silently running with fewer tools than the role declared is the first
      // failure shape this tenant paid for: the step still "completes" and its
      // empty answer reads as a considered one.
      throw new ProviderRunFailure(
        "capability-shortage",
        `claude-subscription: role ${work.role} declares ${String(wanted.size)} tool(s), ` +
          `${String(tools.length)} implementation(s) reached the provider`,
      );
    }
    const startedAt = Date.now();
    const result = await invokeClaude({
      model: selection.model,
      ...(selection.effort === undefined
        ? {}
        : { effort: selection.effort as ClaudeEffort }),
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
      env: this.env as Record<string, string>,
      signal,
      ...(tools.length === 0 ? {} : { tools }),
    });
    if (!result.ok) {
      const failure = result.classification ?? "error";
      throw new ProviderRunFailure(
        failure,
        `claude-subscription ${selection.model}: ${failure}`,
        failure === "quota-exhausted" ? POOL : undefined,
      );
    }
    return {
      text: result.text ?? "",
      // The loop already emitted one turn's events per model turn plus a span
      // per tool call; `sessionLog` is the fallback for a result shape that
      // predates it.
      events:
        result.events ??
        sessionLog(startedAt, result.runtimeSnapshot.modelUsage),
    };
  }
}

/**
 * One request, one step: the first turn's events and nothing invented — what
 * the wire reported for tokens, and the wall time we measured around it.
 * `invoke.ts` owns the general form now; this is the single-turn case.
 */
export function sessionLog(
  startedAt: number,
  usage: Record<string, unknown>,
): LogEvent[] {
  return turnEvents(0, 1, startedAt, usage);
}

export default new ClaudeSubscriptionProvider();
