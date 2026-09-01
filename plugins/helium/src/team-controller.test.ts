import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExecutionTargetId,
  type AgentResult,
  type Claim,
  type ClaimDecision,
  type ExecutionLease,
  type ResourcePressure,
  type WorkOrder,
  admission,
} from "@helium/core";
import { describe, expect, it, vi } from "vitest";
import { parseTeamYaml } from "@helium/core";
import {
  TeamController,
  type TeamExecutionPort,
  type TeamRoutingPort,
} from "./team-controller.js";
import {
  OutputContractRegistry,
  createBuiltinOutputContractRegistry,
} from "./output-contract-registry.js";

const root = () => mkdtempSync(join(tmpdir(), "helium-team-controller-"));
const targetId = ExecutionTargetId("fake-target");
const source = { ref: "artifact://source/a", content: "primary source" };
const sourceHash = createHash("sha256").update(source.content).digest("hex");

const manifest = parseTeamYaml(`
manifestVersion: team-v1
name: controller-test
roles:
  researcher:
    responsibility: evidence
    requires: [research]
    permissions: { externalResearch: true, mutations: forbidden, artifactRead: [source-artifacts] }
  verifier:
    responsibility: verification
    requires: [verify]
    permissions: { externalResearch: true, mutations: forbidden, artifactRead: [source-artifacts, dependency-artifacts] }
  renderer:
    responsibility: rendering
    requires: [render]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [accepted-claim-ledger] }
tasks:
  - { id: research-a, role: researcher, dependsOn: [], requires: [research], inputs: [source-artifacts], outputSchema: ClaimSet.v1 }
  - { id: research-b, role: researcher, dependsOn: [], requires: [research], inputs: [source-artifacts], outputSchema: ClaimSet.v1 }
  - { id: verifier, role: verifier, dependsOn: [research-a, research-b], requires: [verify], inputs: [source-artifacts, dependency-artifacts], outputSchema: EvidenceDecisionSet.v1 }
  - { id: renderer, role: renderer, dependsOn: [verifier], requires: [render], inputs: [accepted-claim-ledger], outputSchema: ShadowReport.v1 }
crossReference: { compareClaims: true, materialContradictions: fresh-evidence-work-order, requireIndependentEvidence: true }
budgets: { maxAttempts: 20, maxTokens: 100000 }
acceptance: { allowPartialClaims: true, terminalTasks: [renderer] }
`);

const claim = (statement: string): Claim => ({
  key: "policy.rate_path",
  statement,
  kind: "fact",
  evidenceRefs: [source.ref],
  confidence: 0.8,
  assumptions: [],
  asOf: "2026-08-30T00:00:00.000Z",
});

const decision = (value: Claim): ClaimDecision => ({
  actorRole: "verifier",
  claim: value,
  evidence: {
    assertionId: value.key,
    assertion: value.statement,
    acceptanceBound: "Source is hashed and independently replayed.",
    assertionClass: "claim:fact",
    evidencePolicyVersion: "claim-v1",
    requiredStages: ["raw", "replay"],
    stages: {
      raw: [{ ref: source.ref, sha256: sourceHash }],
      replay: [{ ref: "artifact://replay/a", sha256: "b".repeat(64) }],
    },
    verifier: {
      identity: "fixture-verifier",
      version: "1",
      decision: "pass",
      decidedAt: "2026-08-30T00:00:00.000Z",
    },
    freshness: { recordedAt: "2026-08-30T00:00:00.000Z" },
    executionSnapshot: {
      targetId,
      providerId: "fixture",
      model: "fixture",
      providerVersion: "1",
      isolationClass: "process",
      recordedAt: "2026-08-30T00:00:00.000Z",
    },
    status: "PROVEN",
    limitation: "Shadow evidence only.",
  },
});

function result(work: WorkOrder, structured: unknown): AgentResult {
  return {
    workId: work.id,
    outcome: "completed",
    structured,
    artifacts: [],
    usage: { inputTokens: 1, outputTokens: 1, ms: 1 },
    executionSnapshot: {
      targetId,
      providerId: "fixture",
      model: "fixture",
      providerVersion: "1",
      isolationClass: "process",
      recordedAt: "2026-08-30T00:00:00.000Z",
    },
    runtimeMetadata: {},
  };
}

