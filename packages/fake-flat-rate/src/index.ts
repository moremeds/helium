/**
 * A flat-rate, in-process reference executor.
 *
 * The other half of the pair. This one is billed by subscription with a
 * session quota: it reports NO cost and NO tokens -- the fields are absent,
 * not zero -- it may terminate `quota-exhausted` with an opaque `retryAfter`,
 * and it MUST NEVER emit `budget-exhausted`. There is no code path here that
 * constructs one.
 *
 * Absent-not-zero is the load-bearing part. A `0` would record "measured as
 * free" where the truth is "not metered", and a ledger that then sums costs
 * would report a confident total it never observed.
 *
 * It runs in-process and declares `in-process`, the weakest class there is.
 * The shared conformance suite cannot grade it -- every assertion there reads
 * a report written by a spawned CLI child, and there is no child -- so the
 * registry admits it at the floor and refuses it any work requiring more.
 * The floor cannot be over-claimed, which is the only thing that suite exists
 * to catch.
 * @module @helium/fake-flat-rate
 */
import type {
  AgentResult,
  ExecutionContext,
  ExecutionTargetId,
  Executor,
  WorkOrder,
} from "@helium/core";

export interface FlatRateExecutorOptions {
  targetId: ExecutionTargetId;
  /**
   * When set, every run terminates `quota-exhausted` carrying this opaque
   * provider hint. Never parsed into a duration here, and never synthesised.
   */
  quotaExhaustedUntil?: string;
  /** What a completed run returns as its structured output. */
  reply?: (work: WorkOrder, context: ExecutionContext) => unknown;
}

export function createFlatRateExecutor(
  options: FlatRateExecutorOptions,
): Executor {
  const { targetId, quotaExhaustedUntil, reply } = options;

  const snapshot = (ms: number) => ({
    targetId: String(targetId),
    providerId: "fake-flat-rate",
    model: "flat-1",
    providerVersion: "0.0.0",
    isolationClass: "in-process" as const,
    recordedAt: new Date(ms).toISOString(),
  });

  return {
    targetId,
    isolationClass: "in-process",

    async run(
      work: WorkOrder,
      _signal: AbortSignal,
      context: ExecutionContext,
    ): Promise<AgentResult> {
      const started = Date.now();
      if (quotaExhaustedUntil !== undefined) {
        return {
          workId: work.id,
          outcome: "failed",
          failure: {
            class: "quota-exhausted",
            safeDetail: "session window exhausted",
            retryAfter: quotaExhaustedUntil,
          },
          artifacts: [],
          // No cost and no tokens even on failure: this target is not metered.
          usage: { ms: Date.now() - started },
          executionSnapshot: snapshot(started),
          runtimeMetadata: { fake: "flat-rate", reason: "quota" },
        };
      }

      return {
        workId: work.id,
        outcome: "completed",
        structured: reply?.(work, context) ?? { ok: true },
        artifacts: [],
        usage: { ms: Date.now() - started },
        executionSnapshot: snapshot(started),
        runtimeMetadata: { fake: "flat-rate" },
      };
    },

    async drain(): Promise<void> {
      // Runs complete synchronously within their own promise; nothing queues.
    },
  };
}
