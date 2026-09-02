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
import { ExecutionTargetId } from "@helium/core";
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

/** Ordered small-to-large: `select` takes the first model that covers. */
export const CODEX_MODELS: ProviderModel[] = [
  {
    id: "gpt-5.4-mini",
    caps: ["reason.fast", "tool.use", "cheap.bulk", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    maxContextTokens: CONTEXT,
  },
  {
    id: "gpt-5.6-sol",
    caps: ["reason.fast", "reason.deep", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    maxContextTokens: CONTEXT,
  },
  {
    id: "gpt-5.6-terra",
    caps: ["reason.fast", "reason.deep", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0,
    usdOut: 0,
    unmetered: true,
    maxContextTokens: CONTEXT,
  },
];

/** The Responses API always takes an effort; this is the floor, not a default. */
const EFFORT_FAST: CodexEffort = "low";
const EFFORT_DEEP: CodexEffort = "high";

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
      effort: request.requires.includes("reason.deep") ? EFFORT_DEEP : EFFORT_FAST,
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
      throw new Error(
        `codex-subscription performs inference only; ${String(work.constraints.tools.length)} tool(s) requested by role ${work.role}`,
      );
    }
    const startedAt = Date.now();
    const result = await invokeCodex({
      model: selection.model,
      effort: (selection.effort ?? EFFORT_FAST) as CodexEffort,
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
      env: this.env as Record<string, string>,
      signal,
    });
    if (!result.ok) {
      throw new Error(
        `codex-subscription ${selection.model}: ${result.classification ?? "error"}`,
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
