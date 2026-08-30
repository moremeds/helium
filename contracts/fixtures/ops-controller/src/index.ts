/**
 * Completely local fake host for the Ops adversarial contracts.
 *
 * It has no command runner and cannot touch launchd, Docker, PostgreSQL,
 * mounts, or the network. The only "side effect" is an integer in this object,
 * which lets a contract count one-or-zero admitted mutations independently of
 * provider capacity.
 */
export type FakeQuotaState = "available" | "quota-exhausted";

export interface FakeOpsHostOptions {
  providerQuota?: Record<string, FakeQuotaState>;
  exitCode?: number;
}

export interface FakePermission {
  admitted: boolean;
  reason?: string;
}

export class FakeOpsHost {
  readonly providerQuota: Record<string, FakeQuotaState>;
  sideEffects = 0;
  providerCalls = 0;

  constructor(private readonly options: FakeOpsHostOptions = {}) {
    this.providerQuota = { ...(options.providerQuota ?? {}) };
  }

  async execute(permission: FakePermission): Promise<{ exitCode: number; sideEffect: boolean }> {
    if (!permission.admitted) {
      return { exitCode: 126, sideEffect: false };
    }
    // Provider state is intentionally not read. This fixture represents the
    // deterministic executor boundary, not the optional analysis path.
    this.sideEffects += 1;
    return {
      exitCode: this.options.exitCode ?? 0,
      sideEffect: true,
    };
  }
}

import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import {
  ActionLeaseController,
  ActionLeaseTable,
  OperationsStore,
  manifestSigningPayload,
  type AuthorityManifestEntry,
  type Observation,
  type OperationsEvent,
  type OperationsState,
  type PostconditionSample,
  type SopDefinition,
} from "@helium/core";
import {
  ApprovalLedger,
  ComponentRegistry,
  ExecutionSuppressedError,
  OpsController,
  FileComponentActionLocks,
  FileRecoveryEvidenceStore,
  DurableOpsAnalysisClient,
  type ExecutionGate,
  type ExecutionReceipt,
  type ExecutionRequest,
  type ControllerTickResult,
} from "dsh-plugin-ops-agent";

export interface ControllerScenario {
  stateDir: string;
  baselinePassing?: boolean;
  lateRival?: boolean;
  operatorDuringExecution?: boolean;
  exitCode?: number;
  postconditionsPassing?: boolean;
  providerQuota?: Record<string, FakeQuotaState>;
}

export interface ControllerScenarioResult {
  tick: ControllerTickResult;
  sideEffects: number;
  providerCalls: number;
  providerQuota: Record<string, FakeQuotaState>;
  events: OperationsEvent[];
  state: OperationsState;
}

