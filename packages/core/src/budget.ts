/**
 * Budget mechanics (design §5). Doctrine 4: an agent that knows it is at 10%
 * of its allowance behaves differently, so the number is injected into the
 * prompt rather than kept in the harness.
 *
 * Every rule here is enforced against the AUDIT table, which is folded from
 * the session log's own usage records. Nothing consults a chars-per-token
 * estimate.
 *
 * The failure is loud on purpose: a run that cannot afford its next step ends
 * `budget-exhausted`. It never silently truncates context to fit.
 * @module @helium/core/budget
 */
import type { AuditStore } from "./audit.js";
import type { TenantBudget } from "./tenant.js";
import type { BudgetProjection } from "./router.js";

export interface RemainingBudget {
  usd: number;
  tokens: number;
  spentUsd: number;
  spentTokens: number;
  steps: number;
  exhausted: boolean;
  /** Which ceiling ran out, when one has. */
  reason?: "usd" | "tokens";
}

export function remaining(
  store: AuditStore,
  runId: string,
  budget: TenantBudget,
): RemainingBudget {
  const spent = store.spent(runId);
  const steps = store.spans(runId).length;
  const usd = budget.usd - spent.usd;
  const tokens = budget.tokens - spent.tokens;
  return {
    usd,
    tokens,
    spentUsd: spent.usd,
    spentTokens: spent.tokens,
    steps,
    exhausted: usd <= 0 || tokens <= 0,
    ...(usd <= 0
      ? { reason: "usd" as const }
      : tokens <= 0
        ? { reason: "tokens" as const }
        : {}),
  };
}

/**
 * The line injected at the runtime's system-prompt assembly seam. Plain text
 * on purpose: it must survive being concatenated into any prompt shape.
 */
export function budgetLine(state: RemainingBudget, budget: TenantBudget): string {
  const pct = budget.usd === 0 ? 100 : Math.max(0, (state.usd / budget.usd) * 100);
  return [
    "[helium budget]",
    `remaining ${state.usd.toFixed(4)} USD of ${budget.usd.toFixed(2)} (${pct.toFixed(0)}%);`,
    `remaining ${Math.max(0, state.tokens)} tokens of ${budget.tokens};`,
    `${state.steps} steps used.`,
    "When this runs out the run stops; it is never silently truncated.",
  ].join(" ");
}

/**
 * Turn the remaining allowance plus a per-step estimate into the projection
 * the router ranks with. `projectedInputTokens` is an ESTIMATE of the next
 * step, supplied by the caller (context size so far, or a manifest default);
 * the router uses it only to compare candidate prices, never to bill.
 */
export function projection(
  state: RemainingBudget,
  estimate: { inputTokens: number; outputTokens: number },
): BudgetProjection {
  return {
    remainingUsd: Math.max(0, state.usd),
    projectedInputTokens: estimate.inputTokens,
    projectedOutputTokens: estimate.outputTokens,
  };
}

export class BudgetExhausted extends Error {
  readonly failureClass = "budget-exhausted" as const;
  constructor(
    readonly runId: string,
    readonly detail: string,
  ) {
    super(`budget exhausted for run ${runId}: ${detail}`);
    this.name = "BudgetExhausted";
  }
}

/** Default byte ceiling above which a tool result is summarised (design §5). */
export const SUMMARISE_OVER_BYTES = 8 * 1024;

export interface SummariseDecision {
  summarised: boolean;
  bytes: number;
  /** What enters the caller's context. */
  text: string;
  /** Where the FULL output was put, when it did not enter the context. */
  spillPath?: string;
}

/**
 * Decide what a tool result contributes to a context. Over the ceiling the
 * full bytes go to the sandbox and only a summary plus the path enter the
 * context; the audit row records `tool_output_bytes` and `summarised = 1`
 * either way, so the cost of a chatty tool is visible.
 *
 * `summarise` is injected: producing the summary means calling the cheapest
 * `cheap.bulk` model, which is a plugin's job, not core's. With no summariser
 * the head of the output plus the spill path is used -- truncation of a TOOL
 * RESULT that names where the rest went, never of a model context.
 */
export async function applyOutputPolicy(
  output: string,
  options: {
    overBytes?: number;
    spill?: (bytes: string) => Promise<string> | string;
    summarise?: (bytes: string) => Promise<string>;
  } = {},
): Promise<SummariseDecision> {
  const bytes = Buffer.byteLength(output, "utf8");
  const ceiling = options.overBytes ?? SUMMARISE_OVER_BYTES;
  if (bytes <= ceiling) return { summarised: false, bytes, text: output };

  const spillPath =
    options.spill === undefined ? undefined : await options.spill(output);
  const summary =
    options.summarise === undefined
      ? `${output.slice(0, 2000)}\n…[${bytes} bytes truncated]`
      : await options.summarise(output);
  return {
    summarised: true,
    bytes,
    text:
      spillPath === undefined
        ? summary
        : `${summary}\n[full output: ${spillPath}]`,
    ...(spillPath === undefined ? {} : { spillPath }),
  };
}
