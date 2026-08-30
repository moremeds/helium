import { describe, expect, it } from "vitest";
import { decideAutonomy } from "../src/autonomy.js";
import { resolve } from "node:path";
import { runOfflineEvaluation } from "../src/run.js";

const base = {
  nodeId: "rates-path",
  deterministicBaselineCoverage: 0.4,
  ambiguity: 0.5,
  measuredLift: 0.3,
  failureCost: 0.3,
  verificationStrength: 0.9,
  independentVerifier: true,
  latencyDeltaMs: 100,
  costDelta: 0,
};

describe("decideAutonomy", () => {
  it("keeps a deterministic workflow when the baseline meets the bound", () => {
    expect(decideAutonomy({ ...base, deterministicBaselineCoverage: 0.98 }).chosenMode).toBe("workflow");
  });

  it("selects an agent only with measured lift and independent strong verification", () => {
    expect(decideAutonomy(base).chosenMode).toBe("agent");
    expect(decideAutonomy({ ...base, measuredLift: 0.05 }).chosenMode).not.toBe("agent");
    expect(decideAutonomy({ ...base, independentVerifier: false }).chosenMode).not.toBe("agent");
  });

  it("selects human takeover for high failure cost and weak verification", () => {
    const record = decideAutonomy({ ...base, failureCost: 0.9, verificationStrength: 0.4 });
    expect(record.chosenMode).toBe("human");
    expect(record.humanTakeoverCondition).toMatch(/failure cost|verification/i);
  });

  it("emits one autonomy decision for every committed macro node", async () => {
    const report = await runOfflineEvaluation(
      resolve(import.meta.dirname, "../../../evals/fixtures/macro"),
    );
    expect(report.mode).toBe("offline-replay");
    expect(report.autonomyRecords).toHaveLength(8);
    expect(new Set(report.autonomyRecords.map((record) => record.nodeId)).size).toBe(8);
  });
});
