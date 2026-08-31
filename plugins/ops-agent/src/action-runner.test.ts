import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import {
  OperationsEventSchema,
  type OperationsEvent,
} from "@helium/core/operations/events.js";
import { ActionLeaseController, ActionLeaseTable } from "@helium/core/operations/lease.js";
import {
  emptyOperationsState,
  reduceOperations,
  type OperationsState,
} from "@helium/core/operations/reducer.js";
import { describe, expect, it } from "vitest";
import { CertifiedActionRunner, type OperationsStorePort } from "./action-runner.js";
import { FileComponentActionLocks } from "./component-action-lock.js";

const NOW = new Date("2026-08-31T00:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;
const check = {
  id: "ready",
  kind: "business" as const,
  probe: { probeId: "fixture.ready.v1", args: {} },
  expect: { dimension: "integrity", operator: "eq" as const, value: true },
  onUnavailable: "unknown" as const,
  timeoutMs: 1_000,
  owner: "ops",
};
const component = {
  version: 1 as const,
  id: "livewire",
  kind: "data-pipeline",
  mutationOwner: {
    owner: "opsd" as const,
    competingLabels: [],
    changedAt: NOW.toISOString(),
    changeRef: "artifact://ownership/livewire",
  },
};

class MemoryStore implements OperationsStorePort {
  readonly events: OperationsEvent[] = [];
  #state: OperationsState = emptyOperationsState();

  constructor(private readonly trace: string[]) {}

  append(raw: unknown): OperationsEvent {
    const event = OperationsEventSchema.parse(raw);
    this.trace.push(`event:${event.type}`);
    this.#state = reduceOperations([event], this.#state);
    this.events.push(event);
    return event;
  }

  state(): OperationsState {
    return this.#state;
  }

  replay(): OperationsEvent[] {
    return [...this.events];
  }
}

const sample = (state: "pass" | "fail"): PostconditionSample => ({
  checkId: check.id,
  state,
  observedAt: NOW.toISOString(),
  evidenceRefs: [`artifact://check/${state}`],
});

describe("CertifiedActionRunner", () => {
  it("runs a scoped request through the certified intent-before-spawn transaction", async () => {
    const trace: string[] = [];
    const store = new MemoryStore(trace);
    let id = 0;
    const runner = new CertifiedActionRunner({
      store,
      now: () => NOW,
      nextId: (prefix) => `${prefix}-${++id}`,
      sampleChecks: async () => {
        trace.push("checks:baseline");
        return [sample("fail")];
      },
      sampleGrace: async () => {
        trace.push("checks:postcondition");
        return { verdict: "pass", samples: [sample("pass")] };
      },
      controllerProbe: {
        async check() {
          trace.push("controller-probe");
          return {
            result: "clear",
            observedLabels: [],
            evidenceRef: "artifact://controller/clear",
          };
        },
      },
      leases: new ActionLeaseController(new ActionLeaseTable(), {
        controllerId: "runner-test",
        ttlMs: 60_000,
        now: () => NOW,
      }),
      componentLocks: new FileComponentActionLocks({
        dir: mkdtempSync(join(tmpdir(), "helium-action-runner-lock-")),
        bootId: "boot-test",
      }),
      createExecutor: () => ({
        async run(request, _signal, gate) {
          trace.push(`executor:gate:${request.executorId}`);
          const admitted = await gate?.();
          if (admitted?.admitted !== true) throw new Error("runner gate refused fixture");
          trace.push("executor:spawn");
          return {
            actionId: request.actionId,
            executorId: request.executorId,
            argv: request.argv,
            exit: { code: 0, signal: null },
            timedOut: false,
            outputTail: "ok",
            outputBytes: 2,
            outputDigest: `sha256:${"c".repeat(64)}`,
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
          };
        },
      }),
    });
    const ensureProposed = () => store.append({
      v: 1,
      id: "proposed-1",
      at: NOW.toISOString(),
      type: "action-proposed",
      actionId: "act-1",
      incidentId: "inc-1",
      componentId: component.id,
      sopId: "repair",
      sopVersion: 1,
      sopDigest: digest,
    });
    const ensureAuthorized = () => store.append({
      v: 1,
      id: "authorized-1",
      at: NOW.toISOString(),
      type: "action-authorized",
      actionId: "act-1",
      authority: "auto",
    });

    const result = await runner.run(
      {
        scopeId: `lws-${"1".repeat(32)}:sha256:${"2".repeat(64)}`,
        actionId: "act-1",
        attempt: 1,
        incidentId: "inc-1",
        component,
        sop: {
          id: "repair",
          digest,
          executorId: "livewire-repair",
          postconditions: [check.id],
        },
        argv: ["--manifest", "/var/db/helium/ready/manifest.json"],
        verificationPolicy: { postconditions: [check], graceMs: 0 },
        eligibility: { eligible: true, reasons: [] },
        mutationOwner: component.mutationOwner,
        dependencyIds: () => [],
      },
      {
        ensureProposed,
        ensureAuthorized,
        recordTerminal(outcome, samples) {
          store.append({
            v: 1,
            id: "verified-1",
            at: NOW.toISOString(),
            type: "action-verified",
            actionId: "act-1",
            outcome,
            postconditionRefs: samples.map((row) => row.checkId),
            postconditionSamples: samples,
            recoveryEvidence: {
              ref: "artifact://recovery/act-1",
              sha256: "d".repeat(64),
              schema: "helium.ops.recovery-evidence/v1",
              assertionId: "recovery-act-1",
            },
          });
        },
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ disposition: "execute", outcome: "succeeded" });
    expect(trace).toEqual([
      "controller-probe",
      "checks:baseline",
      "executor:gate:livewire-repair",
      "controller-probe",
      "event:action-proposed",
      "event:action-authorized",
      "event:action-intent-recorded",
      "executor:spawn",
      "event:action-receipt-recorded",
      "checks:postcondition",
      "event:action-verified",
    ]);
  });

  it("rejects an empty generic scope before any controller probe or mutation", async () => {
    const trace: string[] = [];
    const store = new MemoryStore(trace);
    const runner = new CertifiedActionRunner({
      store,
      now: () => NOW,
      nextId: (prefix) => `${prefix}-1`,
      sampleChecks: async () => [],
      sampleGrace: async () => ({ verdict: "unknown", samples: [] }),
      controllerProbe: { async check() { throw new Error("must not probe"); } },
      leases: new ActionLeaseController(new ActionLeaseTable(), {
        controllerId: "runner-test",
        ttlMs: 60_000,
        now: () => NOW,
      }),
      componentLocks: new FileComponentActionLocks({
        dir: mkdtempSync(join(tmpdir(), "helium-action-runner-empty-lock-")),
        bootId: "boot-test",
      }),
      createExecutor: () => { throw new Error("must not create executor"); },
    });

    await expect(runner.run({
      scopeId: "",
      actionId: "act-1",
      attempt: 1,
      incidentId: "inc-1",
      component,
      sop: { id: "repair", digest, executorId: "livewire-repair", postconditions: [check.id] },
      argv: [],
      verificationPolicy: { postconditions: [check], graceMs: 0 },
      eligibility: { eligible: true, reasons: [] },
      mutationOwner: component.mutationOwner,
      dependencyIds: () => [],
    }, {
      ensureProposed() {},
      ensureAuthorized() {},
      recordTerminal() {},
    }, new AbortController().signal)).rejects.toThrow(/scope id is invalid/);
    expect(trace).toEqual([]);
  });
});
