import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import type { CheckDefinition } from "@helium/core/operations/check.js";
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
import {
  FileComponentActionLocks,
  type ComponentActionLockPort,
} from "./component-action-lock.js";
import { FileRecoveryEvidenceStore } from "./recovery-evidence-store.js";
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

function sop(authority: SopAuthority, graceMs = 0): SopDefinition {
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
    graceMs,
    maxAttempts: 2,
    cooldownMs: 60_000,
  };
}

function registry(
  authority: SopAuthority,
  options: {
    manifest?: boolean;
    graceMs?: number;
    componentOwner?: "opsd" | "external" | "none";
    checkExpectedValue?: boolean;
  } = { manifest: true },
): ComponentRegistry {
  const definition = sop(authority, options.graceMs);
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
    components: [{
      ...component,
      mutationOwner: {
        ...component.mutationOwner,
        owner: options.componentOwner ?? "opsd",
      },
    }],
    checks: [{
      ...check,
      expect: {
        ...check.expect,
        value: options.checkExpectedValue ?? check.expect.value,
      },
    }],
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
  baselineState?: "pass" | "fail" | "unknown";
  controllerResults?: Array<"clear" | "competing" | "unknown">;
  rivalAppearsDuringBaseline?: boolean;
  graceMs?: number;
  postconditionStates?: Array<"pass" | "fail" | "unknown">;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  graceIntervalMs?: number;
  componentLocks?: ComponentActionLockPort;
  store?: MemoryStore;
  stateDir?: string;
  componentOwner?: "opsd" | "external" | "none";
  emptyRegistry?: boolean;
  checkExpectedValue?: boolean;
  sampledChecks?: CheckDefinition[][];
  postconditionStateFor?: (
    checks: readonly CheckDefinition[],
  ) => "pass" | "fail" | "unknown";
}

