import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runGraceWindow,
  verifyAction,
  type PostconditionVerdict,
  type VerificationInput,
} from "../src/operations/verify.js";

const sample = (state: "pass" | "fail" | "unknown") => ({
  checkId: "coverage-fresh",
  state,
  observedAt: "2026-08-25T04:00:00.000Z",
  evidenceRefs: ["artifact://baseline/1"],
});

const someFailing = { allPassing: false, samples: [sample("fail")] };
const allPassing = { allPassing: true, samples: [sample("pass")] };

const outcome = (input: VerificationInput) => {
  const verdict = verifyAction(input);
  if (verdict.decision !== "outcome") throw new Error(`expected an outcome, got ${verdict.decision}`);
  return verdict;
};

// The attribution matrix of design section 6.5. Every row starts from a
// recorded pre-action baseline, because the baseline is what separates a
// recovery the controller CAUSED from a state it merely OBSERVED.
describe("attribution matrix", () => {
  it.each<[string, VerificationInput, string, string | undefined, boolean]>([
    [
      "exit 0, postconditions pass",
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 0, timedOut: false }, postconditions: "pass", operatorConfirmed: false },
      "succeeded",
      "automatic",
      true,
    ],
    [
      "exit 0, postconditions fail",
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 0, timedOut: false }, postconditions: "fail", operatorConfirmed: false },
      "failed",
      "automatic",
      false,
    ],
    [
      "nonzero exit, postconditions pass -- never claimed automatic",
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 1, timedOut: false }, postconditions: "pass", operatorConfirmed: false },
      "uncertain",
      "unknown",
      false,
    ],
    [
      "nonzero exit, postconditions pass, operator confirmed",
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 1, timedOut: false }, postconditions: "pass", operatorConfirmed: true },
      "superseded-by-operator",
      "operator",
      false,
    ],
    [
      "missing receipt WITH a recorded intent",
      { baseline: someFailing, intentRecorded: true, postconditions: "pass", operatorConfirmed: false },
      "uncertain",
      "unknown",
      false,
    ],
    [
      "missing receipt with NO intent -- nothing was ever attempted",
      { baseline: someFailing, intentRecorded: false, postconditions: "pass", operatorConfirmed: false },
      "external-recovery",
      "external",
      false,
    ],
    [
      "timeout with unknown postconditions",
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: null, timedOut: true }, postconditions: "unknown", operatorConfirmed: false },
      "uncertain",
      "unknown",
      false,
    ],
    [
      "baseline already passing, nothing spawned",
      { baseline: allPassing, intentRecorded: false, postconditions: "pass", operatorConfirmed: false },
      "not-needed",
      undefined,
      false,
    ],
    [
      "baseline already passing, operator confirmed",
      { baseline: allPassing, intentRecorded: false, postconditions: "pass", operatorConfirmed: true },
      "not-needed",
      "operator",
      false,
    ],
  ])("%s", (_label, input, expected, attribution, credit) => {
    const verdict = outcome(input);
    expect(verdict.outcome).toBe(expected);
    expect(verdict.attribution).toBe(attribution);
    expect(verdict.automationCredit).toBe(credit);
  });

  it("rejects, rather than attempting, when ownership refuses", () => {
    for (const reason of ["competing-controller", "ownership-unverifiable"] as const) {
      expect(
        verifyAction({
          intentRecorded: false,
          postconditions: "unknown",
          operatorConfirmed: false,
          mutationPermission: { ok: false, reason },
        }),
      ).toEqual({ decision: "rejected", reason });
    }
  });
});

// The two `missing receipt` rows are why the intent column exists (OPS-5).
describe("a missing receipt is not evidence of an external actor", () => {
  it("is uncertain when an intent was recorded, because Helium may have run it", () => {
    expect(
      outcome({ baseline: someFailing, intentRecorded: true, postconditions: "pass", operatorConfirmed: false }).outcome,
    ).toBe("uncertain");
  });

  it("is external only when nothing was ever attempted", () => {
    expect(
      outcome({ baseline: someFailing, intentRecorded: false, postconditions: "pass", operatorConfirmed: false }).outcome,
    ).toBe("external-recovery");
  });
});

