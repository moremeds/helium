import { generateKeyPairSync, sign } from "node:crypto";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import {
  ActionLeaseController,
  ActionLeaseTable,
} from "@helium/core/operations/lease.js";
import {
  OperationsEventSchema,
  type OperationsEvent,
} from "@helium/core/operations/events.js";
import {
  emptyOperationsState,
  reduceOperations,
  type OperationsState,
} from "@helium/core/operations/reducer.js";
import {
  manifestSigningPayload,
  type AuthorityManifestEntry,
} from "@helium/core/operations/authority-manifest.js";
import type { Observation } from "@helium/core/operations/observation.js";
import type { SopAuthority, SopDefinition } from "@helium/core/operations/sop.js";
import { describe, expect, it } from "vitest";
import { ApprovalLedger, approvalSigningPayload } from "./approval.js";
import {
  OpsController,
  type ActionExecutor,
  type OperationsStorePort,
} from "./controller.js";
import { ComponentRegistry, type OpsBundle } from "./component-registry.js";
import {
  ExecutionSuppressedError,
  type ExecutionGate,
  type ExecutionReceipt,
  type ExecutionRequest,
} from "./script-executor.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

class MemoryStore implements OperationsStorePort {
  readonly events: OperationsEvent[] = [];
  #state: OperationsState = emptyOperationsState();

