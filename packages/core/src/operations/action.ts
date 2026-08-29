/**
 * The action plane: the write-ahead intent recorded before any side effect,
 * and the closed set of outcomes an action can reach.
 *
 * `ACTION_OUTCOMES` is defined ONCE, here. The six values previously existed
 * only as English prose in five separate documents, so nothing mechanically
 * prevented a seventh from being typed -- the exact drift reviews XDOC-9 and
 * OPS-3 exist to stop. Every other module imports this union rather than
 * restating the list.
 *
 * The set is disjoint from the incident plane: `recovered` and `escalated` are
 * incident states, and `rejected` is a policy refusal rather than an outcome.
 * @module @helium/core/operations/action
 */
import { z } from "zod";
import { OpsIdSchema } from "./component.js";
import { IsoTimestampSchema } from "./observation.js";
import { CHECK_RESULTS } from "./check.js";

export const ACTION_OUTCOMES = [
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
] as const;

export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** Exhaustiveness guard: a seventh outcome fails `pnpm typecheck` at its call site. */
export function assertOutcomeHandled(value: never): never {
  throw new Error(`unhandled action outcome: ${String(value)}`);
}

export const PostconditionSampleSchema = z.strictObject({
  /** Must resolve to a registered CheckDefinition id. */
  checkId: OpsIdSchema,
  state: z.enum(CHECK_RESULTS),
  observedAt: IsoTimestampSchema,
  evidenceRefs: z.array(z.string().min(1).max(512)),
});
export type PostconditionSample = z.infer<typeof PostconditionSampleSchema>;

export const ActionIntentSchema = z
  .strictObject({
    actionId: OpsIdSchema,
    incidentId: OpsIdSchema,
    componentId: OpsIdSchema,
    sopId: OpsIdSchema,
    sopVersion: z.number().int().positive(),
    /** The FULL digest is persisted and later rechecked, not only the version. */
    sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    leaseId: OpsIdSchema,
    mutationOwnerRef: OpsIdSchema,
    /**
     * A fresh run of the exact postcondition set that will later decide
     * success, taken BEFORE any side effect. Required, and never a cached
     * observation.
     */
    baseline: z.strictObject({
      capturedAt: IsoTimestampSchema,
      samples: z.array(PostconditionSampleSchema).min(1),
      allPassing: z.boolean(),
    }),
    /** Structured argv. A command string is never representable here. */
    argv: z.array(z.string().max(4096)),
    recordedAt: IsoTimestampSchema,
  })
  .refine(
    (intent) =>
      intent.baseline.allPassing ===
      intent.baseline.samples.every((s) => s.state === "pass"),
    {
      message: "baseline allPassing disagrees with its samples",
      path: ["baseline", "allPassing"],
    },
  );
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

export type IntentDecision =
  | { admit: true }
  | { admit: false; outcome: ActionOutcome; reason: string };

/**
 * Decide whether an intent may execute at all.
 *
 * When the baseline already satisfies every postcondition the action
 * terminates as `not-needed` and NO script runs. That is neither a success nor
 * an `uncertain`: it is deterministic knowledge that the component was already
 * healthy, and it must be excluded from every automation-credit statistic.
 *
 * Without this gate, an operator fixing the component concurrently hands the
 * controller a free exit 0 plus passing postconditions -- and the promotion
 * gate that exists to detect false automation credit would be fed by exactly
 * the case it is meant to catch.
 *
 * An `unknown` sample is not passing. A check that could not run has not
 * proven the component healthy.
 */
export function admitIntent(intent: ActionIntent): IntentDecision {
  if (intent.baseline.allPassing) {
    return {
      admit: false,
      outcome: "not-needed",
      reason: "baseline already satisfied every postcondition",
    };
  }
  return { admit: true };
}