function routePort(available = true): TeamRoutingPort {
  let n = 0;
  return {
    route: async ({ work }) => {
      n += 1;
      return {
        decision: available
          ? { selected: targetId, candidates: [], fallbackPosition: 0, policyVersion: "test", catalogVersion: "catalog-1" }
          : { candidates: [], failure: { class: "capability-shortage", reasons: ["missing"] }, policyVersion: "test", catalogVersion: "catalog-1" },
        ...(available
          ? { lease: { id: `lease-${n}`, targetId, workId: work.id, reservedCost: 0, expiresAt: "2026-08-30T01:00:00.000Z" } satisfies ExecutionLease }
          : {}),
        catalogVersion: "catalog-1",
      };
    },
  };
}

function executionPort(options: { contradiction?: boolean; invalid?: boolean } = {}): TeamExecutionPort {
  const accepted = claim("Rates remain restrictive.");
  return {
    run: vi.fn(async (_teamRunId, work) => {
      const task = work.taskClass.replace("team.", "");
      if (task === "research-a") {
        return result(work, {
          claimSet: { claimSetId: "a", producerRole: "researcher-a", claims: [accepted] },
          evidence: [decision(accepted).evidence],
        });
      }
      if (task === "research-b") {
        if (options.invalid) return result(work, { invented: true });
        const second = options.contradiction ? claim("Rates will fall.") : accepted;
        return result(work, {
          claimSet: { claimSetId: "b", producerRole: "researcher-b", claims: [second] },
          evidence: [decision(second).evidence],
        });
      }
      if (task === "verifier" || task.startsWith("verify-")) {
        // The DRAFT form is the only one the contract accepts: the verifier
        // names a key, the host rebuilds the decision from the claim it
        // extracted itself. A supplied {decisions:[...]} would let a model
        // author the accepted-claim ledger verbatim.
        return result(work, { acceptedClaimKeys: [accepted.key] });
      }
      return result(work, {
        report: "shadow only",
        acceptedClaimKeys: ["policy.rate_path"],
      });
    }),
    closeTeam: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
  };
}

const input = {
  caseId: "case-macro",
  subject: "macro trigger",
  prompt: "analyze",
  inputArtifacts: [{ ...source, hash: `sha256:${sourceHash}` }],
};

