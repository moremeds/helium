/**
 * The dsh provider: the ONE directory in this repo that names `@deepseek-ai/*`.
 *
 * Everything vendor-specific about the in-process runtime lives behind this
 * `Provider`. Core sees an id, a capability set, a price list and three
 * methods; a second vendor is a sibling directory and no core edit
 * (doctrine 3).
 *
 * Prices are USD PER TOKEN, taken from the vendor's published per-million
 * rates and divided by 1e6 at the point of declaration so the arithmetic is
 * visible rather than folded into a magic constant. They are a declaration by
 * this plugin, not a measurement: the audit table records what the session log
 * reported for tokens and multiplies by these, so a stale price shows up as a
 * cost error and never as a token error.
 * @module dsh-plugin-provider-dsh/provider
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AgentRequest,
  ModelRun,
  ModelSelection,
  Provider,
  ProviderModel,
  WorkOrder,
} from "@helium/core";
import { ExecutionTargetId, ProviderRunFailure } from "@helium/core";
import { CordisRunParentFactory, CordisSubagentRuntime, DshHost } from "./host.js";
import {
  SUBAGENT_TRANSPORT,
  authHeaders,
  createDshContext,
  selectedTools,
  registerEcosystemTools,
} from "./runtime.js";

const PER_MILLION = 1e-6;

/**
 * The route dsh actually drives here. `@deepseek-ai/dsh-llm-pi-ai` is a
 * generic adapter over pi-ai's provider catalog; this install has an Anthropic
 * credential and no DeepSeek one, so the declared catalog is Anthropic's.
 *
 * ponytail: one hard-wired route. The adapter takes a dict of routes and a
 * second one is a second entry plus its models — do that when a second
 * credential exists, not before.
 */
const LLM_PROVIDER = "anthropic";
/**
 * Which env var holds the credential. Overridable because this machine has two
 * — a spent metered key and a working subscription token — and which one an
 * install should spend is the operator's call, not the plugin's.
 */
const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Published list prices, 2026-09-02 (Anthropic first-party API, per million
 * tokens: haiku-4.5 $1/$5, sonnet-4.6 $3/$15, opus-5 $5/$25). Only models
 * whose price is verified are declared — pi-ai's catalog offers thirteen, and
 * a model listed without a price it can stand behind would be routed to and
 * then costed wrong. `cacheReadTokens` is folded separately by the audit
 * projection and is not priced here: pricing it would need a third rate this
 * plugin cannot verify from the wire.
 */
/**
 * The ids are the ones this ROUTE can actually call, which is not the same as
 * the ids Anthropic publishes.
 *
 * `claude-opus-5` and `claude-fable-5` are the only two entries in pi-ai's
 * anthropic catalog carrying `compat.allowedFallbackModels`, and pi-ai turns
 * that into a `fallbacks` field on every request for them. The subscription
 * endpoint rejects it outright — captured 2026-09-02:
 *   400 {"type":"invalid_request_error","message":"fallbacks: Extra inputs are
 *   not permitted"}
 * — so every deep-reasoning step failed before it reached a model, and did so
 * looking like a model with nothing to say. `claude-opus-4-8` is what
 * `claude-opus-5` names as its own fallback target: same price, same 1M
 * context, no `fallbacks` field. `claude-sonnet-5` replaces `claude-sonnet-4-6`
 * for the same reason it is preferable anyway — same context, lower price.
 * Prices are pi-ai's catalog values, read 2026-09-02 from
 * `@earendil-works/pi-ai/dist/providers/data/anthropic.json`.
 *
 * `quotaDomain` is PER TIER, not per vendor, because that is how the allowance
 * behind these ids is actually metered. Measured 2026-09-02 on one
 * subscription, same credential, same minute: opus and sonnet both answered
 * `429 rate_limit_error` while haiku answered `200`. A single "anthropic"
 * domain would have retired haiku for the rest of the run on the strength of
 * opus running out — retiring a target that was demonstrably still serving.
 */
