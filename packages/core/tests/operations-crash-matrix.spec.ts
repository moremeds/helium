/**
 * The Phase B crash matrix.
 *
 * A full recovery attempt is written to a REAL durable log, then the
 * controller is "terminated" at every point in the sequence by truncating the
 * log after each event and replaying from disk. For every crash point the same
 * five invariants must hold.
 *
 * The log is truncated rather than the in-memory state discarded, because the
 * question is what a restarted process can conclude from what actually reached
 * the disk -- not what a still-running process happens to remember.
 */
import { mkdtempSync, readFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canMutate } from "../src/operations/mutation-owner.js";
import { ActionLeaseTable } from "../src/operations/lease.js";
import { reconcileOnStartup } from "../src/operations/reconcile.js";
import { OperationsStore } from "../src/operations/store.js";
import type { ComponentSpec } from "../src/operations/component.js";
import type { OperationsEvent } from "../src/operations/events.js";

const digest = `sha256:${"a".repeat(64)}`;
const evidence = {
  ref: "artifact://ops/evidence/recovery.json",
  sha256: "b".repeat(64),
  schema: "helium.ops.recovery-evidence/v1" as const,
  assertionId: "recovery-act-1",
};
const noSync = () => {};
const at = (n: number) =>
  `2026-08-25T04:${String(n).padStart(2, "0")}:00.000Z`;

