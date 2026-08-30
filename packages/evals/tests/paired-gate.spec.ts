import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatePairedGate,
  fixtureDirectoryHash,
  type PairedEvaluation,
} from "../src/paired-gate.js";
import { parseTeamYaml } from "@helium/core";
import { runEvaluation } from "../src/run.js";

const fixtureDir = resolve(import.meta.dirname, "../../../evals/fixtures/macro");
const frozenHash = "44d3cc143e6eb423840ba2dcf85ad11feb6730e33ab161a874e8979dfbced268";

const pair = (index: number, treatmentRate = 0.1): PairedEvaluation => ({
  caseId: `case-${index}`,
  control: {
    state: "completed",
    inputFingerprint: `input-${index}`,
    anchorSnapshot: "anchor-v1",
    unsupportedClaims: 3,
    totalClaims: 10,
  },
  treatment: {
    state: "completed",
    inputFingerprint: `input-${index}`,
    anchorSnapshot: "anchor-v1",
    unsupportedClaims: Math.round(treatmentRate * 10),
    totalClaims: 10,
  },
});

describe("paired Phase 3 gate", () => {
  it("recomputes the pre-registered directory hash", () => {
    expect(fixtureDirectoryHash(fixtureDir)).toBe(frozenHash);
  });

  it("passes 30 paired cases with sufficient reduction and significance", () => {
    const result = evaluatePairedGate({
      fixtureDir,
      expectedFixtureHash: frozenHash,
      pairs: Array.from({ length: 30 }, (_, index) => pair(index)),
    });
    expect(result).toMatchObject({ passed: true, includedPairs: 30 });
    expect(result.relativeReduction).toBeGreaterThanOrEqual(0.2);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("fails hash mismatch, n below 30, and reduction below 20 percent", () => {
    expect(evaluatePairedGate({ fixtureDir, expectedFixtureHash: "0".repeat(64), pairs: [] }).reasons).toContain("fixture-hash-mismatch");
    expect(evaluatePairedGate({ fixtureDir, expectedFixtureHash: frozenHash, pairs: Array.from({ length: 29 }, (_, index) => pair(index)) }).reasons).toContain("insufficient-pairs");
    expect(evaluatePairedGate({ fixtureDir, expectedFixtureHash: frozenHash, pairs: Array.from({ length: 30 }, (_, index) => pair(index, 0.3)) }).reasons).toContain("insufficient-relative-reduction");
  });

  it("fails p >= 0.05 even when the aggregate reduction exceeds 20 percent", () => {
    const pairs = Array.from({ length: 30 }, (_, index): PairedEvaluation => ({
      caseId: `weak-${index}`,
      control: { state: "completed", inputFingerprint: `i-${index}`, anchorSnapshot: "a", unsupportedClaims: 900, totalClaims: 1000 },
      treatment: { state: "completed", inputFingerprint: `i-${index}`, anchorSnapshot: "a", unsupportedClaims: index < 7 ? 0 : 901, totalClaims: 1000 },
    }));
    const result = evaluatePairedGate({ fixtureDir, expectedFixtureHash: frozenHash, pairs });
    expect(result.relativeReduction).toBeGreaterThan(0.2);
    expect(result.pValue).toBeGreaterThanOrEqual(0.05);
    expect(result.reasons).toContain("not-statistically-significant");
  });

  it("excludes and jointly reschedules quota, cancellation, timeout and mismatched pairs", () => {
    const valid = Array.from({ length: 30 }, (_, index) => pair(index));
    const invalid = [
      { ...pair(31), control: { ...pair(31).control, state: "quota-exhausted" as const } },
      { ...pair(32), treatment: { ...pair(32).treatment, state: "quota-exhausted" as const } },
      { ...pair(33), control: { ...pair(33).control, state: "cancelled" as const } },
      { ...pair(34), treatment: { ...pair(34).treatment, state: "timeout" as const } },
      { ...pair(35), treatment: { ...pair(35).treatment, anchorSnapshot: "other" } },
      { ...pair(36), treatment: { ...pair(36).treatment, inputFingerprint: "other" } },
    ];
    const result = evaluatePairedGate({ fixtureDir, expectedFixtureHash: frozenHash, pairs: [...valid, ...invalid] });
    expect(result.includedPairs).toBe(30);
    expect(result.excludedPairs).toBe(6);
    expect(result.rescheduleCaseIds).toEqual(invalid.map((entry) => entry.caseId));
  });

  it("hands byte-identical inputs and one anchor snapshot to both executor adapters", async () => {
    const seen: string[] = [];
    const manifest = parseTeamYaml(`
manifestVersion: team-v1
name: eval
roles:
  worker:
    responsibility: evidence
    requires: [analysis]
    permissions: { externalResearch: false, mutations: forbidden, artifactRead: [source-artifacts] }
tasks:
  - { id: work, role: worker, dependsOn: [], requires: [analysis], inputs: [source-artifacts], outputSchema: ClaimSet.v1 }
crossReference: { compareClaims: true, materialContradictions: fresh-evidence-work-order, requireIndependentEvidence: true }
budgets: { maxAttempts: 2, maxTokens: 100 }
acceptance: { allowPartialClaims: false, terminalTasks: [work] }
`);
    const fixtures = [{
      id: "one",
      input: { anchorTarget: "anchor", anchorSnapshot: "snapshot", tools: [], budget: { tokens: 100 } },
      control: { unsupportedClaims: 2, totalClaims: 10 },
      treatment: { unsupportedClaims: 1, totalClaims: 10 },
    }];
    const adapter = (unsupportedClaims: number) => ({
      execute: async ({ fixture }: { fixture: unknown }) => {
        seen.push(JSON.stringify(fixture));
        return { state: "completed" as const, unsupportedClaims, totalClaims: 10 };
      },
    });
    const pairs = await runEvaluation({
      manifest,
      fixtures,
      catalogSnapshot: { version: "snapshot", targets: ["anchor"] },
      adapters: { control: adapter(2), treatment: adapter(1) },
    });
    expect(seen[0]).toBe(seen[1]);
    expect(pairs[0]?.control.inputFingerprint).toBe(pairs[0]?.treatment.inputFingerprint);
    expect(pairs[0]?.control.anchorSnapshot).toBe("snapshot");
  });
});
