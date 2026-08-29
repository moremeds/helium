/**
 * Provider-neutral work orders and results.
 *
 * A `WorkOrder` says what must be done and under what constraints; it never
 * says who does it. The selector turns capability requirements into an opaque
 * `ExecutionTargetId`, and only the provider adapter at the far edge knows a
 * model name. Every schema here is strict: an unknown key is a rejection, not
 * an ignored field, because the fields that would sneak in are exactly the
 * provider and model names this package exists to keep out.
 * @module @helium/core/work
 */
import { z } from "zod";

export const ISOLATION_CLASSES = ["in-process", "process", "sandboxed"] as const;
export type IsolationClass = (typeof ISOLATION_CLASSES)[number];

/**
 * Normalized failure vocabulary. `quota-exhausted` is deliberately distinct
 * from `budget-exhausted` and must stay so: it is dynamic provider
 * availability carrying an opaque `retryAfter`, not a spent allowance and not
 * a capability score. Collapsing the two would make a target that is briefly
 * unavailable indistinguishable from one that has spent its money.
 */
export const FAILURE_CLASSES = [
  "unavailable",
  "timeout",
  "cancelled",
  "budget-exhausted",
  "quota-exhausted",
  "capability-shortage",
  "schema-invalid",
  "tool-boundary-violation",
  "provider-error",
  "verification-failed",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const WorkConstraintsSchema = z.strictObject({
  tools: z.array(z.string().min(1)),
  mutations: z.enum(["forbidden", "permitted"]),
  minIsolationClass: z.enum(ISOLATION_CLASSES),
  maxCost: z.number().nonnegative().optional(),
  maxLatencyMs: z.number().int().positive().optional(),
  maxContextTokens: z.number().int().positive().optional(),
});

export const WorkOrderSchema = z.strictObject({
  id: z.string().min(1),
  role: z.string().min(1),
  taskClass: z.string().min(1),
  /**
   * A FLAT tag set, evaluated as a hard filter. The graded form
   * (`{tag: {min, weight}}`) is deferred v2 pending real usage data, so the
   * schema rejects it rather than accepting a shape nothing reads.
   */
  requires: z.array(z.string().min(1)),
  constraints: WorkConstraintsSchema,
  inputs: z.strictObject({
    artifacts: z.array(z.string().min(1)),
    prompt: z.string().optional(),
  }),
  acceptance: z.strictObject({ outputSchema: z.string().min(1) }),
});
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

/**
 * Provenance recorded at the provider edge and stored as evidence.
 *
 * The provider adapter is the ONLY writer. Core, teams, and the selector never
 * read it to decide anything -- no branch, no filter, no ranking. Its only
 * consumers are the evidence ledger, the manifest, and replay. `providerId`,
 * `model`, and `effort` are opaque strings to core: the neutrality guard bans
 * provider names in core SOURCE and branching logic, not provider-supplied
 * values flowing through a typed audit field at runtime.
 */
export const ExecutionSnapshotSchema = z.strictObject({
  targetId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().optional(),
  providerVersion: z.string().min(1),
  /** The class actually demonstrated by the executor that ran this work. */
  isolationClass: z.enum(ISOLATION_CLASSES),
  recordedAt: z.string().min(1),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

export const AgentResultSchema = z.strictObject({
  workId: z.string().min(1),
  outcome: z.enum(["completed", "failed"]),
  failure: z
    .strictObject({
      class: z.enum(FAILURE_CLASSES),
      safeDetail: z.string().optional(),
      /** Opaque provider hint; only meaningful for `quota-exhausted`. */
      retryAfter: z.string().optional(),
    })
    .optional(),
  structured: z.unknown().optional(),
  artifacts: z.array(z.string().min(1)),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    /**
     * ABSENT, never defaulted to zero. A flat-rate target reports no cost at
     * all, and `0` would record "measured as free" where the truth is "not
     * metered".
     */
    cost: z.number().nonnegative().optional(),
    ms: z.number().int().nonnegative(),
  }),
  executionSnapshot: ExecutionSnapshotSchema,
  /** Provider-native audit data with no typed home; core never interprets it. */
  runtimeMetadata: z.record(z.string(), z.unknown()),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;
