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

/** Default byte ceiling above which a tool result is summarised (design §5).
 *
 *  Set from measurement, not from taste. Every `ow_*` tool result in the 250
 *  recorded laptop sessions was sized on 2026-09-03; the distribution has a
 *  gap, and the ceiling sits in it:
 *
 *    output a persona actually reads      max bytes   over 64 KiB / calls
 *      ow_uw_ticker_metrics                 111,513          7 / 13
 *      ow_argon_metrics                      61,944          0 / 69
 *      ow_reports                            52,866          0 / 35
 *      ow_uw_chain                           32,520          0 / 97
 *    output that is bulk, not signal
 *      ow_macro_rates                       270,981   (4,391 rows, 145 unique)
 *      ow_uw_market_state                   139,512   (390 per-minute prints)
 *
 *  8 KB spilled 6 of the 7 tools above — including the IV term structure and
 *  the chain the structure-designer quotes strike by strike — so it did not
 *  bound cost, it deleted inputs. 64 KB still spills 7 of 13 ticker-metrics
 *  calls. 128 KiB clears the largest legitimate output by ~17% and still
 *  catches both blowups, which is the whole job of this number: it is a net
 *  under unbounded output, not a substitute for trimming a chatty tool
 *  (issue #81). */
export const SUMMARISE_OVER_BYTES = 128 * 1024;

/** How much of an oversized output still enters the context. Enough to see
 *  WHAT the output is and decide whether to go read the rest. */
export const HEAD_CHARS = 2000;

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
  // The notice has to be unambiguous about what the head IS. A 2000-character
  // slice of prose is a readable opening; the same slice of a structured
  // payload ends wherever the 2000th character fell, mid-object, and a reader
  // that treats it as the whole answer answers from half a record.
  const summary =
    options.summarise === undefined
      ? `${output.slice(0, HEAD_CHARS)}\n…[HEAD ONLY — first ${HEAD_CHARS} characters of ${bytes} bytes, cut at a fixed offset and possibly mid-record, so it is not necessarily complete or parseable]`
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