  append(raw: unknown): OperationsEvent {
    const event = OperationsEventSchema.parse(raw);
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

const component = {
  version: 1 as const,
  id: "fixture-service",
  kind: "service",
  dimensions: ["integrity"],
  mutationOwner: {
    owner: "opsd" as const,
    competingLabels: ["com.fixture.legacy"],
    changedAt: "2026-08-29T00:00:00.000Z",
    changeRef: "artifact://ownership/fixture",
  },
};

const check = {
  id: "fixture-integrity",
  kind: "business" as const,
  probe: { probeId: "fixture.integrity.v1", args: {} },
  expect: { dimension: "integrity", operator: "eq" as const, value: true },
  onUnavailable: "unknown" as const,
  timeoutMs: 5_000,
  owner: "ops",
};

function sop(authority: SopAuthority): SopDefinition {
  return {
    version: 1,
    id: "repair-fixture",
    digest,
    componentId: component.id,
    matches: { dimension: "integrity", failureClass: "failed" },
    authority,
    mutating: true,
    priority: 10,
    action: {
      executorId: "fixture-script",
      executable: {
        path: "/opt/ops/fixture.sh",
        identity: { kind: "sha256", value: "b".repeat(64) },
      },
      argvSchemaId: "fixture-argv-v1",
      cwdId: "ops-workdir",
      environmentProfileId: "ops-minimal",
      timeoutMs: 10_000,
    },
    preconditions: [],
    postconditions: [check.id],
    graceMs: 0,
    maxAttempts: 2,
    cooldownMs: 60_000,
  };
}

function registry(
  authority: SopAuthority,
  options: { manifest?: boolean } = { manifest: true },
): ComponentRegistry {
  const definition = sop(authority);
  const entries: AuthorityManifestEntry[] = [
    {
      sopId: definition.id,
      version: definition.version,
      digest: definition.digest,
      authority,
    },
  ];
  const r = new ComponentRegistry({
    authority:
      options.manifest === false
        ? { unavailableReason: "manifest-missing" }
        : {
            manifest: {
              entries,
              signature: sign(null, manifestSigningPayload(entries), privateKey).toString(
                "base64",
              ),
            },
            trustedKey: publicKey,
          },
    registeredProbeIds: ["fixture.integrity.v1"],
    now: () => NOW,
  });
  r.install({
    tenantId: "fixture",
    components: [component],
    checks: [check],
    sops: [definition],
  } satisfies OpsBundle);
  return r;
}

function failingObservation(sequence: number): Observation {
  return {
    version: 1,
    id: `obs-fixture-${sequence}`,
    componentId: component.id,
    probeId: "fixture.integrity.v1",
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    state: "failed",
    dimension: "integrity",
    value: { integrity: false },
    evidenceRefs: [`artifact://fixture/raw-${sequence}`],
    parserVersion: "fixture/1",
  };
}

class FakeExecutor implements ActionExecutor {
  runs = 0;

  async run(
    request: ExecutionRequest,
    _signal: AbortSignal,
    gate?: ExecutionGate,
  ): Promise<ExecutionReceipt> {
    const decision = await gate?.();
    if (decision !== undefined && !decision.admitted) {
      throw new ExecutionSuppressedError(decision.reason);
    }
    this.runs += 1;
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
  }
}

interface HarnessOptions {
  mode: "observe" | "suggest" | "approve" | "auto";
  authority?: SopAuthority;
  manifest?: boolean;
  baselinePassing?: boolean;
  controllerResults?: Array<"clear" | "competing" | "unknown">;
  rivalAppearsDuringBaseline?: boolean;
}

function harness(options: HarnessOptions) {
  const store = new MemoryStore();
  const executor = new FakeExecutor();
  const approvals = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
  let observationSequence = 0;
  let factoryCalls = 0;
  let probeIndex = 0;
  let rivalAppeared = false;
  const controllerResults = options.controllerResults ?? ["clear"];

  const sample = (state: "pass" | "fail"): PostconditionSample[] => [
    {
      checkId: check.id,
      state,
      observedAt: NOW.toISOString(),
      evidenceRefs: [`artifact://check/${state}`],
    },
  ];

  const controller = new OpsController({
    mode: options.mode,
    registry: registry(options.authority ?? "auto", {
      manifest: options.manifest,
    }),
    store,
    now: () => NOW,
    collect: async (sink) => {
      const observation = failingObservation(++observationSequence);
      await sink.append(observation);
      return { observations: [observation], failures: [] };
    },
    runChecks: async () => ({}),
    sampleChecks: async (_ids, phase) =>
      phase === "baseline"
        ? (() => {
            rivalAppeared = options.rivalAppearsDuringBaseline === true;
            return sample(options.baselinePassing === true ? "pass" : "fail");
          })()
        : sample("pass"),
    controllerProbe: {
      async check() {
        const result = rivalAppeared
          ? "competing"
          : controllerResults[Math.min(probeIndex++, controllerResults.length - 1)]!;
        return {
          result,
          observedLabels:
            result === "competing" ? ["com.fixture.legacy"] : [],
          evidenceRef: `artifact://controller/${probeIndex}`,
        };
      },
    },
    leases: new ActionLeaseController(new ActionLeaseTable(), {
      controllerId: "test-controller",
      ttlMs: 60_000,
      now: () => NOW,
    }),
    approvals,
    createExecutor() {
      factoryCalls += 1;
      return executor;
    },
    argvFor: () => [],
  });

  return {
    store,
    executor,
    approvals,
    controller,
    factoryCalls: () => factoryCalls,
  };
}

function signApproval(nonce: string) {
  const unsigned = {
    kind: "approval" as const,
    operatorId: "operator-1",
    nonce,
    issuedAt: "2026-08-29T23:59:00.000Z",
    approval: {
      incidentId: "fixture-service|integrity|failed|fixture-service",
      sopId: "repair-fixture",
      sopVersion: 1,
      sopDigest: digest,
      expiresAt: "2026-08-30T00:10:00.000Z",
    },
  };
  return {
    ...unsigned,
    signature: sign(null, approvalSigningPayload(unsigned), privateKey).toString(
      "base64",
    ),
  };
}

describe("OpsController modes", () => {
  it("observe records observations and incidents but creates no proposal or executor", async () => {
    const h = harness({ mode: "observe" });
    const result = await h.controller.tick();
    expect(result.incidents).toHaveLength(1);
    expect(h.store.events.map((event) => event.type)).toEqual([
      "observation-recorded",
      "incident-opened",
      "incident-updated",
    ]);
    expect(h.factoryCalls()).toBe(0);
  });

  it("suggest records a proposal but never instantiates the executor", async () => {
    const h = harness({ mode: "suggest" });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({ disposition: "propose" });
    expect(h.store.events.map((event) => event.type)).toContain("action-proposed");
    expect(h.factoryCalls()).toBe(0);
    expect(h.executor.runs).toBe(0);
  });

  it("approve holds a proposal until a matching signed approval arrives", async () => {
    const h = harness({ mode: "approve", authority: "approve" });
    expect((await h.controller.tick()).actions[0]).toMatchObject({
      disposition: "propose",
      reason: "approval-required",
    });
    expect(h.factoryCalls()).toBe(0);

    h.approvals.accept(signApproval("approval-controller-1"));
    const second = await h.controller.tick();
    expect(second.actions[0]).toMatchObject({
      disposition: "execute",
      outcome: "succeeded",
    });
    expect(h.executor.runs).toBe(1);
    expect(
      h.store.events.find((event) => event.type === "action-authorized"),
    ).toMatchObject({ approvedBy: "operator-1" });
  });

  it("auto executes a certified auto SOP through intent, receipt and verification", async () => {
    const h = harness({ mode: "auto" });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({
      disposition: "execute",
      outcome: "succeeded",
    });
    expect(h.store.events.map((event) => event.type)).toEqual([
      "observation-recorded",
      "incident-opened",
      "incident-updated",
      "action-proposed",
      "action-authorized",
      "action-intent-recorded",
      "action-receipt-recorded",
      "action-verified",
    ]);
    expect(h.executor.runs).toBe(1);
    expect(
      h.store.events.find((event) => event.type === "action-authorized"),
    ).toMatchObject({
      authority: "auto",
      authorityManifestEntry: {
        sopId: "repair-fixture",
        version: 1,
        digest,
        authority: "auto",
      },
    });
  });

  it("a missing authority manifest starts and observes but cannot instantiate execution", async () => {
    const h = harness({ mode: "auto", manifest: false });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({ disposition: "observe" });
    expect(h.factoryCalls()).toBe(0);
    expect(h.store.events.map((event) => event.type)).not.toContain(
      "action-proposed",
    );
  });

  it("records not-needed and performs no spawn when the fresh baseline already passes", async () => {
    const h = harness({ mode: "auto", baselinePassing: true });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({
      disposition: "execute",
      outcome: "not-needed",
    });
    expect(h.executor.runs).toBe(0);
    expect(h.store.events.map((event) => event.type)).not.toContain(
      "action-intent-recorded",
    );
    expect(h.store.state().actions[result.actions[0]!.actionId!]?.state).toBe(
      "not-needed",
    );
  });

  it("rechecks controller ownership at the execution boundary and refuses a late rival", async () => {
    const h = harness({
      mode: "auto",
      controllerResults: ["clear", "competing"],
    });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({
      disposition: "observe",
      reason: "competing-controller",
      controllerEvidenceRef: "artifact://controller/2",
    });
    expect(h.executor.runs).toBe(0);
    expect(h.store.events.map((event) => event.type)).not.toContain(
      "action-intent-recorded",
    );
  });

  it("rechecks after the async baseline and records no intent when a rival appears there", async () => {
    const h = harness({
      mode: "auto",
      rivalAppearsDuringBaseline: true,
    });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({
      disposition: "observe",
      reason: "competing-controller",
    });
    expect(h.executor.runs).toBe(0);
    expect(h.store.events.map((event) => event.type)).not.toContain(
      "action-intent-recorded",
    );
  });
});
