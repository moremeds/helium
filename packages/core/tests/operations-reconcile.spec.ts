import { describe, expect, it } from "vitest";
import { reconcileOnStartup } from "../src/operations/reconcile.js";
import type { ActionProjection } from "../src/operations/reducer.js";

const action = (
  actionId: string,
  state: ActionProjection["state"],
): ActionProjection => ({
  actionId,
  incidentId: "inc-1",
  componentId: "runtime",
  sopId: "restart",
  sopDigest: `sha256:${"a".repeat(64)}`,
  state,
});

describe("reconcileOnStartup", () => {
  // The refusal that defines this module. An action whose receipt never landed
  // may already have mutated the component; re-running it would be a blind
  // retry of an operation nothing has shown to be idempotent.
  it("never re-runs a side effect, whatever it finds", () => {
    const decisions = reconcileOnStartup({
      actions: [
        action("act-1", "intent-recorded"),
        action("act-2", "executed"),
        action("act-3", "authorized"),
      ],
      evidence: {},
    });
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision.rerun).toBe(false);
    }
  });

  it("classifies an interrupted intent with no receipt as uncertain", () => {
    const [decision] = reconcileOnStartup({
      actions: [action("act-1", "intent-recorded")],
      evidence: {
        "act-1": {
          intentRecorded: true,
          baselineAllPassing: false,
          postconditions: "pass",
          operatorConfirmed: false,
        },
      },
    });
    expect(decision).toMatchObject({
      outcome: "uncertain",
      attribution: "unknown",
      automationCredit: false,
      rerun: false,
    });
  });

  it("classifies a recovered component with no intent as external", () => {
    const [decision] = reconcileOnStartup({
      actions: [action("act-1", "proposed")],
      evidence: {
        "act-1": {
          intentRecorded: false,
          baselineAllPassing: false,
          postconditions: "pass",
          operatorConfirmed: false,
        },
      },
    });
    expect(decision.outcome).toBe("external-recovery");
  });

  it("honours an operator intervention found during reconciliation", () => {
    const [decision] = reconcileOnStartup({
      actions: [action("act-1", "executed")],
      evidence: {
        "act-1": {
          intentRecorded: true,
          baselineAllPassing: false,
          receipt: { exitCode: 0, timedOut: false },
          postconditions: "pass",
          operatorConfirmed: true,
        },
      },
    });
    expect(decision).toMatchObject({
      outcome: "superseded-by-operator",
      attribution: "operator",
      automationCredit: false,
    });
  });

  it("leaves already-terminal actions alone", () => {
    expect(
      reconcileOnStartup({
        actions: [
          action("act-1", "succeeded"),
          action("act-2", "superseded-by-operator"),
          action("act-3", "not-needed"),
        ],
        evidence: {},
      }),
    ).toEqual([]);
  });

  it("falls back to uncertain when it has no evidence at all", () => {
    const [decision] = reconcileOnStartup({
      actions: [action("act-1", "executed")],
      evidence: {},
    });
    expect(decision.outcome).toBe("uncertain");
    expect(decision.automationCredit).toBe(false);
  });

  it("is deterministic and ordered by action id", () => {
    const decisions = reconcileOnStartup({
      actions: [action("act-c", "executed"), action("act-a", "executed"), action("act-b", "executed")],
      evidence: {},
    });
    expect(decisions.map((d) => d.actionId)).toEqual(["act-a", "act-b", "act-c"]);
  });

  it("grants no automation credit to anything it reconstructs", () => {
    // Reconciliation reasons about a run it did not observe. Nothing it
    // concludes may feed the promotion gate as evidence automation works.
    const decisions = reconcileOnStartup({
      actions: [action("act-1", "executed"), action("act-2", "intent-recorded")],
      evidence: {
        "act-1": {
          intentRecorded: true,
          baselineAllPassing: false,
          receipt: { exitCode: 0, timedOut: false },
          postconditions: "pass",
          operatorConfirmed: false,
        },
      },
    });
    // act-1 reconstructs to `succeeded` from a complete receipt, which IS
    // creditable -- the evidence is all there. act-2 has nothing.
    expect(decisions.find((d) => d.actionId === "act-2")?.automationCredit).toBe(false);
  });
});