/** One complete attempt, in the order a real run would append it. */
const SEQUENCE: OperationsEvent[] = [
  { v: 1, id: "e1", at: at(0), type: "observation-recorded", observation: {
      version: 1, id: "obs-1", componentId: "runtime", probeId: "runtime.probe.v1",
      observedAt: at(0), expiresAt: at(9), state: "failed", dimension: "controller",
      evidenceRefs: ["artifact://obs/1"], parserVersion: "probe/1" } },
  { v: 1, id: "e2", at: at(1), type: "incident-opened", incidentId: "inc-1",
    componentId: "runtime", dimension: "controller", observationIds: ["obs-1"] },
  { v: 1, id: "e3", at: at(2), type: "mutation-ownership-changed", componentId: "runtime",
    ownership: { owner: "opsd", competingLabels: [], changedAt: at(2), changeRef: "artifact://own/1" } },
  { v: 1, id: "e4", at: at(3), type: "action-proposed", actionId: "act-1",
    incidentId: "inc-1", componentId: "runtime", sopId: "restart", sopVersion: 1, sopDigest: digest },
  { v: 1, id: "e5", at: at(4), type: "action-authorized", actionId: "act-1", authority: "auto" },
  { v: 1, id: "e6", at: at(5), type: "action-intent-recorded", actionId: "act-1",
    leaseId: "lease-1", operationId: "op-1", argv: ["--restart"],
    baseline: { capturedAt: at(5), samples: [{ checkId: "runtime-up", state: "fail", observedAt: at(5), evidenceRefs: ["artifact://check/baseline"] }], allPassing: false },
    controllerProbe: { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/1" },
    eligibility: { eligible: true, reasons: [] },
    mutationOwner: { owner: "opsd", competingLabels: [], changedAt: at(5), changeRef: "artifact://own/intent" },
    dependencyIds: [], verificationPolicy: { postconditionIds: ["runtime-up"], graceMs: 0 } },
  { v: 1, id: "e7", at: at(6), type: "action-receipt-recorded", actionId: "act-1",
    exitCode: 0, timedOut: false, outputDigest: digest, outputTail: "ok", outputBytes: 2,
    startedAt: at(6), finishedAt: at(6) },
  { v: 1, id: "e8", at: at(7), type: "action-verified", actionId: "act-1",
    outcome: "succeeded", postconditionRefs: ["runtime-up"],
    postconditionSamples: [{ checkId: "runtime-up", state: "pass", observedAt: at(7), evidenceRefs: ["artifact://check/post"] }],
    recoveryEvidence: evidence },
];

const component = (
  owner: "opsd" | "external" | "none" = "opsd",
  competingLabels: string[] = [],
): ComponentSpec => ({
  version: 1,
  id: "runtime",
  kind: "container-runtime",
  mutationOwner: { owner, competingLabels, changedAt: at(0), changeRef: "artifact://own/1" },
});

/** Write the first `n` events, then truncate the log mid-line to simulate a kill. */
function crashAfter(n: number, torn: boolean): OperationsStore {
  const dir = mkdtempSync(join(tmpdir(), "helium-crash-"));
  const store = OperationsStore.open(dir, { sync: noSync });
  for (const event of SEQUENCE.slice(0, n)) store.append(event);
  if (torn && n > 0) {
    const raw = readFileSync(store.logPath, "utf8");
    truncateSync(store.logPath, raw.length - 15);
  }
  return OperationsStore.open(dir, { sync: noSync });
}

describe("crash matrix", () => {
  const points = SEQUENCE.map((e, i) => [`${e.type} (event ${i + 1})`, i + 1] as const);

  it.each(points)("survives termination after %s", (_label, n) => {
    const reopened = crashAfter(n, false);
    const events = reopened.replay();
    expect(events).toHaveLength(n);
    // No duplicate event survives a restart.
    expect(new Set(events.map((e) => e.id)).size).toBe(n);
  });

  it.each(points)("survives a TORN write after %s", (_label, n) => {
    const reopened = crashAfter(n, true);
    // A torn final line is dropped, never half-parsed into a phantom event.
    expect(reopened.replay().length).toBe(Math.max(0, n - 1));
  });

  it.each(points)("never re-runs a side effect after %s", (_label, n) => {
    const state = crashAfter(n, false).state();
    const decisions = reconcileOnStartup({
      actions: Object.values(state.actions),
      evidence: {},
    });
    for (const decision of decisions) {
      expect(decision.rerun).toBe(false);
    }
  });

  it.each(points)("reaches at most one terminal action state after %s", (_label, n) => {
    const state = crashAfter(n, false).state();
    const terminal = Object.values(state.actions).filter((a) =>
      ["succeeded", "failed", "not-needed", "uncertain", "superseded-by-operator", "external-recovery"].includes(
        a.state,
      ),
    );
    expect(terminal.length).toBeLessThanOrEqual(1);
  });

  it.each(points)("records at most one receipt for the action after %s", (_label, n) => {
    const receipts = crashAfter(n, false)
      .replay()
      .filter((e) => e.type === "action-receipt-recorded");
    expect(receipts).toHaveLength(Math.min(1, Math.max(0, n - 6)));
  });
});

describe("invariants that hold at every crash point", () => {
  it("keeps at most one active lease throughout", () => {
    const table = new ActionLeaseTable();
    const now = new Date(at(5));
    const key = {
      componentId: "runtime",
      incidentId: "inc-1",
      sopId: "restart",
      sopDigest: digest,
      attempt: 1,
    };
    // A restarted controller re-attempts the acquire it may already have made.
    for (let restart = 0; restart < 8; restart += 1) {
      table.acquire({ key, leaseId: `l-${restart}`, operationId: "op-1", now, ttlMs: 60_000 });
      expect(table.active("runtime", now)).toBeDefined();
    }
    // Still exactly one holder, and it is the first one.
    expect(table.active("runtime", now)?.leaseId).toBe("l-0");
  });

  it("classifies no recovery from an exit code alone", () => {
    // The receipt is present and zero, but no verification event landed. A
    // restarted controller must not read that as success.
    const state = crashAfter(7, false).state();
    expect(state.actions["act-1"].state).toBe("executed");
    expect(state.actions["act-1"].attribution).toBeUndefined();

    const [decision] = reconcileOnStartup({
      actions: Object.values(state.actions),
      evidence: {
        "act-1": {
          intentRecorded: true,
          baselineAllPassing: false,
          receipt: { exitCode: 0, timedOut: false },
          postconditions: "unknown",
          operatorConfirmed: false,
        },
      },
    });
    expect(decision.outcome).toBe("uncertain");
    expect(decision.automationCredit).toBe(false);
  });

  it("attempts no mutation while ownership is competing or unverifiable", () => {
    for (const probe of [
      {
        result: "competing" as const,
        observedLabels: ["other"],
        evidenceRef: "artifact://raw-command/controller-competing",
      },
      {
        result: "unknown" as const,
        observedLabels: [],
        evidenceRef: "artifact://raw-command/controller-unknown",
      },
    ]) {
      expect(canMutate(component("opsd"), probe).ok).toBe(false);
    }
    for (const owner of ["external", "none"] as const) {
      expect(
        canMutate(component(owner), {
          result: "clear",
          observedLabels: [],
          evidenceRef: "artifact://raw-command/controller-clear",
        }).ok,
      ).toBe(false);
    }
  });

  it("charges no attempt for a crash before the intent landed", () => {
    // Events 1-5 stop before action-intent-recorded. Nothing was spawned, so
    // nothing may be counted as an attempt against the recovery budget.
    const state = crashAfter(5, false).state();
    expect(state.actions["act-1"].state).toBe("authorized");
    expect(state.actions["act-1"].argv).toBeUndefined();
  });
});
