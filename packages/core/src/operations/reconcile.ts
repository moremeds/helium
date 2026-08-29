/**
 * Startup reconciliation of non-terminal actions.
 *
 * A crash can leave an action recorded as in flight. Reconciliation decides
 * what that action's outcome WAS, from receipts, operator events and current
 * postconditions -- and it never re-runs the side effect.
 *
 * That refusal is the whole point. An action whose receipt never landed may
 * already have mutated the component; re-running it would be a blind retry of
 * an operation nothing has shown to be idempotent. The honest answer is
 * `uncertain`, which is why that outcome exists.
 * @module @helium/core/operations/reconcile
 */
import type { ActionOutcome } from "./action.js";
import type { Attribution } from "./events.js";
import type { ActionProjection } from "./reducer.js";
import {
  verifyAction,
  type ExecutionReceiptFacts,
  type PostconditionVerdict,
} from "./verify.js";

/** What reconciliation could observe about one interrupted action. */
export interface ReconcileEvidence {
  intentRecorded: boolean;
  baselineAllPassing?: boolean;
  receipt?: ExecutionReceiptFacts;
  postconditions: PostconditionVerdict;
  operatorConfirmed: boolean;
}

export interface ReconcileDecision {
  actionId: string;
  outcome: ActionOutcome;
  attribution?: Attribution;
  /**
   * Always false. Reconciliation classifies; it never re-runs. Typed as the
   * literal so a future edit that tries to set it true fails to compile.
   */
  rerun: false;
  automationCredit: boolean;
}

const TERMINAL = new Set<string>([
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
]);

export function reconcileOnStartup(input: {
  actions: ActionProjection[];
  evidence: Record<string, ReconcileEvidence>;
}): ReconcileDecision[] {
  return input.actions
    .filter((action) => !TERMINAL.has(action.state))
    .sort((a, b) => (a.actionId < b.actionId ? -1 : 1))
    .map((action) => {
      const evidence = input.evidence[action.actionId] ?? {
        // No evidence at all is not a reason to assume anything happened, and
        // not a reason to assume nothing did.
        intentRecorded: action.state === "intent-recorded" || action.state === "executed",
        postconditions: "unknown" as const,
        operatorConfirmed: false,
      };

      const verdict = verifyAction({
        ...(evidence.baselineAllPassing === undefined
          ? {}
          : { baseline: { allPassing: evidence.baselineAllPassing, samples: [] } }),
        intentRecorded: evidence.intentRecorded,
        ...(evidence.receipt === undefined ? {} : { receipt: evidence.receipt }),
        postconditions: evidence.postconditions,
        operatorConfirmed: evidence.operatorConfirmed,
      });

      if (verdict.decision !== "outcome") {
        // A rejection is not an outcome; an interrupted action that was
        // refused never reached the action plane at all.
        return {
          actionId: action.actionId,
          outcome: "not-needed" as const,
          rerun: false as const,
          automationCredit: false,
        };
      }

      return {
        actionId: action.actionId,
        outcome: verdict.outcome,
        ...(verdict.attribution === undefined
          ? {}
          : { attribution: verdict.attribution }),
        rerun: false as const,
        automationCredit: verdict.automationCredit,
      };
    });
}
