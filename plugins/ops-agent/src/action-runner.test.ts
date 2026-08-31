import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { ScriptExecutor } from "./script-executor.js";
import { ScriptRegistry, type RegisteredScript } from "./script-registry.js";

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
          request.onSpawn?.(process.pid);
          trace.push("executor:adopt");
          trace.push("executor:spawn");
          request.onExecutionReleased?.(process.pid);
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
        preSpawn: () => trace.push("scope:revalidate"),
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
      "scope:revalidate",
      "event:action-proposed",
      "event:action-authorized",
      "event:action-intent-recorded",
      "executor:adopt",
      "executor:spawn",
      "event:action-child-adopted",
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

  it("does not release the component lock while an adopted writer descendant survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-action-runner-group-lock-"));
    const lockDir = join(root, "locks");
    const descendantPidPath = join(root, "descendant.pid");
    const wrapper = join(root, "writer.sh");
    writeFileSync(wrapper, [
      "#!/bin/bash",
      "set -euo pipefail",
      "IFS= read -r gate <&3",
      "[ \"$gate\" = go ]",
      `/bin/sleep 30 >/dev/null 2>&1 3>&- & printf '%s' \"$!\" >${JSON.stringify(descendantPidPath)}`,
      "kill -KILL $$",
      "",
    ].join("\n"), { mode: 0o500 });
    chmodSync(wrapper, 0o500);
    const registered: RegisteredScript = {
      executorId: "livewire-repair",
      path: wrapper,
      identity: {
        kind: "sha256",
        value: createHash("sha256").update(readFileSync(wrapper)).digest("hex"),
      },
      argvSchema: { id: "livewire-repair-v1", params: [] },
      cwd: root,
      environmentProfile: { PATH: "/usr/bin:/bin" },
      timeoutMs: 60_000,
      maxOutputBytes: 1_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    };
    const locks = new FileComponentActionLocks({ dir: lockDir, bootId: "boot-test" });
    const store = new MemoryStore([]);
    let id = 0;
    const makeRunner = () => new CertifiedActionRunner({
      store,
      now: () => NOW,
      nextId: (prefix) => `${prefix}-${++id}`,
      sampleChecks: async () => [sample("fail")],
      sampleGrace: async () => ({ verdict: "unknown", samples: [sample("fail")] }),
      controllerProbe: {
        async check() {
          return { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/clear" };
        },
      },
      leases: new ActionLeaseController(new ActionLeaseTable(), {
        controllerId: `runner-${id}`,
        ttlMs: 60_000,
        now: () => NOW,
      }),
      componentLocks: locks,
      createExecutor: () => new ScriptExecutor(ScriptRegistry.load([registered])),
    });
    const hooksFor = (actionId: string, incidentId: string) => ({
      ensureProposed() {
        store.append({
          v: 1, id: `${actionId}-proposed`, at: NOW.toISOString(), type: "action-proposed",
          actionId, incidentId, componentId: component.id, sopId: "repair", sopVersion: 1,
          sopDigest: digest,
        });
      },
      ensureAuthorized() {
        store.append({
          v: 1, id: `${actionId}-authorized`, at: NOW.toISOString(), type: "action-authorized",
          actionId, authority: "auto",
        });
      },
      recordTerminal(outcome: "succeeded" | "failed" | "uncertain" | "not-needed" | "external-recovery", samples: PostconditionSample[]) {
        store.append({
          v: 1, id: `${actionId}-verified`, at: NOW.toISOString(), type: "action-verified",
          actionId, outcome, postconditionRefs: samples.map((row) => row.checkId),
          postconditionSamples: samples,
          recoveryEvidence: {
            ref: `artifact://recovery/${actionId}`, sha256: "d".repeat(64),
            schema: "helium.ops.recovery-evidence/v1", assertionId: `recovery-${actionId}`,
          },
        });
      },
    });
    const requestFor = (actionId: string, incidentId: string) => ({
      scopeId: `${actionId}:sha256:${"2".repeat(64)}`,
      actionId,
      attempt: 1,
      incidentId,
      component,
      sop: { id: "repair", digest, executorId: registered.executorId, postconditions: [check.id] },
      argv: [] as string[],
      verificationPolicy: { postconditions: [check], graceMs: 0 },
      eligibility: { eligible: true, reasons: [] as string[] },
      mutationOwner: component.mutationOwner,
      dependencyIds: () => [] as string[],
    });

    const first = await makeRunner().run(
      requestFor("act-orphan", "inc-orphan"),
      hooksFor("act-orphan", "inc-orphan"),
      new AbortController().signal,
    );
    expect(first.disposition).toBe("execute");
    expect(existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    const second = await makeRunner().run(
      requestFor("act-overlap", "inc-overlap"),
      hooksFor("act-overlap", "inc-overlap"),
      new AbortController().signal,
    );
    expect(second).toMatchObject({ disposition: "observe", reason: "component-lock-held" });

    try { process.kill(-Number(readFileSync(descendantPidPath, "utf8")), "SIGKILL"); } catch {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 15_000);
});
