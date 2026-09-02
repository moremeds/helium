/**
 * The dsh provider: the ONE directory in this repo that names `@deepseek-ai/*`.
 *
 * Everything vendor-specific about the in-process runtime lives behind this
 * `Provider`. Core sees an id, a capability set, a price list and two methods;
 * a second vendor is a sibling directory and no core edit (doctrine 3).
 *
 * Prices are USD PER TOKEN, taken from the vendor's published per-million
 * rates and divided by 1e6 at the point of declaration so the arithmetic is
 * visible rather than folded into a magic constant. They are a declaration by
 * this plugin, not a measurement: the audit table records what the session log
 * reported for tokens and multiplies by these, so a stale price shows up as a
 * cost error and never as a token error.
 * @module dsh-plugin-provider-dsh/provider
 */
import type {
  AgentRequest,
  ModelSelection,
  Provider,
  ProviderModel,
} from "@helium/core";
import { ExecutionTargetId } from "@helium/core";

const PER_MILLION = 1e-6;

/**
 * Published list prices, 2026-09-02, deepseek-chat / deepseek-reasoner
 * (cache-miss input). `cacheReadTokens` is folded separately by the audit
 * projection and is not priced here: the session log reports it, and pricing
 * it would require a third rate this plugin cannot verify from the wire.
 */
export const DSH_MODELS: ProviderModel[] = [
  {
    id: "deepseek-chat",
    caps: ["reason.fast", "tool.use", "cheap.bulk", "structured.output", "long.context"],
    usdIn: 0.28 * PER_MILLION,
    usdOut: 0.42 * PER_MILLION,
    maxContextTokens: 128_000,
  },
  {
    id: "deepseek-reasoner",
    caps: ["reason.deep", "reason.fast", "code.edit", "code.review", "tool.use", "structured.output", "long.context"],
    usdIn: 0.28 * PER_MILLION,
    usdOut: 0.42 * PER_MILLION,
    maxContextTokens: 128_000,
  },
];

/** Opaque per-model target ids. Core never parses one. */
export function dshTargetId(modelId: string) {
  return ExecutionTargetId(`dsh:${modelId}`);
}

export class DshProvider implements Provider {
  readonly id = "dsh";
  readonly models = DSH_MODELS;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly models_ = DSH_MODELS,
  ) {}

  get capabilities(): string[] {
    return [...new Set(this.models_.flatMap((model) => model.caps))].sort();
  }

  /**
   * Liveness. The in-process runtime cannot reach the vendor without a key, so
   * an absent key is a DEAD provider — skipped with a reason, never a fatal
   * load error and never a silent fallback to some other route.
   */
  async probe(): Promise<boolean> {
    return typeof this.env.DEEPSEEK_API_KEY === "string" &&
      this.env.DEEPSEEK_API_KEY.trim() !== "";
  }

  /** Why a probe said no, for the skip record. Never includes the key. */
  probeReason(): string {
    return "DEEPSEEK_API_KEY is unset; the dsh provider has no live route";
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
      options: { providerName: "deepseek" },
    };
  }
}

export default new DshProvider();