/** Run one complete tick through the real production OpsController. */
export async function runControllerScenario(
  options: ControllerScenario,
): Promise<ControllerScenarioResult> {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const digest = `sha256:${"a".repeat(64)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const component = {
    version: 1 as const,
    id: "fixture-service",
    kind: "service",
    dimensions: ["integrity"],
    mutationOwner: {
      owner: "opsd" as const,
      competingLabels: ["legacy.controller"],
      changedAt: "2026-08-29T00:00:00.000Z",
      changeRef: "artifact://fixture/ownership",
    },
  };
  const check = {
    id: "fixture-integrity",
    kind: "business" as const,
    probe: { probeId: "fixture.integrity.v1", args: {} },
    expect: { dimension: "integrity", operator: "eq" as const, value: true },
    onUnavailable: "unknown" as const,
    timeoutMs: 1_000,
    owner: "contract",
  };
  const sop: SopDefinition = {
    version: 1,
    id: "fixture-repair",
    digest,
    componentId: component.id,
    matches: { dimension: "integrity", failureClass: "failed" },
    authority: "auto",
    mutating: true,
    priority: 1,
    action: {
      executorId: "fixture-executor",
      executable: {
        path: "/fixture/never-run",
        identity: { kind: "sha256", value: "b".repeat(64) },
      },
      argvSchemaId: "fixture-argv",
      cwdId: "fixture-cwd",
      environmentProfileId: "fixture-env",
      timeoutMs: 1_000,
    },
    preconditions: [],
    postconditions: [check.id],
    graceMs: 0,
    maxAttempts: 1,
    cooldownMs: 0,
  };
  const entry: AuthorityManifestEntry = {
    sopId: sop.id,
    version: sop.version,
    digest: sop.digest,
    authority: sop.authority,
  };
  const registry = new ComponentRegistry({
    authority: {
      manifest: {
        entries: [entry],
        signature: sign(null, manifestSigningPayload([entry]), privateKey).toString("base64"),
      },
      trustedKey: publicKey,
    },
    registeredProbeIds: [check.probe.probeId],
    now: () => now,
  });
  registry.install({
    tenantId: "fixture",
    components: [component],
    checks: [check],
    sops: [sop],
  });

  const store = OperationsStore.open(options.stateDir, { sync: () => {} });
  let eventSequence = store.replay().length;
  let probeCount = 0;
  let sideEffects = 0;
  let providerCalls = 0;
  const sample = (state: "pass" | "fail"): PostconditionSample[] => [{
    checkId: check.id,
    state,
    observedAt: now.toISOString(),
    evidenceRefs: [`artifact://fixture/check-${state}`],
  }];
  const executor = {
    async run(
      request: ExecutionRequest,
      _signal: AbortSignal,
      gate?: ExecutionGate,
    ): Promise<ExecutionReceipt> {
      const permission = await gate?.();
      if (permission !== undefined && !permission.admitted) {
        throw new ExecutionSuppressedError(permission.reason);
      }
      sideEffects += 1;
      if (options.operatorDuringExecution === true) {
        store.append({
          v: 1,
          id: `fixture-operator-${++eventSequence}`,
          at: now.toISOString(),
          type: "operator-intervened",
          componentId: component.id,
          kind: "manual-repair",
          confirmed: true,
        });
      }
      return {
        actionId: request.actionId,
        executorId: request.executorId,
        argv: request.argv,
        exit: { code: options.exitCode ?? 0, signal: null },
        timedOut: false,
        outputTail: "fixture",
        outputBytes: 7,
        outputDigest: `sha256:${"c".repeat(64)}`,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
      };
    },
  };
  let observationSequence = 0;
  const controller = new OpsController({
    mode: "auto",
    registry,
    store,
    now: () => now,
    collect: async (sink) => {
      const observation: Observation = {
        version: 1,
        id: `fixture-observation-${++observationSequence}`,
        componentId: component.id,
        probeId: check.probe.probeId,
        observedAt: now.toISOString(),
        expiresAt: "2026-08-30T00:05:00.000Z",
        state: "failed",
        dimension: "integrity",
        evidenceRefs: ["artifact://fixture/observation"],
        parserVersion: "fixture/1",
      };
      await sink.append(observation);
      return { observations: [observation], failures: [] };
    },
    runChecks: async () => ({}),
    sampleChecks: async (_ids, phase) =>
      phase === "baseline"
        ? sample(options.baselinePassing === true ? "pass" : "fail")
        : sample(options.postconditionsPassing === false ? "fail" : "pass"),
    controllerProbe: {
      async check() {
        probeCount += 1;
        const competing = options.lateRival === true && probeCount >= 2;
        return {
          result: competing ? "competing" as const : "clear" as const,
          observedLabels: competing ? ["legacy.controller"] : [],
          evidenceRef: `artifact://fixture/controller-${probeCount}`,
        };
      },
    },
    leases: new ActionLeaseController(new ActionLeaseTable(), {
      controllerId: "fixture-controller",
      ttlMs: 60_000,
      now: () => now,
    }),
    componentLocks: new FileComponentActionLocks({
      dir: join(options.stateDir, "component-locks"),
      bootId: "fixture-boot",
    }),
    approvals: new ApprovalLedger({ trustedKey: publicKey, now: () => now }),
    evidence: new FileRecoveryEvidenceStore(join(options.stateDir, "evidence"), {
      readSourceArtifact: (ref) => JSON.stringify({ ref }),
    }),
    createExecutor: () => executor,
    argvFor: () => [],
    nextId: (prefix) => `${prefix}-${++eventSequence}`,
  });
  const tick = await controller.tick();
  if (options.providerQuota !== undefined) {
    const analysis = new DurableOpsAnalysisClient({
      analysisId: "fixture-team-analysis",
      store,
      now: () => now,
      baseBackoffMs: 60_000,
      delegate: {
        async publish() {
          const unavailable: string[] = [];
          for (const [provider, quota] of Object.entries(options.providerQuota ?? {})) {
            providerCalls += 1;
            if (quota === "available") return;
            unavailable.push(`${provider}:quota-exhausted`);
          }
          throw new Error(`analysis unavailable (${unavailable.join(",")})`);
        },
      },
    });
    await analysis.publish(tick);
    // The immediate retry is intentionally suppressed by the production
    // circuit breaker. This proves quota exhaustion cannot create a busy loop.
    await analysis.publish(tick);
  }
  return {
    tick,
    sideEffects,
    providerCalls,
    providerQuota: { ...(options.providerQuota ?? {}) },
    events: store.replay(),
    state: store.state(),
  };
}
