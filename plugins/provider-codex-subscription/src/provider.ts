/**
 * The ChatGPT-Codex subscription as a v2 `Provider`. Same shape and same
 * reasoning as the Claude one: `catalog.ts` keeps the vendor's target list,
 * this is the core-shaped face over it, and every model is UNMETERED because a
 * subscription bills a month rather than a token.
 * @module dsh-plugin-provider-codex-subscription/provider
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
import type { CodexEffort } from "./catalog.js";
import { invokeCodex } from "./invoke.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * MEASURED, not estimated (design §3.1 rule 3). 2026-09-02, through this
 * plugin's own transport: a 1-character prompt bills 17 input tokens and a
 * 108-character prompt bills 40 — the same ~4.7 chars/token slope as Claude,
 * so both points put the intercept at 17, one of which is the prompt itself.
 * `provider-overhead.live.contract.spec.ts` re-measures it against the wire.
 */
export const CODEX_OVERHEAD_TOKENS = 16;

const CONTEXT = 400_000;

/** The main subscription session: luna and sol run out together. */
const POOL = "codex-subscription-session";

/**
 * Spark bills against its own allowance, so it OUTLIVES an exhausted main pool
 * — that, not its price, is why it is here. Declared by the operator, not
 * measured: proving it would mean deliberately exhausting the main pool.
 */
const SPARK_POOL = "codex-spark";

/**
 * Ordered cheapest-first: `select` takes the FIRST covering model, so a tag
 * that appears on two tiers hides the lower one. Each tier claims only what it
 * is the right answer for.
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
export const CODEX_MODELS: ProviderModel[] = [
  {
    // Chores, at roughly haiku's level. Operator feedback 2026-09-02: quality
    // is weak and cheapness is its only advantage — kept because a separate
    // allowance makes it the right thing to burn while wiring a flow up, and
    // under review once real work runs through it.
    id: "gpt-5.3-codex-spark",
    caps: ["cheap.bulk", "reason.fast", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: SPARK_POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // The labour tier.
    id: "gpt-5.6-luna",
    caps: ["reason.fast", "code.edit", "code.review", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // Reserved for work that needs it; `reason.deep` lives only here.
    id: "gpt-5.6-sol",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
];

/**
 * This API always takes an effort, so the chore case is an explicit floor
 * rather than an omitted field.
 */
function effortFor(requires: readonly string[]): CodexEffort {
  if (requires.includes("reason.deep")) return "high";
  if (requires.includes("code.edit") || requires.includes("code.review")) {
    return "medium";
  }
  return "low";
}

export function codexTargetId(modelId: string) {
  return ExecutionTargetId(`codex-subscription:${modelId}`);
}

export class CodexSubscriptionProvider implements Provider {
  readonly id = "codex-subscription";
  readonly models = CODEX_MODELS;
  readonly overheadTokens = CODEX_OVERHEAD_TOKENS;

  #reason = "";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get capabilities(): string[] {
    return [...new Set(this.models.flatMap((model) => model.caps))].sort();
  }

  #proxy(): string | undefined {
    const proxy = this.env.HELIUM_PROXY;
    return proxy === undefined || proxy === "" ? undefined : proxy;
  }

  async probe(): Promise<boolean> {
    const token = this.env.CODEX_ACCESS_TOKEN;
    if (token === undefined || token.trim() === "") {
      this.#reason =
        "CODEX_ACCESS_TOKEN is unset; copy tokens.access_token from ~/.codex/auth.json into ~/.config/helium/helium.env";
      return false;
    }
    const proxy = this.#proxy();
    const verdict = await probeEgress({
      url: ENDPOINT,
      headers: { originator: "helium" },
      ...(proxy === undefined ? {} : { proxy }),
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

  select(request: AgentRequest): ModelSelection {
    const chosen = this.models.find((model) =>
      request.requires.every((tag) => model.caps.includes(tag)),
    );
    if (chosen === undefined) {
      throw new Error(
        `codex-subscription has no model covering [${request.requires.join(", ")}] for role ${request.role}`,
      );
    }
    return {
      targetId: codexTargetId(chosen.id),
      model: chosen.id,
      effort: effortFor(request.requires),
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
        `codex-subscription performs inference only; ${String(work.constraints.tools.length)} tool(s) requested by role ${work.role}`,
      );
    }
    const startedAt = Date.now();
    const result = await invokeCodex({
      model: selection.model,
      effort: (selection.effort ?? "low") as CodexEffort,
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
      env: this.env as Record<string, string>,
      signal,
    });
    if (!result.ok) {
      const failure = result.classification ?? "error";
      throw new ProviderRunFailure(
        failure,
        `codex-subscription ${selection.model}: ${failure}`,
        failure === "quota-exhausted"
          ? (this.models.find((m) => m.id === selection.model)?.quotaDomain ?? POOL)
          : undefined,
      );
    }
    return {
      text: result.text ?? "",
      events: sessionLog(startedAt, result.runtimeSnapshot.usage),
    };
  }
}

/** One request, one step: what the stream reported, plus the time we measured. */
export function sessionLog(
  startedAt: number,
  usage: { inputTokens?: number; outputTokens?: number },
): LogEvent[] {
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
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      },
    },
  ];
}

export default new CodexSubscriptionProvider();
