import {
  AcceptedClaimLedger,
  ExecutionTargetId,
  type EvidenceBundle,
} from "@helium/core";
import { describe, expect, it } from "vitest";
import { createShepherdOutputContractRegistry } from "./analysis.js";
import type { OutputContractContext } from "dsh-plugin-helium/output-contract-registry";

const ref = "artifact://source/primary";
const hash = "a".repeat(64);
const now = new Date("2026-08-31T12:00:00.000Z");
const snapshot = {
  targetId: ExecutionTargetId("fixture"),
  providerId: "fixture",
  model: "fixture",
  providerVersion: "1",
  isolationClass: "process" as const,
  recordedAt: now.toISOString(),
};

const evidence = (key = "pit.member"): EvidenceBundle => ({
  assertionId: key,
  assertion: "Security was an index member.",
  acceptanceBound: "Exact responsible-publisher bytes and independent replay.",
  assertionClass: "claim:fact",
  evidencePolicyVersion: "shepherd-pit-v1",
  requiredStages: ["raw", "replay"],
  stages: {
    raw: [{ ref, sha256: hash }],
    replay: [{ ref: "artifact://replay/one", sha256: "b".repeat(64) }],
  },
  verifier: { identity: "fixture", version: "1", decision: "pass", decidedAt: now.toISOString() },
  freshness: { recordedAt: now.toISOString() },
  executionSnapshot: snapshot,
  status: "PROVEN",
  limitation: "Bounded fixture.",
});

const shepherdOutput = () => ({
  scopeHash: `sha256:${"c".repeat(64)}`,
  claimSet: {
    claimSetId: "pit-set",
    producerRole: "pit-adjudicator",
    claims: [{
      key: "pit.member",
      statement: "Security was an index member.",
      kind: "fact" as const,
      evidenceRefs: [ref],
      confidence: 0.95,
      assumptions: [],
      asOf: "2021-01-05T23:59:59.000Z",
      material: true,
      eventTime: "2021-01-04T14:30:00.000Z",
      publicationTime: "2021-01-04T12:00:00.000Z",
      retrievalTime: "2026-08-31T10:00:00.000Z",
      revisionTime: "2026-08-30T10:00:00.000Z",
      sourceAuthority: "responsible-publisher" as const,
    }],
  },
  evidence: [evidence()],
});

const context = (accepted = new AcceptedClaimLedger({ allowPartial: false })): OutputContractContext => ({
  role: "pit-adjudicator",
  evidenceRefs: [ref],
  accepted,
  result: {
    workId: "work-1",
    outcome: "completed",
    structured: {},
    artifacts: [],
    usage: { ms: 1 },
    executionSnapshot: snapshot,
    runtimeMetadata: {},
  },
  evidenceInputs: new Map([[ref, { hash: `sha256:${hash}`, content: "primary" }]]),
  now: () => now,
  allowPartialClaims: false,
  contract: {
    scopeHash: `sha256:${"c".repeat(64)}`,
    eligibleOperations: ["rebuild-partition"],
  },
});

describe("Shepherd output contracts", () => {
  it("accepts a hash-bound point-in-time claim and exposes it to generic verification", () => {
    const registry = createShepherdOutputContractRegistry();
    const parsed = registry.validate("ShepherdClaimSet.v1", shepherdOutput(), context());
    expect(parsed).toMatchObject({ scopeHash: `sha256:${"c".repeat(64)}` });
    expect(registry.extractClaimOutputs(parsed)).toEqual([
      expect.objectContaining({ claimSet: expect.objectContaining({ claimSetId: "pit-set" }) }),
    ]);
  });

  it("rechecks Shepherd scope when a verifier consumes an external claim artifact", () => {
    const candidate = shepherdOutput();
    candidate.scopeHash = `sha256:${"d".repeat(64)}`;
    const verifierContext = context();
    verifierContext.evidenceInputs = new Map([[
      "artifact://source/candidate",
      { hash: `sha256:${"e".repeat(64)}`, content: JSON.stringify(candidate) },
    ]]);
    expect(() => createShepherdOutputContractRegistry().validate(
      "EvidenceDecisionSet.v1",
      { acceptedClaimKeys: ["pit.member"] },
      verifierContext,
    )).toThrow(/scope hash/);
  });

  it.each([
    ["missing temporal clocks", (value: ReturnType<typeof shepherdOutput>) => { Reflect.deleteProperty(value.claimSet.claims[0]!, "publicationTime"); }],
    ["future publication leakage", (value: ReturnType<typeof shepherdOutput>) => { value.claimSet.claims[0]!.publicationTime = "2021-01-06T00:00:00.000Z"; }],
    ["revision after retrieval", (value: ReturnType<typeof shepherdOutput>) => { value.claimSet.claims[0]!.revisionTime = "2026-09-01T00:00:00.000Z"; }],
    ["unhashed evidence", (value: ReturnType<typeof shepherdOutput>) => { value.evidence[0]!.stages.raw![0]!.sha256 = "unhashed"; }],
    ["scope mismatch", (value: ReturnType<typeof shepherdOutput>) => { value.scopeHash = `sha256:${"d".repeat(64)}`; }],
    ["discovery-only fact evidence", (value: ReturnType<typeof shepherdOutput>) => { Reflect.set(value.claimSet.claims[0]!, "sourceAuthority", "discovery"); }],
  ])("rejects %s", (_label, mutate) => {
    const value = shepherdOutput();
    mutate(value);
    expect(() => createShepherdOutputContractRegistry().validate("ShepherdClaimSet.v1", value, context())).toThrow();
  });

  it("accepts only bounded repair proposals backed by accepted claims", () => {
    const accepted = new AcceptedClaimLedger({ allowPartial: false });
    const base = shepherdOutput().claimSet.claims[0]!;
    accepted.publish({
      actorRole: "verifier",
      claim: {
        key: base.key,
        statement: base.statement,
        kind: base.kind,
        evidenceRefs: base.evidenceRefs,
        confidence: base.confidence,
        assumptions: base.assumptions,
        asOf: base.asOf,
      },
      evidence: evidence(),
    }, now);
    const proposal = {
      workUnitId: "work-1",
      scopeHash: `sha256:${"c".repeat(64)}`,
      eligibleOperation: "rebuild-partition",
      acceptedClaimKeys: ["pit.member"],
      sourceEvidence: [{ ref, hash: `sha256:${hash}` }],
      maxRows: 100,
      maxBytes: 10000,
      expiresAt: "2026-09-01T00:00:00.000Z",
    };
    const registry = createShepherdOutputContractRegistry();
    expect(registry.validate("ShepherdRepairProposal.v1", proposal, context(accepted))).toEqual(proposal);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, eligibleOperation: "run-shell" }, context(accepted))).toThrow(/not eligible/);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, acceptedClaimKeys: ["invented"] }, context(accepted))).toThrow(/unaccepted/);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, sourceEvidence: [{ ref, hash: `sha256:${"f".repeat(64)}` }] }, context(accepted))).toThrow(/does not bind/);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, sourceEvidence: [...proposal.sourceEvidence, { ref: "artifact:\/\/foreign", hash: `sha256:${"f".repeat(64)}` }] }, context(accepted))).toThrow(/absent from accepted/);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, expiresAt: now.toISOString() }, context(accepted))).toThrow(/expired/);
    expect(() => registry.validate("ShepherdRepairProposal.v1", { ...proposal, argv: ["rm", "-rf"] }, context(accepted))).toThrow();
  });
});