export const DSH_MODELS: ProviderModel[] = [
  {
    id: "claude-haiku-4-5",
    caps: ["reason.fast", "tool.use", "cheap.bulk", "structured.output", "long.context"],
    usdIn: 1.0 * PER_MILLION,
    usdOut: 5.0 * PER_MILLION,
    maxContextTokens: 200_000,
    quotaDomain: "anthropic:haiku",
  },
  {
    id: "claude-sonnet-5",
    caps: ["reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 2.0 * PER_MILLION,
    usdOut: 10.0 * PER_MILLION,
    maxContextTokens: 1_000_000,
    quotaDomain: "anthropic:sonnet",
  },
  {
    id: "claude-opus-4-8",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 5.0 * PER_MILLION,
    usdOut: 25.0 * PER_MILLION,
    maxContextTokens: 1_000_000,
    quotaDomain: "anthropic:opus",
  },
];

/** Opaque per-model target ids. Core never parses one. */
export function dshTargetId(modelId: string) {
  return ExecutionTargetId(`dsh:${modelId}`);
}

export class DshProvider implements Provider {
  readonly id = "dsh";
  readonly models = DSH_MODELS;

  /**
   * MEASURED 2026-09-02 against the wire, on a live `helium run fake-tenant`
   * through claude-haiku-4-5. The scribe step's session log reports 103 input
   * tokens; `POST /v1/messages/count_tokens` on the exact same prompt text,
   * with no system prompt and no tools, answers 87. The 16-token difference is
   * dsh's own preamble.
   *
   * Deliberately NOT the tool-carrying number: the same run's two-tool prober
   * step billed 742 against a 95-token prompt, so the two tool schemas cost
   * ~631 tokens. That belongs to the ROLE, not the provider — the router
   * already knows a role's tools, and folding them in here would overcharge
   * every tool-free step. Re-measure when the dsh version changes.
   */
  readonly overheadTokens = 16;

  #ctx: Promise<Context> | undefined;
  #host: DshHost | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly models_ = DSH_MODELS,
  ) {}

  get capabilities(): string[] {
    return [...new Set(this.models_.flatMap((model) => model.caps))].sort();
  }

  /**
   * Liveness. Booting the runtime writes nothing and needs no credential, so
   * the only thing that can make this route dead in advance is a missing key:
   * pi-ai resolves the env var per request and raises MISSING_CREDENTIAL then.
   * An absent key is a DEAD provider — skipped with a reason, never a fatal
   * load error and never a silent fallback to some other route.
   */
  async probe(): Promise<boolean> {
    const value = this.env[this.#keyEnv()];
    return typeof value === "string" && value.trim() !== "";
  }

  /** Why a probe said no, for the skip record. Never includes the key. */
  probeReason(): string {
    return `${this.#keyEnv()} is unset; the dsh provider has no live route`;
  }

  #keyEnv(): string {
    return this.env.HELIUM_DSH_CREDENTIAL ?? DEFAULT_KEY_ENV;
  }

  /**
   * Cheapest model whose caps cover the request (design §5). Ties break on
   * model id so a recorded decision replays.
   */
  select(request: AgentRequest): ModelSelection {
    const eligible = this.models_
      .filter((model) => request.requires.every((tag) => model.caps.includes(tag)))
      .sort(
        (a, b) =>
          a.usdIn + a.usdOut - (b.usdIn + b.usdOut) || a.id.localeCompare(b.id, "en"),
      );
    const chosen = eligible[0];
    if (chosen === undefined) {
      throw new Error(
        `dsh provider has no model covering [${request.requires.join(", ")}] for role ${request.role}`,
      );
    }
    return {
      targetId: dshTargetId(chosen.id),
      model: chosen.id,
      // `providerName` is the SUBAGENT TRANSPORT the host starts the child on,
      // NOT the LLM vendor — see SUBAGENT_TRANSPORT. The vendor goes in
      // `provider`, which the in-process driver merges into the child's
      // agentOptions.
      options: { providerName: SUBAGENT_TRANSPORT, provider: LLM_PROVIDER },
    };
  }

  /**
   * Execute one routed step on a dsh subagent.
   *
   * `Provider.run` gets no runId, but `DshHost` needs one for its durable
   * parent session — so it is derived from `work.id`, which the runner builds
   * as `"<runId>:<taskId>"`.
   */
  async run(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<ModelRun> {
    const runId = work.id.split(":")[0] ?? work.id;
    const ctx = await this.#context();
    const host = this.#host!;
    const wanted = new Set(work.constraints.tools);
    const dispose = registerEcosystemTools(
      ctx,
      selectedTools(selection.options).filter((tool) => wanted.has(tool.name)),
    );
    try {
      return await host.run(runId, work, selection, signal);
    } catch (error: unknown) {
      // A spent allowance retires the whole vendor pool for the run; anything
      // else is a broken route and must not.
      const code = String((error as { code?: unknown })?.code ?? "");
      const message = error instanceof Error ? error.message : String(error);
      if (code === "RATE_LIMIT" || /\b429\b/.test(message)) {
        // The domain is the one this MODEL declares. Naming the vendor here
        // instead would contradict the catalog and retire siblings that are
        // still answering.
        const domain = DSH_MODELS.find((entry) => entry.id === selection.model)?.quotaDomain;
        throw new ProviderRunFailure("quota-exhausted", message, domain);
      }
      throw new ProviderRunFailure("provider-error", message);
    } finally {
      dispose();
      await host.close(runId).catch(() => undefined);
    }
  }

  #context(): Promise<Context> {
    if (this.#ctx !== undefined) return this.#ctx;
    // ponytail: the session/workspace root is this provider's own scratch dir,
    // not the run's state root — `Provider.run` is never told where that is.
    const root = this.env.HELIUM_DSH_HOME ?? join(tmpdir(), "helium-dsh");
    const keyEnv = this.#keyEnv();
    this.#ctx = createDshContext({
      sessionRoot: join(root, "sessions"),
      llmProvider: LLM_PROVIDER,
      apiKeyEnv: keyEnv,
      headers: authHeaders(this.env[keyEnv]),
    }).then((ctx) => {
      this.#host = new DshHost({
        subagents: new CordisSubagentRuntime(ctx.subagents),
        parents: new CordisRunParentFactory(ctx),
        workspacesDir: join(root, "workspaces"),
        maxDepth: 1,
      });
      return ctx;
    });
    return this.#ctx;
  }
}

export default new DshProvider();
