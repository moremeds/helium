import { describe, expect, it } from "vitest";
import { reduceOperations } from "../src/operations/reducer.js";
import { OperationsEventSchema, type OperationsEvent } from "../src/operations/events.js";

const digest = `sha256:${"a".repeat(64)}`;
const evidence = {
  ref: "artifact://ops/evidence/recovery.json",
  sha256: "b".repeat(64),
  schema: "helium.ops.recovery-evidence/v1" as const,
  assertionId: "recovery-act-1",
};
const sample = {
  checkId: "runtime-up",
  state: "pass" as const,
  observedAt: "2026-08-25T04:05:00.000Z",
  evidenceRefs: ["artifact://check/runtime-up"],
};
const verificationCheck = {
  id: "runtime-up",
  kind: "business" as const,
  probe: { probeId: "runtime.probe.v1", args: {} },
  expect: { dimension: "readiness", operator: "eq" as const, value: true },
  onUnavailable: "unknown" as const,
  timeoutMs: 5_000,
  owner: "ops",
};
const at = (n: number) => `2026-08-25T04:0${n}:00.000Z`;

it("rejects a proposal authority snapshot that is incomplete or mismatched", () => {
  const base = {
    v: 1, id: "proposal-snapshot", at: at(0), type: "action-proposed",
    actionId: "act-snapshot", incidentId: "inc-1", componentId: "runtime",
    sopId: "restart-runtime", sopVersion: 1, sopDigest: digest,
    proposedAuthority: "auto",
  };
  expect(OperationsEventSchema.safeParse(base).success).toBe(false);
  expect(OperationsEventSchema.safeParse({
    ...base,
    proposedAuthorityManifestEntry: {
      sopId: "other-sop", version: 2, digest: `sha256:${"f".repeat(64)}`, authority: "approve",
    },
  }).success).toBe(false);
});

const opened: OperationsEvent = {
  v: 1,
  id: "ev-1",
  at: at(0),
  type: "incident-opened",
  incidentId: "inc-1",
  componentId: "runtime",
  dimension: "controller",
  observationIds: ["obs-1"],
};
const proposed: OperationsEvent = {
  v: 1,
  id: "ev-2",
  at: at(1),
  type: "action-proposed",
  actionId: "act-1",
  incidentId: "inc-1",
  componentId: "runtime",
  sopId: "restart-runtime",
  sopVersion: 1,
  sopDigest: digest,
  scopeId: `lws-${"1".repeat(32)}:sha256:${"2".repeat(64)}`,
};
const authorized: OperationsEvent = {
  v: 1,
  id: "ev-3",
  at: at(2),
  type: "action-authorized",
  actionId: "act-1",
  authority: "auto",
};
const intentRecorded: OperationsEvent = {
  v: 1,
  id: "ev-4",
  at: at(3),
  type: "action-intent-recorded",
  actionId: "act-1",
  leaseId: "lease-1",
  operationId: "op-1",
  argv: ["--restart"],
  baseline: {
    capturedAt: at(3),
    samples: [{ ...sample, state: "fail" }],
    allPassing: false,
  },
  controllerProbe: {
    result: "clear",
    observedLabels: [],
    evidenceRef: "artifact://controller/1",
  },
  eligibility: { eligible: true, reasons: [] },
  mutationOwner: {
    owner: "opsd",
    competingLabels: [],
    changedAt: at(3),
    changeRef: "artifact://ownership/1",
  },
  dependencyIds: ["host"],
  verificationPolicy: { postconditions: [verificationCheck], graceMs: 0 },
};
const operatorIntervened: OperationsEvent = {
  v: 1,
  id: "ev-5",
  at: at(4),
  type: "operator-intervened",
  componentId: "runtime",
  kind: "manual-recovery",
  confirmed: true,
};
const verifiedRecovered: OperationsEvent = {
  v: 1,
  id: "ev-6",
  at: at(5),
  type: "action-verified",
  actionId: "act-1",
  outcome: "succeeded",
  postconditionRefs: ["runtime-up"],
  postconditionSamples: [sample],
  recoveryEvidence: evidence,
};