function harness(options: HarnessOptions) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "helium-controller-unit-"));
  const store = options.store ?? new MemoryStore();
  const now = options.now ?? (() => NOW);
  const executor = new FakeExecutor();
  const approvals = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
  let observationSequence = 0;
  let factoryCalls = 0;
  let probeIndex = 0;
  let rivalAppeared = false;
  let postconditionIndex = 0;
  const controllerResults = options.controllerResults ?? ["clear"];

  const sample = (
    state: "pass" | "fail" | "unknown",
    checkId = check.id,
  ): PostconditionSample[] => [
    {
      checkId,
      state,
      observedAt: NOW.toISOString(),
      evidenceRefs: [`artifact://check/${state}`],
    },
  ];

  const controller = new OpsController({
    mode: options.mode,
    registry: options.emptyRegistry === true
      ? new ComponentRegistry({
          authority: { unavailableReason: "release-config-removed" },
          registeredProbeIds: [],
          now,
        })
      : registry(options.authority ?? "auto", {
          manifest: options.manifest,
          graceMs: options.graceMs,
          componentOwner: options.componentOwner,
          checkExpectedValue: options.checkExpectedValue,
        }),
    store,
    now,
    collect: async (sink) => {
      if (options.emptyRegistry === true) return { observations: [], failures: [] };
      const observation = failingObservation(++observationSequence);
      await sink.append(observation);
      return { observations: [observation], failures: [] };
    },
    runChecks: async () => ({}),
    sampleChecks: async (checks, phase) => {
      options.sampledChecks?.push(checks.map((definition) => structuredClone(definition)));
      const checkId = checks[0]?.id ?? check.id;
      if (phase === "baseline") {
        rivalAppeared = options.rivalAppearsDuringBaseline === true;
        return sample(
          options.baselineState ?? (options.baselinePassing === true ? "pass" : "fail"),
          checkId,
        );
      }
      return sample(
        options.postconditionStateFor?.(checks) ??
          options.postconditionStates?.[
            Math.min(postconditionIndex++, options.postconditionStates.length - 1)
          ] ?? "pass",
        checkId,
      );
    },
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
    componentLocks: options.componentLocks ?? new FileComponentActionLocks({
      dir: join(stateDir, "locks"),
      bootId: "boot-test",
    }),
    approvals,
    evidence: new FileRecoveryEvidenceStore(join(stateDir, "evidence"), {
      readSourceArtifact: (ref) => JSON.stringify({ ref }),
    }),
    createExecutor() {
      factoryCalls += 1;
      return executor;
    },
    argvFor: () => [],
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.graceIntervalMs === undefined
      ? {}
      : { graceIntervalMs: options.graceIntervalMs }),
  });

  return {
    store,
    executor,
    approvals,
    controller,
    stateDir,
    evidence: new FileRecoveryEvidenceStore(join(stateDir, "evidence"), {
      readSourceArtifact: (ref) => JSON.stringify({ ref }),
    }),
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

  it("records a failed automatic recovery as FAILED with a failing verifier", async () => {
    const h = harness({ mode: "auto", postconditionStates: ["fail"] });
    await h.controller.tick();
    const terminal = h.store.events.find((event) => event.type === "action-verified");
    expect(terminal?.type).toBe("action-verified");
    if (terminal?.type !== "action-verified") throw new Error("missing terminal event");
    const bundle = JSON.parse(
      readFileSync(join(h.stateDir, "evidence", terminal.recoveryEvidence.ref.split("/").at(-1)!), "utf8"),
    );
    expect(bundle).toMatchObject({
      outcome: "failed",
      status: "FAILED",
      verifier: { decision: "fail" },
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

  it("refuses an approved mutation when any fresh baseline result is unknown", async () => {
    const h = harness({
      mode: "approve",
      authority: "approve",
      baselineState: "unknown",
    });
    await h.controller.tick();
    h.approvals.accept(signApproval("approval-unknown-baseline-1"));

    const result = await h.controller.tick();

    expect(result.actions[0]).toMatchObject({
      disposition: "observe",
      reason: "baseline-unavailable",
    });
    expect(h.factoryCalls()).toBe(0);
    expect(h.executor.runs).toBe(0);
    expect(h.store.events.map((event) => event.type)).not.toContain(
      "action-intent-recorded",
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

  it("writes and revalidates complete evidence before the terminal assertion", async () => {
    const h = harness({ mode: "auto" });
    await h.controller.tick();
    const terminal = h.store.events.find((event) => event.type === "action-verified");
    expect(terminal).toMatchObject({
      recoveryEvidence: {
        schema: "helium.ops.recovery-evidence/v1",
        assertionId: expect.stringMatching(/^recovery-act-/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(() => h.evidence.verifyHistory(h.store.replay())).not.toThrow();
  });

  it("waits through the declared grace window and records every sample", async () => {
    let nowMs = NOW.getTime();
    const h = harness({
      mode: "auto",
      graceMs: 2_000,
      graceIntervalMs: 1_000,
      postconditionStates: ["fail", "pass"],
      now: () => new Date(nowMs),
      sleep: async (ms) => { nowMs += ms; },
    });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({ outcome: "succeeded" });
    const terminal = h.store.events.find((event) => event.type === "action-verified");
    expect(terminal?.type === "action-verified" && terminal.postconditionSamples).toHaveLength(2);
  });

  it("uses one OS-atomic lock across controllers with independent lease tables", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "helium-controller-race-"));
    const locks = new FileComponentActionLocks({ dir: lockDir, bootId: "boot-race" });
    const first = harness({ mode: "auto", componentLocks: locks });
    const second = harness({ mode: "auto", componentLocks: locks });
    const results = await Promise.all([first.controller.tick(), second.controller.tick()]);
    expect(first.executor.runs + second.executor.runs).toBe(1);
    expect(results.flatMap((result) => result.actions).map((action) => action.disposition).sort())
      .toEqual(["execute", "observe"]);
    expect(results.flatMap((result) => result.actions).find((action) => action.disposition === "observe"))
      .toMatchObject({ reason: "component-lock-held" });
  });

  it("reclaims a dead pre-intent component lock even when no action event exists", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "helium-controller-orphan-lock-"));
    const orphanOwner = new FileComponentActionLocks({
      dir: lockDir,
      bootId: "boot-orphan",
      pid: 999_999,
      isAlive: () => false,
    });
    expect(orphanOwner.acquire({
      componentId: component.id,
      leaseId: "lease-orphan",
      sopDigest: digest,
      acquiredAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }).ok).toBe(true);

    const h = harness({
      mode: "auto",
      componentLocks: new FileComponentActionLocks({
        dir: lockDir,
        bootId: "boot-orphan",
        isAlive: () => false,
      }),
    });
    const result = await h.controller.tick();
    expect(result.actions[0]).toMatchObject({
      disposition: "execute",
      outcome: "succeeded",
    });
    expect(h.executor.runs).toBe(1);
  });

  it("reconciles a persisted intent to uncertain on startup and never reruns it", async () => {
    const seed = harness({ mode: "auto" });
    const incidentKey = "fixture-service|integrity|failed|fixture-service";
    const incidentId = `inc-${createHash("sha256").update(incidentKey).digest("hex").slice(0, 32)}`;
    const baseline = {
      checkId: check.id,
      state: "fail" as const,
      observedAt: NOW.toISOString(),
      evidenceRefs: ["artifact://check/fail"],
    };
    for (const event of [
      { v: 1, id: "restart-observation", at: NOW.toISOString(), type: "observation-recorded", observation: failingObservation(99) },
      { v: 1, id: "restart-incident", at: NOW.toISOString(), type: "incident-opened", incidentId, componentId: component.id, dimension: "integrity", observationIds: ["obs-fixture-99"] },
      { v: 1, id: "restart-proposed", at: NOW.toISOString(), type: "action-proposed", actionId: "act-restart", incidentId, componentId: component.id, sopId: "repair-fixture", sopVersion: 1, sopDigest: digest },
      { v: 1, id: "restart-authorized", at: NOW.toISOString(), type: "action-authorized", actionId: "act-restart", authority: "auto", authorityManifestEntry: { sopId: "repair-fixture", version: 1, digest, authority: "auto" } },
      { v: 1, id: "restart-intent", at: NOW.toISOString(), type: "action-intent-recorded", actionId: "act-restart", leaseId: "lease-restart", operationId: "op-restart", argv: [], baseline: { capturedAt: NOW.toISOString(), samples: [baseline], allPassing: false }, controllerProbe: { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/restart" }, eligibility: { eligible: true, reasons: [] }, mutationOwner: component.mutationOwner, dependencyIds: ["decision-time-dependency"], verificationPolicy: { postconditions: [check], graceMs: 0 } },
    ]) seed.store.append(event);

    const restarted = harness({
      mode: "auto",
      store: seed.store,
      stateDir: seed.stateDir,
      emptyRegistry: true,
    });
    await restarted.controller.tick();
    expect(seed.store.state().actions["act-restart"]?.state).toBe("uncertain");
    expect(restarted.executor.runs).toBe(0);
    expect(seed.store.events.filter((event) => event.type === "action-verified")).toHaveLength(1);
    const terminal = seed.store.events.find((event) => event.type === "action-verified");
    if (terminal?.type !== "action-verified") throw new Error("missing terminal event");
    const bundle = JSON.parse(readFileSync(
      join(seed.stateDir, "evidence", terminal.recoveryEvidence.ref.split("/").at(-1)!),
      "utf8",
    ));
    expect(bundle).toMatchObject({
      eligibility: { eligible: true, reasons: [] },
      mutationOwner: { owner: "opsd" },
    });
    const incidentSnapshot = JSON.parse(readFileSync(
      join(seed.stateDir, "evidence", bundle.incidentSnapshot.ref.split("/").at(-1)!),
      "utf8",
    ));
    expect(incidentSnapshot.dependencyIds).toEqual(["decision-time-dependency"]);
  });

  it("reconciles an executed action against its persisted check definition, not a same-id replacement", async () => {
    const seed = harness({ mode: "auto" });
    const incidentKey = "fixture-service|integrity|failed|fixture-service";
    const incidentId = `inc-${createHash("sha256").update(incidentKey).digest("hex").slice(0, 32)}`;
    const baseline = {
      checkId: check.id,
      state: "fail" as const,
      observedAt: NOW.toISOString(),
      evidenceRefs: ["artifact://check/fail"],
    };
    for (const event of [
      { v: 1, id: "changed-observation", at: NOW.toISOString(), type: "observation-recorded", observation: failingObservation(100) },
      { v: 1, id: "changed-incident", at: NOW.toISOString(), type: "incident-opened", incidentId, componentId: component.id, dimension: "integrity", observationIds: ["obs-fixture-100"] },
      { v: 1, id: "changed-proposed", at: NOW.toISOString(), type: "action-proposed", actionId: "act-changed", incidentId, componentId: component.id, sopId: "repair-fixture", sopVersion: 1, sopDigest: digest },
      { v: 1, id: "changed-authorized", at: NOW.toISOString(), type: "action-authorized", actionId: "act-changed", authority: "auto", authorityManifestEntry: { sopId: "repair-fixture", version: 1, digest, authority: "auto" } },
      { v: 1, id: "changed-intent", at: NOW.toISOString(), type: "action-intent-recorded", actionId: "act-changed", leaseId: "lease-changed", operationId: "op-changed", argv: [], baseline: { capturedAt: NOW.toISOString(), samples: [baseline], allPassing: false }, controllerProbe: { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/changed" }, eligibility: { eligible: true, reasons: [] }, mutationOwner: component.mutationOwner, dependencyIds: [], verificationPolicy: { postconditions: [check], graceMs: 0 } },
      { v: 1, id: "changed-receipt", at: NOW.toISOString(), type: "action-receipt-recorded", actionId: "act-changed", exitCode: 0, timedOut: false, outputDigest: `sha256:${"c".repeat(64)}`, outputTail: "ok", outputBytes: 2, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() },
    ]) seed.store.append(event);

    const sampledChecks: CheckDefinition[][] = [];
    const restarted = harness({
      mode: "auto",
      store: seed.store,
      stateDir: seed.stateDir,
      // The new release reuses the id but reverses the expected value. Its
      // definition would pass; the original probe is unavailable and must be
      // unknown, making the interrupted action uncertain rather than success.
      checkExpectedValue: false,
      sampledChecks,
      postconditionStateFor: (definitions) =>
        definitions[0]?.expect.value === true ? "unknown" : "pass",
    });
    await restarted.controller.tick();

    expect(seed.store.state().actions["act-changed"]?.state).toBe("uncertain");
    expect(restarted.executor.runs).toBe(0);
    expect(sampledChecks).toHaveLength(1);
    expect(sampledChecks[0]?.[0]).toEqual(check);
  });
});