describe("invariants the promotion gate depends on", () => {
  // Automation credit is what the promotion gate reads. Feeding it a
  // not-needed -- a component that was already healthy -- is exactly the false
  // credit the baseline exists to prevent.
  it("grants automation credit ONLY to a genuine success", () => {
    const inputs: VerificationInput[] = [
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 0, timedOut: false }, postconditions: "pass", operatorConfirmed: false },
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 0, timedOut: false }, postconditions: "fail", operatorConfirmed: false },
      { baseline: someFailing, intentRecorded: true, receipt: { exitCode: 1, timedOut: false }, postconditions: "pass", operatorConfirmed: false },
      { baseline: allPassing, intentRecorded: false, postconditions: "pass", operatorConfirmed: false },
      { baseline: someFailing, intentRecorded: false, postconditions: "pass", operatorConfirmed: false },
    ];
    const credited = inputs.map(outcome).filter((v) => v.automationCredit);
    expect(credited).toHaveLength(1);
    expect(credited[0].outcome).toBe("succeeded");
  });

  // A success claim is impossible unless the baseline recorded real work to do.
  it("can never reach succeeded from an all-passing baseline", () => {
    for (const receipt of [{ exitCode: 0, timedOut: false }, undefined]) {
      for (const postconditions of ["pass", "fail", "unknown"] as PostconditionVerdict[]) {
        for (const intentRecorded of [true, false]) {
          const verdict = outcome({
            baseline: allPassing,
            intentRecorded,
            ...(receipt === undefined ? {} : { receipt }),
            postconditions,
            operatorConfirmed: false,
          });
          expect(verdict.outcome).not.toBe("succeeded");
        }
      }
    }
  });

  it("never uses an incident-plane state as an action outcome", () => {
    const seen = new Set<string>();
    for (const intentRecorded of [true, false]) {
      for (const operatorConfirmed of [true, false]) {
        for (const postconditions of ["pass", "fail", "unknown"] as PostconditionVerdict[]) {
          const verdict = verifyAction({
            baseline: someFailing,
            intentRecorded,
            receipt: { exitCode: 0, timedOut: false },
            postconditions,
            operatorConfirmed,
          });
          if (verdict.decision === "outcome") seen.add(verdict.outcome);
        }
      }
    }
    for (const forbidden of ["recovered", "escalated", "rejected"]) {
      expect([...seen]).not.toContain(forbidden);
    }
  });
});

describe("the production-derived regression fixture", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../evals/fixtures/ops/colima-operator-recovery.json", import.meta.url),
      ),
      "utf8",
    ),
  );

  it("attributes the audited incident to the operator, never to automation", () => {
    // The audited shape: an automatic attempt reached its own failure path,
    // the operator fixed it, and the containers were healthy afterwards.
    const verdict = outcome({
      baseline: someFailing,
      intentRecorded: true,
      receipt: { exitCode: 1, timedOut: false },
      postconditions: "pass",
      operatorConfirmed: fixture.interventions[0].confirmed,
    });
    expect(verdict.outcome).toBe("superseded-by-operator");
    expect(verdict.attribution).toBe("operator");
    expect(verdict.automationCredit).toBe(false);
  });

  it("keeps the fixture's five evidence decisions independent of each other", () => {
    // A healthy Docker inventory does not erase the failed automation claim.
    expect(fixture.expected.assertions).toEqual({
      detection: "PROVEN",
      automaticRecovery: "FAILED",
      finalDockerHealth: "PROVEN",
      automaticAttribution: "FAILED",
      operatorAttribution: "PROVEN",
    });
    expect(fixture.expected.automaticRecoverySucceeded).toBe(false);
    expect(fixture.expected.actionOutcome).toBeNull();
  });

  it("does not let a later healthy observation rewrite the failed assertions", () => {
    const healthyLater = fixture.observations.find(
      (o: { state: string }) => o.state === "ok",
    );
    expect(healthyLater).toBeDefined();
    // The healthy reading exists in the same fixture as the FAILED automation
    // assertions, and changes neither of them.
    expect(fixture.expected.assertions.automaticRecovery).toBe("FAILED");
    expect(fixture.expected.assertions.automaticAttribution).toBe("FAILED");
  });
});

describe("grace window", () => {
  const clock = (startMs: number) => {
    let t = startMs;
    return {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("waits the initial delay, then returns on the first pass", async () => {
    const c = clock(0);
    let calls = 0;
    const result = await runGraceWindow(
      { initialDelayMs: 100, intervalMs: 50, timeoutMs: 10_000 },
      {
        ...c,
        sample: async () => {
          calls += 1;
          return calls >= 3 ? "pass" : "fail";
        },
      },
    );
    expect(result.verdict).toBe("pass");
    expect(result.samples).toHaveLength(3);
    expect(result.timedOut).toBe(false);
  });

  it("appends every sample, not only the last", async () => {
    const c = clock(0);
    const result = await runGraceWindow(
      { initialDelayMs: 0, intervalMs: 100, timeoutMs: 250 },
      { ...c, sample: async () => "fail" },
    );
    expect(result.samples.length).toBeGreaterThan(1);
    expect(result.samples.every((s) => s.verdict === "fail")).toBe(true);
  });

  // A window that expires without a pass must not round up.
  it("times out on the verdict it actually saw", async () => {
    const c = clock(0);
    const result = await runGraceWindow(
      { initialDelayMs: 0, intervalMs: 100, timeoutMs: 200 },
      { ...c, sample: async () => "unknown" },
    );
    expect(result.timedOut).toBe(true);
    expect(result.verdict).toBe("unknown");
  });
});
