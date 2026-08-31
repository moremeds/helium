/**
 * Action verification and attribution.
 *
 * This is where the audited incident's lesson becomes code: **a controller
 * must not claim that its own action succeeded merely because the target later
 * became healthy.** Every classification below starts from the pre-action
 * baseline, because the baseline is what separates a recovery the controller
 * CAUSED from a state it merely OBSERVED.
 *
 * The outcome vocabulary is the six-value set of design section 6.5, plus the
 * action-plane decision `rejected`, which is a policy refusal rather than an
 * outcome. There is no seventh value and no incident state is usable here.
 * @module @helium/core/operations/verify
 */
import type { ActionOutcome, PostconditionSample } from "./action.js";
import type { Attribution } from "./events.js";
import type { MutationPermission } from "./mutation-owner.js";

export type PostconditionVerdict = "pass" | "fail" | "unknown";

export interface ExecutionReceiptFacts {
  exitCode: number | null;
  timedOut: boolean;
}

export interface VerificationInput {
  /**
   * The pre-action baseline. `undefined` means no intent was ever recorded, so
   * nothing was attempted and there is no baseline to have taken.
   */
  baseline?: { allPassing: boolean; samples: PostconditionSample[] };
  /** Whether a write-ahead intent was durably recorded before any side effect. */
  intentRecorded: boolean;
  /** Absent means no receipt landed -- which is NOT by itself evidence of anything. */
  receipt?: ExecutionReceiptFacts;
  /** The gated child took the component lock and was released to execute. */
  executionStarted?: boolean;
  postconditions: PostconditionVerdict;
  operatorConfirmed: boolean;
  /** When present and refusing, the action never reached the action plane. */
  mutationPermission?: MutationPermission;
}

export type VerificationVerdict =
  | { decision: "rejected"; reason: string }
  | {
      decision: "outcome";
      outcome: ActionOutcome;
      attribution?: Attribution;
      /**
       * Whether this outcome may be counted by the promotion gate as evidence
       * that automation works. Only a genuine `succeeded` qualifies.
       */
      automationCredit: boolean;
    };

export function verifyAction(input: VerificationInput): VerificationVerdict {
  // A mutation refused for ownership reasons is an action-plane REJECTION with
  // probe evidence attached -- not a failed recovery, and not an attempt.
  if (input.mutationPermission !== undefined && !input.mutationPermission.ok) {
    return { decision: "rejected", reason: input.mutationPermission.reason };
  }

  // The operator-concurrent-fix case. The component was already healthy at
  // baseline, so nothing was spawned. This is NOT a success and NOT an
  // `uncertain`: the attribution is not unclear, it is known, and it must be
  // excluded from every automation-credit statistic.
  if (input.baseline?.allPassing === true) {
    return {
      decision: "outcome",
      outcome: "not-needed",
      ...(input.operatorConfirmed ? { attribution: "operator" as const } : {}),
      automationCredit: false,
    };
  }

  if (!input.intentRecorded) {
    // Nothing was ever attempted. Only here can a recovered component be
    // attributed to something outside Helium.
    if (input.postconditions === "pass") {
      return {
        decision: "outcome",
        outcome: "external-recovery",
        attribution: input.operatorConfirmed ? "operator" : "external",
        automationCredit: false,
      };
    }
    return {
      decision: "outcome",
      outcome: "uncertain",
      attribution: "unknown",
      automationCredit: false,
    };
  }

  // An intent exists, so Helium may have mutated the component. An operator
  // fix during that window supersedes the action whatever the postconditions
  // now say.
  if (input.operatorConfirmed) {
    return {
      decision: "outcome",
      outcome: "superseded-by-operator",
      attribution: "operator",
      automationCredit: false,
    };
  }

  // A MISSING RECEIPT with a recorded intent is not evidence of an external
  // actor. Helium may well have run the script and crashed before the receipt
  // landed, so attribution is genuinely unclear. Calling this
  // `external-recovery` would credit someone else for a mutation Helium may
  // have performed (review OPS-5).
  if (input.receipt === undefined) {
    if (input.executionStarted === true) {
      if (input.postconditions === "pass") {
        return {
          decision: "outcome",
          outcome: "succeeded",
          attribution: "automatic",
          automationCredit: true,
        };
      }
      if (input.postconditions === "fail") {
        return {
          decision: "outcome",
          outcome: "failed",
          attribution: "automatic",
          automationCredit: false,
        };
      }
    }
    return {
      decision: "outcome",
      outcome: "uncertain",
      attribution: "unknown",
      automationCredit: false,
    };
  }

  if (input.receipt.timedOut) {
    return {
      decision: "outcome",
      outcome: "uncertain",
      attribution: "unknown",
      automationCredit: false,
    };
  }

  if (input.receipt.exitCode !== 0) {
    // A non-zero exit with passing postconditions is a genuine attribution
    // gap: the partial run may have fixed it, or something else did. It is
    // never claimed as automatic. With failing postconditions there is no gap
    // -- Helium tried and the component is still broken.
    return input.postconditions === "fail"
      ? {
          decision: "outcome",
          outcome: "failed",
          attribution: "automatic",
          automationCredit: false,
        }
      : {
          decision: "outcome",
          outcome: "uncertain",
          attribution: "unknown",
          automationCredit: false,
        };
  }

  switch (input.postconditions) {
    case "pass":
      return {
        decision: "outcome",
        outcome: "succeeded",
        attribution: "automatic",
        automationCredit: true,
      };
    case "fail":
      return {
        decision: "outcome",
        outcome: "failed",
        attribution: "automatic",
        automationCredit: false,
      };
    case "unknown":
      // A postcondition that could not be evaluated has not passed.
      return {
        decision: "outcome",
        outcome: "uncertain",
        attribution: "unknown",
        automationCredit: false,
      };
  }
}

export interface GraceWindowPolicy {
  initialDelayMs: number;
  intervalMs: number;
  timeoutMs: number;
}

export interface GraceSample {
  at: string;
  verdict: PostconditionVerdict;
}

export interface GraceWindowResult {
  verdict: PostconditionVerdict;
  samples: GraceSample[];
  timedOut: boolean;
}

/**
 * Sample the postcondition set across a grace window.
 *
 * Waits `initialDelayMs`, then samples until every postcondition passes or the
 * window expires, appending EVERY result. A window that expires without a pass
 * yields the last verdict it actually saw -- `unknown` if it never got an
 * answer -- and never optimistically rounds up.
 */
export async function runGraceWindow(
  policy: GraceWindowPolicy,
  deps: {
    sample: () => Promise<PostconditionVerdict>;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<GraceWindowResult> {
  const started = deps.now().getTime();
  const samples: GraceSample[] = [];
  await deps.sleep(policy.initialDelayMs);

  for (;;) {
    const verdict = await deps.sample();
    samples.push({ at: deps.now().toISOString(), verdict });
    if (verdict === "pass") {
      return { verdict, samples, timedOut: false };
    }
    if (deps.now().getTime() - started >= policy.timeoutMs) {
      return { verdict, samples, timedOut: true };
    }
    await deps.sleep(policy.intervalMs);
  }
}