describe("TeamController", () => {
  it("durably refuses optional team start and fan-out under sustained host pressure", async () => {
    const stateRoot = root();
    const execution = executionPort();
    let pressure: ResourcePressure = {
      memoryState: "degraded",
      observedForMs: 300_000,
    };
    const controller = new TeamController({
      stateRoot,
      manifest,
      routing: routePort(),
      execution,
      admission: {
        decide: admission.decide,
        pressure: () => pressure,
        policy: { sustainedMemoryPressureMs: 300_000, sustainedRecoveryMs: 300_000 },
      },
    });
    await expect(controller.run(input)).rejects.toMatchObject({
      reason: "host-memory-pressure",
    });
    expect(execution.run).not.toHaveBeenCalled();
    expect(controller.store(input.caseId).events()).toEqual([
      expect.objectContaining({
        type: "team/admission-refused",
        payload: expect.objectContaining({ workClass: "optional-team", reason: "host-memory-pressure" }),
      }),
    ]);

    pressure = {
      memoryState: "ok",
      observedForMs: 1,
      recoveringFromPressure: true,
      recoveredForMs: 1,
    };
    await expect(controller.run(input)).rejects.toMatchObject({
      reason: "host-memory-pressure-recovery",
    });
    pressure = {
      memoryState: "ok",
      observedForMs: 300_000,
      recoveringFromPressure: true,
      recoveredForMs: 300_000,
    };
    const admitted = await controller.run({ ...input, maxTasks: 1 });
    expect(admitted.state).toBe("running");
    expect(execution.run).toHaveBeenCalledOnce();
  });

  it("stops additional fan-out when pressure arrives after a team has started", async () => {
    const execution = executionPort();
    let pressure: ResourcePressure = {
      memoryState: "ok",
      observedForMs: 300_000,
    };
    const controller = new TeamController({
      stateRoot: root(),
      manifest,
      routing: routePort(),
      execution,
      admission: {
        decide: admission.decide,
        pressure: () => pressure,
        policy: { sustainedMemoryPressureMs: 300_000, sustainedRecoveryMs: 300_000 },
      },
    });

    await controller.run({ ...input, maxTasks: 1 });
    expect(execution.run).toHaveBeenCalledOnce();

    pressure = { memoryState: "failed", observedForMs: 300_000 };
    const inhibited = await controller.run(input);
    expect(inhibited.state).toBe("running");
    expect(execution.run).toHaveBeenCalledOnce();
    expect(controller.store(input.caseId).events()).toContainEqual(
      expect.objectContaining({
        type: "team/admission-refused",
        payload: expect.objectContaining({
          workClass: "subagent-fanout",
          reason: "host-memory-pressure",
          taskId: "research-b",
        }),
      }),
    );

    pressure = {
      memoryState: "ok",
      observedForMs: 300_000,
      recoveringFromPressure: true,
      recoveredForMs: 300_000,
    };
    const recovered = await controller.run(input);
    expect(recovered.state).toBe("completed");
    expect(execution.run).toHaveBeenCalledTimes(5);
  });

  it("runs the durable DAG and lets renderer read only an accepted ledger", async () => {
    const execution = executionPort();
    const controller = new TeamController({
      stateRoot: root(), manifest, routing: routePort(), execution,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    const state = await controller.run(input);
    expect(state.state).toBe("completed");
    expect(Object.values(state.tasks).every((task) => task.state === "completed")).toBe(true);
    const rendererWork = vi.mocked(execution.run).mock.calls.find((call) => call[1].taskClass === "team.renderer")?.[1];
    expect(rendererWork?.inputs.artifacts).toHaveLength(1);
    expect(rendererWork?.inputs.artifacts[0]).toMatch(/^artifact:\/\/accepted-claims\//);
    expect(controller.store(input.caseId).events().map((event) => event.type)).toEqual(
      expect.arrayContaining(["case/opened", "task/execution-intent", "artifact/published", "task/execution-result", "team/completed"]),
    );
  });

  it("turns JSON-only provider drafts into PARTIAL evidence bound to exact execution", async () => {
    const accepted = claim("Rates remain restrictive.");
    const execution: TeamExecutionPort = {
      run: vi.fn(async (_teamRunId, work) => {
        const task = work.taskClass.replace("team.", "");
        if (task === "research-a" || task === "research-b") {
          return {
            ...result(work, JSON.stringify({
            claimSet: {
              claimSetId: task,
              producerRole: "researcher",
              claims: [accepted],
            },
            })),
            runtimeMetadata: {
              provider: {
                events: [{ type: "item.completed", item: { type: "mcp_tool_call", result: "fixture raw tool output" } }],
              },
            },
          };
        }
        if (task === "verifier" || task.startsWith("verify-")) {
          return result(work, JSON.stringify({ acceptedClaimKeys: [accepted.key] }));
        }
        return result(work, JSON.stringify({
          report: "review-only draft",
          acceptedClaimKeys: [accepted.key],
        }));
      }),
      closeTeam: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    };
    const controller = new TeamController({
      stateRoot: root(),
      manifest,
      routing: routePort(),
      execution,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    const state = await controller.run(input);
    expect(state.state).toBe("completed");
    const acceptedRef = state.artifactRefs.find((ref) =>
      ref.startsWith("artifact://accepted-claims/"),
    );
    expect(acceptedRef).toBeDefined();
    const ledger = JSON.parse(
      readFileSync(join(controller.store(input.caseId).artifactRoot, state.artifacts[acceptedRef!]!.hash.slice(7)), "utf8"),
    ) as Array<{ evidence: { status: string; executionSnapshot?: { targetId: string } } }>;
    expect(ledger[0]).toMatchObject({
      evidence: {
        status: "PARTIAL",
        executionSnapshot: { targetId: "fake-target" },
      },
    });
    const executionRef = state.artifactRefs.find((ref) =>
      ref.startsWith("artifact://team-execution/")
      && state.artifacts[ref]?.taskId === "research-a",
    );
    expect(executionRef).toBeDefined();
    const executionEnvelope = JSON.parse(
      readFileSync(join(controller.store(input.caseId).artifactRoot, state.artifacts[executionRef!]!.hash.slice(7)), "utf8"),
    ) as { runtimeMetadata?: { provider?: { events?: unknown[] } } };
    expect(executionEnvelope.runtimeMetadata?.provider?.events).toHaveLength(1);
  });

  it("does not advance a provider result that fails schema/evidence validation", async () => {
    const controller = new TeamController({ stateRoot: root(), manifest, routing: routePort(), execution: executionPort({ invalid: true }) });
    const state = await controller.run(input);
    expect(state.state).toBe("failed");
    expect(state.tasks["research-b"]?.state).toBe("needs-input");
    expect(state.tasks.verifier?.state).toBe("pending");
  });

  it("turns a contradiction into a fresh-evidence verification task", async () => {
    const execution = executionPort({ contradiction: true });
    const controller = new TeamController({ stateRoot: root(), manifest, routing: routePort(), execution });
    const state = await controller.run(input);
    const dynamic = Object.values(state.tasks).find((task) => task.id.startsWith("verify-"));
    expect(dynamic).toMatchObject({ ownerAgentId: "verifier", state: "completed" });
    expect(vi.mocked(execution.run).mock.calls.some((call) => call[1].requires.includes("fresh-evidence"))).toBe(true);
  });

  it("records capability shortage without executing", async () => {
    const execution = executionPort();
    const controller = new TeamController({ stateRoot: root(), manifest, routing: routePort(false), execution });
    const state = await controller.run(input);
    expect(state).toMatchObject({ state: "failed", terminalReason: expect.stringMatching(/capability-shortage/) });
    expect(execution.run).not.toHaveBeenCalled();
  });

  it("persists quota exhaustion as waiting-for-capacity without a busy retry", async () => {
    const execution = executionPort();
    vi.mocked(execution.run).mockImplementationOnce(async (_teamRunId, work) => ({
      ...result(work, undefined),
      outcome: "failed",
      failure: { class: "quota-exhausted", retryAfter: "later" },
      structured: undefined,
    }));
    const controller = new TeamController({ stateRoot: root(), manifest, routing: routePort(), execution });
    const state = await controller.run({ ...input, exactTarget: { opaque: true } });
    expect(state.state).toBe("running");
    expect(Object.values(state.capacityWaits)).toHaveLength(1);
    expect(execution.run).toHaveBeenCalledTimes(1);
    await controller.run({ ...input, exactTarget: { opaque: true } });
    expect(execution.run).toHaveBeenCalledTimes(1);
  });

  it("cancels a live task, drains execution, and terminalizes the team", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const execution = executionPort();
    vi.mocked(execution.run).mockImplementationOnce(async (_teamRunId, work, _lease, signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return {
        ...result(work, undefined),
        outcome: "failed",
        failure: { class: "cancelled" },
        structured: undefined,
      };
    });
    const controller = new TeamController({ stateRoot: root(), manifest, routing: routePort(), execution });
    const running = controller.run(input);
    await began;
    const cancelled = await controller.cancel(input.caseId, "operator stop");
    await running;
    expect(cancelled.state).toBe("cancelled");
    expect(execution.drain).toHaveBeenCalledOnce();
  });

  it("replays and resumes between every DAG layer without duplicating attempts", async () => {
    const stateRoot = root();
    const execution = executionPort();
    let state;
    for (let i = 0; i < 8; i += 1) {
      const controller = new TeamController({ stateRoot, manifest, routing: routePort(), execution });
      state = await controller.run({ ...input, maxTasks: 1 });
      if (state.state === "completed") break;
    }
    expect(state?.state).toBe("completed");
    const final = new TeamController({ stateRoot, manifest, routing: routePort(), execution }).store(input.caseId).load().teams["case-macro:shadow"]!;
    expect(new Set(Object.keys(final.attempts)).size).toBe(Object.keys(final.attempts).length);
    expect(Object.values(final.attempts).every((attempt) => attempt.state === "completed")).toBe(true);
  });

  it("rejects changed case inputs instead of replaying a result onto different bytes", async () => {
    const stateRoot = root();
    const first = new TeamController({ stateRoot, manifest, routing: routePort(), execution: executionPort() });
    await first.run({ ...input, maxTasks: 1 });
    const changedContent = "different source";
    const changedHash = createHash("sha256").update(changedContent).digest("hex");
    const reopened = new TeamController({ stateRoot, manifest, routing: routePort(), execution: executionPort() });
    await expect(reopened.run({
      ...input,
      inputArtifacts: [{ ref: source.ref, content: changedContent, hash: `sha256:${changedHash}` }],
    })).rejects.toThrow(/input artifacts changed across replay/);
  });

  it("runs the committed eight-node macro manifest end to end with a fake executor", async () => {
    const macro = parseTeamYaml(
      readFileSync(resolve(import.meta.dirname, "../../../evals/fixtures/macro-team/team.yaml"), "utf8"),
    );
    const claimTasks = [
      "inflation-evidence",
      "policy-evidence",
      "rates-path",
      "usd-transmission",
      "gold-impact",
    ];
    const claims = Object.fromEntries(claimTasks.map((task) => [task, {
      ...claim(`Claim for ${task}.`),
      key: `macro.${task}`,
    }]));
    const decisions = claimTasks.map((task) => decision(claims[task]!));
    const execution: TeamExecutionPort = {
      run: vi.fn(async (_teamRunId, work) => {
        const task = work.taskClass.replace("team.", "");
        if (claimTasks.includes(task)) {
          const value = claims[task]!;
          return result(work, {
            claimSet: { claimSetId: `set-${task}`, producerRole: task, claims: [value] },
            evidence: [decision(value).evidence],
          });
        }
        if (task === "verifier" || task.startsWith("verify-")) {
          return result(work, {
            acceptedClaimKeys: decisions.map((entry) => entry.claim.key),
          });
        }
        if (task === "lead-synthesis") {
          return result(work, { summary: "adjudicated", acceptedClaimKeys: decisions.map((entry) => entry.claim.key) });
        }
        return result(work, { report: "shadow report", acceptedClaimKeys: decisions.map((entry) => entry.claim.key) });
      }),
      closeTeam: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    };
    const controller = new TeamController({ stateRoot: root(), manifest: macro, routing: routePort(), execution });
    const state = await controller.run({ ...input, caseId: "macro-full" });
    expect(state.state).toBe("completed");
    expect(Object.keys(state.tasks)).toHaveLength(8);
    expect(state.tasks.renderer?.state).toBe("completed");
  });

  it("hands the delivery port each artifact's real bytes, read from THIS case's store", async () => {
    // The port must not hold a TeamStore: the controller opens one per caseId,
    // so a store captured at construction time belongs to whichever run was
    // first. This asserts the controller reads the bodies itself.
    let seen: Record<string, { content: string; hash: string }> = {};
    const controller = new TeamController({
      stateRoot: root(),
      manifest,
      routing: routePort(),
      execution: executionPort(),
      delivery: {
        deliver: async (input) => {
          seen = input.artifacts as typeof seen;
          const id = input.recordIntent(Object.keys(input.artifacts));
          input.recordOutcome(id, "delivered");
        },
      },
    });
    const state = await controller.run({ ...input, caseId: "delivery-bodies" });
    expect(state.state).toBe("completed");
    const refs = Object.keys(seen);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // Every body is the real published content, hashing to the projection's
      // own hash — not an empty string and not the metadata.
      expect(seen[ref]!.hash).toBe(
        `sha256:${createHash("sha256").update(seen[ref]!.content).digest("hex")}`,
      );
      expect(seen[ref]!.hash).toBe(state.artifacts[ref]!.hash);
    }
  });

  it("uses an injected output contract without teaching the generic controller its schema", async () => {
    const customManifest = parseTeamYaml(`
manifestVersion: team-v1
name: custom-contract
roles:
  analyst:
    responsibility: analysis
    requires: [custom-analysis]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [source-artifacts], tools: [] }
tasks:
  - { id: analysis, role: analyst, dependsOn: [], requires: [custom-analysis], inputs: [source-artifacts], outputSchema: Custom.v1 }
crossReference: { compareClaims: true, materialContradictions: fresh-evidence-work-order, requireIndependentEvidence: true }
budgets: { maxAttempts: 1, maxTokens: 100 }
acceptance: { allowPartialClaims: false, terminalTasks: [analysis] }
`);
    const contracts: OutputContractRegistry = createBuiltinOutputContractRegistry().register("Custom.v1", {
      prompt: ({ contract }) => `scope=${contract?.scopeHash}`,
      validate: (value, context) => {
        if ((value as { scopeHash?: string }).scopeHash !== context.contract?.scopeHash) {
          throw new Error("wrong scope");
        }
        return value;
      },
    });
    const execution: TeamExecutionPort = {
      run: vi.fn(async (_teamRunId, work) => result(work, {
        scopeHash: `sha256:${"c".repeat(64)}`,
      })),
      closeTeam: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    };
    const controller = new TeamController({
      stateRoot: root(),
      manifest: customManifest,
      routing: routePort(),
      execution,
      outputContracts: contracts,
    });
    const state = await controller.run({
      ...input,
      caseId: "custom-contract",
      contractContext: { scopeHash: `sha256:${"c".repeat(64)}` },
    });
    expect(state.state).toBe("completed");
    expect(vi.mocked(execution.run).mock.calls[0]?.[1].inputs.prompt).toContain(
      `scope=sha256:${"c".repeat(64)}`,
    );
  });
});
