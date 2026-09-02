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
import { selectedTools } from "@helium/provider-sdk/tool-loop";
import type { CodexEffort } from "./catalog.js";
import { invokeCodex, turnEvents } from "./invoke.js";

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
 * API is capable of.
 *
 * `tool.use` was removed once and that removal was correct at the time: it was
 * listed while `run()` refused any work order carrying tools, and since every
 * model here is `unmetered` this provider is always the cheapest capable
 * target — so it WON every tool-using step and then failed it at execution
 * with "performs inference only". The rule that came out of it is the one
 * being honoured now, not overturned: the tag goes back only together with a
 * tool loop. `invoke.ts` has one (`MAX_TOOL_TURNS` turns of the Responses API
 * function-call protocol, tool spans folded into the audit), so it is true again.
 *
 * `cheap.bulk` on the spark tier still does NOT claim it: a chore tier exists
 * to be chosen for extraction and formatting, and letting it win tool-using
 * steps would route real work to the weakest model in the list.
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
    caps: ["reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    quotaDomain: POOL,
    maxContextTokens: CONTEXT,
  },
  {
    // Reserved for work that needs it; `reason.deep` lives only here.
    id: "gpt-5.6-sol",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
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
    // The work order carries tool NAMES; the runner puts the IMPLEMENTATIONS
    // in `selection.options.tools`. Intersecting the two keeps the role's
    // declared permissions authoritative.
    const wanted = new Set(work.constraints.tools);
    const tools = selectedTools(selection.options).filter((tool) =>
      wanted.has(tool.name),
    );
    if (tools.length < wanted.size) {
      // Running with fewer tools than the role declared is the failure that
      // still reports `completed` and whose empty answer reads as considered.
      throw new ProviderRunFailure(
        "capability-shortage",
        `codex-subscription: role ${work.role} declares ${String(wanted.size)} tool(s), ` +
          `${String(tools.length)} implementation(s) reached the provider`,
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
      ...(tools.length === 0 ? {} : { tools }),
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
      // The loop emitted one turn's events per model turn plus a span per tool
      // call; `sessionLog` is the fallback for a shape that predates it.
      events: result.events ?? sessionLog(startedAt, result.runtimeSnapshot.usage),
    };
  }
}

/**
 * One request, one step: what the stream reported, plus the time we measured.
 * `invoke.ts` owns the general form now; this is the single-turn case.
 */
export function sessionLog(
  startedAt: number,
  usage: { inputTokens?: number; outputTokens?: number },
): LogEvent[] {
  return turnEvents(0, 1, startedAt, usage);
}

export default new CodexSubscriptionProvider();
