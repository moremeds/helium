export interface AutonomyDecisionInput {
  nodeId: string;
  deterministicBaselineCoverage: number;
  ambiguity: number;
  measuredLift: number;
  failureCost: number;
  verificationStrength: number;
  independentVerifier: boolean;
  latencyDeltaMs: number;
  costDelta: number;
}

export interface AutonomyDecisionRecord extends AutonomyDecisionInput {
  version: "autonomy-v1";
  chosenMode: "workflow" | "agent" | "human";
  humanTakeoverCondition: string;
}

const bounded = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between zero and one`);
  }
};

export function decideAutonomy(input: AutonomyDecisionInput): AutonomyDecisionRecord {
  for (const field of [
    "deterministicBaselineCoverage",
    "ambiguity",
    "measuredLift",
    "failureCost",
    "verificationStrength",
  ] as const) bounded(field, input[field]);

  let chosenMode: AutonomyDecisionRecord["chosenMode"];
  let humanTakeoverCondition: string;
  if (input.deterministicBaselineCoverage >= 0.95) {
    chosenMode = "workflow";
    humanTakeoverCondition = "Deterministic baseline falls below 95 percent coverage.";
  } else if (input.failureCost >= 0.75 && input.verificationStrength < 0.75) {
    chosenMode = "human";
    humanTakeoverCondition = "High failure cost or weak verification requires human control.";
  } else if (
    input.measuredLift >= 0.2 &&
    input.verificationStrength >= 0.8 &&
    input.independentVerifier
  ) {
    chosenMode = "agent";
    humanTakeoverCondition = "Take over on failed independent verification or authority breach.";
  } else {
    chosenMode = "human";
    humanTakeoverCondition = "Measured lift and independent verification gates are not both met.";
  }
  return { version: "autonomy-v1", ...input, chosenMode, humanTakeoverCondition };
}
