import { AcceptedClaimLedger, ExecutionTargetId } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  OutputContractRegistry,
  createBuiltinOutputContractRegistry,
  type OutputContractContext,
} from "./output-contract-registry.js";

const context = (): OutputContractContext => ({
  role: "researcher",
  evidenceRefs: ["artifact://source/a"],
  accepted: new AcceptedClaimLedger({ allowPartial: true }),
  result: {
    workId: "work-1",
    outcome: "completed",
    structured: {},
    artifacts: [],
    usage: { ms: 1 },
    executionSnapshot: {
      targetId: ExecutionTargetId("fixture"),
      providerId: "fixture",
      model: "fixture",
      providerVersion: "1",
      isolationClass: "process",
      recordedAt: "2026-08-31T00:00:00.000Z",
    },
    runtimeMetadata: {},
  },
  evidenceInputs: new Map([
    ["artifact://source/a", { hash: `sha256:${"a".repeat(64)}`, content: "source" }],
  ]),
  now: () => new Date("2026-08-31T00:00:00.000Z"),
  allowPartialClaims: true,
});

describe("OutputContractRegistry", () => {
  it("preserves all four built-in prompt contracts", () => {
    const registry = createBuiltinOutputContractRegistry();
    expect(registry.prompt("ClaimSet.v1", context())).toBe([
      "Return exactly one JSON object with no markdown fence or commentary.",
      "Schema: {\"claimSet\":{\"claimSetId\":string,\"producerRole\":string,\"claims\":[{\"key\":string,\"statement\":string,\"kind\":\"fact\"|\"inference\"|\"judgment\",\"evidenceRefs\":string[],\"confidence\":number,\"assumptions\":string[],\"asOf\":ISO-UTC-string-for-facts}]}}.",
      "producerRole must be \"researcher\".",
      "Every evidenceRefs entry must be chosen from: [\"artifact://source/a\"].",
      "Use facts only when directly supported. Inferences and judgments require named assumptions.",
    ].join("\n"));
    expect(registry.prompt("EvidenceDecisionSet.v1", context())).toContain("acceptedClaimKeys");
    expect(registry.prompt("AdjudicatedSynthesis.v1", context())).toContain("accepted claim ledger");
    expect(registry.prompt("ShadowReport.v1", context())).toContain("review-only");
  });

  it("enriches the legacy claim draft exactly through the injected registry", () => {
    const output = createBuiltinOutputContractRegistry().validate("ClaimSet.v1", {
      claimSet: {
        claimSetId: "set-1",
        producerRole: "researcher",
        claims: [{
          key: "claim-1",
          statement: "A supported fact.",
          kind: "fact",
          evidenceRefs: ["artifact://source/a"],
          confidence: 0.8,
          assumptions: [],
          asOf: "2026-08-30T00:00:00.000Z",
        }],
      },
    }, context()) as { evidence: Array<{ status: string }> };
    expect(output.evidence).toEqual([expect.objectContaining({ status: "PARTIAL" })]);
  });

  it("supports injection while rejecting duplicate and unknown schema ids", () => {
    const registry = new OutputContractRegistry().register("Custom.v1", {
      prompt: ({ role }) => `custom:${role}`,
      validate: (value) => value,
    });
    expect(registry.prompt("Custom.v1", context())).toBe("custom:researcher");
    expect(() => registry.register("Custom.v1", { prompt: () => "x", validate: (v) => v })).toThrow(/already registered/);
    expect(() => registry.validate("Missing.v1", {}, context())).toThrow(/unknown team output schema/);
  });
});