describe("reduceOperations", () => {
  it("projects the happy path to an automatic success", () => {
    const state = reduceOperations([opened, proposed, authorized, intentRecorded, verifiedRecovered]);
    expect(state.actions["act-1"]).toMatchObject({
      state: "succeeded",
      attribution: "automatic",
      scopeId: proposed.scopeId,
    });
  });

  // The single most important assertion in this module. The audited Colima
  // incident is exactly this shape: an automatic attempt in flight, an
  // operator fix, and a later healthy reading. Crediting the automation would
  // be the false-attribution bug the whole design exists to prevent.
  it("supersedes an in-flight action when the operator intervenes, whatever the later verification says", () => {
    const state = reduceOperations([
      opened,
      proposed,
      authorized,
      intentRecorded,
      operatorIntervened,
      verifiedRecovered,
    ]);
    expect(state.actions["act-1"]).toMatchObject({
      state: "superseded-by-operator",
      attribution: "operator",
    });
  });

  it("does not supersede an action on a different component", () => {
    const state = reduceOperations([
      opened,
      proposed,
      authorized,
      intentRecorded,
      { ...operatorIntervened, componentId: "other" },
      verifiedRecovered,
    ]);
    expect(state.actions["act-1"].state).toBe("succeeded");
  });

  it("does not supersede an action that had already reached a terminal outcome", () => {
    const state = reduceOperations([
      opened,
      proposed,
      authorized,
      intentRecorded,
      verifiedRecovered,
      { ...operatorIntervened, id: "ev-7", at: at(6) },
    ]);
    expect(state.actions["act-1"].state).toBe("succeeded");
    expect(state.actions["act-1"].attribution).toBe("automatic");
  });

  it("records a receipt as executed, never as verified", () => {
    const receipt: OperationsEvent = {
      v: 1,
      id: "ev-r",
      at: at(4),
      type: "action-receipt-recorded",
      actionId: "act-1",
      exitCode: 0,
      timedOut: false,
      outputDigest: digest,
      outputTail: "ok",
      outputBytes: 2,
      startedAt: at(4),
      finishedAt: at(4),
    };
    const state = reduceOperations([opened, proposed, authorized, intentRecorded, receipt]);
    // A zero exit is not a verification.
    expect(state.actions["act-1"]).toMatchObject({ state: "executed", exitCode: 0 });
    expect(state.actions["act-1"].attribution).toBeUndefined();
  });

  it("attributes an external recovery to neither the controller nor the operator", () => {
    const state = reduceOperations([
      opened,
      proposed,
      authorized,
      intentRecorded,
      { ...verifiedRecovered, outcome: "external-recovery" },
    ]);
    expect(state.actions["act-1"].attribution).toBe("external");
  });

  it("attributes an uncertain outcome to unknown, never to the controller", () => {
    const state = reduceOperations([
      opened,
      proposed,
      authorized,
      intentRecorded,
      { ...verifiedRecovered, outcome: "uncertain" },
    ]);
    expect(state.actions["act-1"].attribution).toBe("unknown");
  });

  it("rejects a duplicate event id", () => {
    expect(() => reduceOperations([opened, { ...proposed, id: "ev-1" }])).toThrow(
      /duplicate operations event id/,
    );
  });

  it.each([
    ["authorizing an action that was never proposed", [opened, authorized]],
    ["recording intent before authorization", [opened, proposed, intentRecorded]],
    [
      "recording a receipt before intent",
      [
        opened,
        proposed,
        authorized,
        {
          v: 1,
          id: "ev-r",
          at: at(4),
          type: "action-receipt-recorded",
          actionId: "act-1",
          exitCode: 0,
          timedOut: false,
          outputDigest: digest,
          outputTail: "ok",
          outputBytes: 2,
          startedAt: at(4),
          finishedAt: at(4),
        } as OperationsEvent,
      ],
    ],
    [
      "verifying twice",
      [opened, proposed, authorized, intentRecorded, verifiedRecovered, { ...verifiedRecovered, id: "ev-8" }],
    ],
  ])("rejects an illegal transition: %s", (_label, events) => {
    expect(() => reduceOperations(events as OperationsEvent[])).toThrow(
      /illegal transition|unknown action/,
    );
  });

  it("rejects an update to an incident it has never seen", () => {
    expect(() =>
      reduceOperations([
        { v: 1, id: "x", at: at(0), type: "incident-updated", incidentId: "ghost", state: "open" },
      ]),
    ).toThrow(/unknown incident/);
  });

  it("is a pure fold: the same events always give the same state", () => {
    const events = [opened, proposed, authorized, intentRecorded, operatorIntervened, verifiedRecovered];
    const first = JSON.stringify(reduceOperations(events));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(reduceOperations(events))).toBe(first);
    }
  });
});
