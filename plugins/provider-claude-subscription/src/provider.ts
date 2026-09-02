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
import type { ClaudeEffort } from "./catalog.js";
import { invokeClaude } from "./invoke.js";

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
 * API is capable of. `tool.use` is deliberately absent: the wire call here is
 * single-shot inference with no tool loop, and `run()` below refuses a work
 * order that declares tools.
 *
 * It used to be listed, and that was a lie the router believed. Every model
 * here is `unmetered`, so this provider is always the cheapest capable target
 * — it therefore WON every tool-using step and then failed it at execution
 * with "performs inference only". Declaring the capability honestly turns that
 * runtime failure into a routing decision: a tool-using role now goes to a
 * provider that can actually run one, or fails as `capability-shortage`, which
 * names the real problem. Put `tool.use` back only together with a tool loop.
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
    caps: ["reason.fast", "code.edit", "code.review", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // Reserved for work that genuinely needs it; `reason.deep` lives only here.
    id: "claude-opus-5",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "structured.output", "long.context"],
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
    // Pure inference: the request carries no `tools`, so the model cannot call
    // one. A role that asked for tools would silently get a model with none, so
    // refuse rather than quietly narrow what was ordered (doctrine 4).
    if (work.constraints.tools.length > 0) {
      throw new ProviderRunFailure(
        "provider-error",
        `claude-subscription performs inference only; ${String(work.constraints.tools.length)} tool(s) requested by role ${work.role}`,
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
      events: sessionLog(startedAt, result.runtimeSnapshot.modelUsage),
    };
  }
}

/**
 * One request, one step. The Messages API answers once with its own accounting,
 * so the log is the two events the audit fold needs and nothing invented: what
 * the wire reported for tokens, and the wall time we measured around it.
 */
export function sessionLog(
  startedAt: number,
  usage: Record<string, unknown>,
): LogEvent[] {
  const num = (key: string): number =>
    typeof usage[key] === "number" ? (usage[key] as number) : 0;
  return [
    { type: "step/start", seq: 0, time: startedAt, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: 1,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        usage: {
          inputTokens: num("input_tokens"),
          outputTokens: num("output_tokens"),
          cacheReadTokens: num("cache_read_input_tokens"),
        },
      },
    },
  ];
}

export default new ClaudeSubscriptionProvider();
