/**
 * What one run tells the next about the regime.
 *
 * `ow_prior_brief` used to hand the editor the previous phase's WHOLE markdown
 * brief, and intraday duly re-told premarket's cause in premarket's words. Six
 * fields instead: the next run compares them and writes the delta.
 *
 * Every number here is COPIED from a tool by the model, never computed by it
 * (eight of eleven model-computed numbers audited on 2026-09-03 were wrong),
 * which is why they are `z.number()` and not `z.coerce.number()`: a figure that
 * arrived as the string "4.79" was retyped, and a retyped number is exactly the
 * one worth refusing.
 * @module dsh-plugin-tenant-option-wizard/state/regime
 */
import { z } from "zod";

export const RegimeState = z.strictObject({
  /** The one input that moved the tape, in the analyst's own words. */
  cause: z.string().min(1).max(200),
  /** 2Y UST level, copied from ow_macro_rates. */
  ust2y: z.number().optional(),
  /** 10Y UST level, copied from ow_macro_rates. */
  ust10y: z.number().optional(),
  /** 2s10s in basis points, as the tool reported it. */
  s2s10: z.number().optional(),
  tide: z.enum(["up", "down", "flat"]),
  thesis: z.string().min(1).max(400),
});

export type RegimeState = z.infer<typeof RegimeState>;

/** The record, or `null` for anything that is not one. Never throws: a bad
 *  record is a fact the gate reports, not an error that costs the run. */
export function parseRegimeState(value: unknown): RegimeState | null {
  const parsed = RegimeState.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The body of the ```regime-state fence in a raw step text.
 *
 * The gate needs this because it runs BEFORE the runner lifts the block
 * (packages/cli/src/runner.ts), so the fence is still there. The fence name is
 * a literal here and a declaration in tenant.yaml; the two must agree, and the
 * gate test is what keeps them agreeing.
 */
export function findStateBlock(text: string): string | null {
  const found = /```regime-state[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/u.exec(text);
  return found === null ? null : found[1]!.trim();
}
