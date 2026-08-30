import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcceptedClaimLedger,
  ExecutionTargetId,
  parseTeamYaml,
  reduceTeam,
  type AgentResult,
  type ClaimDecision,
  type EvidenceBundle,
  type WorkOrder,
} from "@helium/core";
import { describe, expect, it } from "vitest";
import { TeamController } from "../../plugins/helium/src/team-controller.js";

const source = "frozen source";
const digest = createHash("sha256").update(source).digest("hex");
const targetId = ExecutionTargetId("boundary-target");
const manifest = parseTeamYaml(`
manifestVersion: team-v1
name: boundary
roles:
  evidence:
    responsibility: evidence
    requires: [evidence]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [source-artifacts, dependency-artifacts] }
tasks:
  - { id: first, role: evidence, dependsOn: [], requires: [evidence], inputs: [source-artifacts], outputSchema: ClaimSet.v1 }
  - { id: second, role: evidence, dependsOn: [first], requires: [evidence], inputs: [dependency-artifacts], outputSchema: ClaimSet.v1 }
crossReference: { compareClaims: true, materialContradictions: fresh-evidence-work-order, requireIndependentEvidence: true }
budgets: { maxAttempts: 4, maxTokens: 1000 }
acceptance: { allowPartialClaims: false, terminalTasks: [second] }
`);

const evidence: EvidenceBundle = {
  assertionId: "macro.fact",
  assertion: "The source is current.",
  acceptanceBound: "Hashed source and replay.",
  assertionClass: "claim:fact",
  evidencePolicyVersion: "claim-v1",
  requiredStages: ["raw", "replay"],
  stages: {
    raw: [{ ref: "artifact://source/frozen", sha256: digest }],
    replay: [{ ref: "artifact://source/replay", sha256: "a".repeat(64) }],
  },
  verifier: {
    identity: "boundary-verifier",
    version: "1",
    decision: "pass" as const,
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
  status: "PROVEN" as const,
  limitation: "Fixture only.",
};
const structured = {
  claimSet: {
    claimSetId: "boundary-set",
    producerRole: "evidence",
    claims: [{
      key: "macro.fact",
      statement: "The source is current.",
      kind: "fact" as const,
      evidenceRefs: ["artifact://source/frozen"],
      confidence: 0.9,
      assumptions: [],
      asOf: "2026-08-30T00:00:00.000Z",
    }],
  },
  evidence: [evidence],
};

const result = (work: WorkOrder, value: unknown): AgentResult => ({
  workId: work.id,
  outcome: "completed",
  structured: value,
  artifacts: [],
  usage: { ms: 1 },
  executionSnapshot: {
    targetId,
    providerId: "fixture",
    model: "fixture",
    providerVersion: "1",
    isolationClass: "process",
    recordedAt: "2026-08-30T00:00:00.000Z",
  },
  runtimeMetadata: {},
});

function controller(value: unknown) {
  let lease = 0;
  return new TeamController({
    stateRoot: mkdtempSync(join(tmpdir(), "helium-boundary-")),
    manifest,
    routing: {
      route: async ({ work }) => ({
        decision: { selected: targetId, candidates: [], fallbackPosition: 0, policyVersion: "boundary", catalogVersion: "catalog-1" },
        lease: { id: `lease-${++lease}`, targetId, workId: work.id, reservedCost: 0, expiresAt: "2026-08-30T01:00:00.000Z" },
        catalogVersion: "catalog-1",
      }),
    },
    execution: {
      run: async (_team, work) => result(work, value),
      closeTeam: async () => {},
      drain: async () => {},
    },
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
}

const runInput = {
  caseId: "boundary-case",
  subject: "boundary",
  prompt: "prove ordering",
  inputArtifacts: [{ ref: "artifact://source/frozen", hash: `sha256:${digest}`, content: source }],
};

describe("behavioral topology boundary", () => {
  it("orders intent before immutable evidence before task advancement", async () => {
    const subject = controller(structured);
    const state = await subject.run({ ...runInput, maxTasks: 1 });
    expect(state.tasks.first?.state).toBe("completed");
    const events = subject.store(runInput.caseId).events();
    const intent = events.findIndex((event) => event.type === "task/execution-intent");
    const artifact = events.findIndex(
      (event) => event.type === "artifact/published" && event.payload.ref.startsWith("artifact://team/"),
    );
    const outcome = events.findIndex((event) => event.type === "task/execution-result");
    expect(intent).toBeLessThan(artifact);
    expect(artifact).toBeLessThan(outcome);
  });

  it("keeps dependents blocked when a provider result fails claim schema", async () => {
    const subject = controller({ invented: true });
    const state = await subject.run(runInput);
    expect(state.state).toBe("failed");
    expect(state.tasks.first?.state).toBe("needs-input");
    expect(state.tasks.second?.state).toBe("pending");
  });

  it("forbids renderer promotion and delivery outcome without write-ahead intent", () => {
    const ledger = new AcceptedClaimLedger({ allowPartial: false });
    const decision: ClaimDecision = {
      actorRole: "renderer",
      claim: structured.claimSet.claims[0],
      evidence,
    };
    expect(() => ledger.publish(decision, new Date("2026-08-30T00:00:00.000Z"))).toThrow(/renderer/);

    const base = [
      { version: 1, eventId: "e1", at: "2026-08-30T00:00:00.000Z", caseId: "c", type: "case/opened", payload: { subject: "x" } },
      { version: 1, eventId: "e2", at: "2026-08-30T00:00:01.000Z", caseId: "c", teamRunId: "t", type: "team/started", payload: {} },
    ] as const;
    expect(() => reduceTeam([...base, {
      version: 1,
      eventId: "e3",
      at: "2026-08-30T00:00:02.000Z",
      caseId: "c",
      teamRunId: "t",
      type: "delivery/outcome-recorded",
      payload: { deliveryId: "missing", outcome: "delivered" },
    }])).toThrow(/unknown delivery/);
  });
});
