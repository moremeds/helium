/**
 * Capability -> model. A role names a capability, never a model (doctrine 3).
 * Overridable per deployment through the runner row's `models` config
 * (tests point both tiers at the fake LLM that way).
 */
export interface ModelChoice {
  provider: string;
  model: string;
}

export type Capability = "reason.quick" | "reason.deep";

export const DEFAULT_MODELS: Record<Capability, ModelChoice> = {
  "reason.quick": { provider: "anthropic", model: "claude-sonnet-5-5" },
  "reason.deep": { provider: "anthropic", model: "claude-opus-5-5" },
};

/**
 * USD per million tokens: input, output, cache read, cache write (5 min).
 * Source: claude-api reference, model table cached 2026-10-06; cache write is
 * the documented 1.25x of input. Production runs on the subscription token,
 * so this is API-equivalent cost, not money billed. A model missing here
 * costs null, never 0: an unknown price must not read as free.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
};

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The four counts are disjoint on the Anthropic route (pi-ai maps
 *  input_tokens, cache_read_input_tokens, cache_creation_input_tokens
 *  separately), so cost is a plain sum. */
export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (p === undefined) return null;
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
}
