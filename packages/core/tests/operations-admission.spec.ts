import { describe, expect, it } from "vitest";
import {
  admission,
  type AdmissionPolicy,
  type ResourcePressure,
  type WorkAdmissionRequest,
} from "../src/operations/admission.js";

const policy: AdmissionPolicy = {
  sustainedMemoryPressureMs: 300_000,
  sustainedRecoveryMs: 300_000,
};
const pressure = (over: Partial<ResourcePressure> = {}): ResourcePressure => ({
  memoryState: "degraded",
  observedForMs: 300_000,
  ...over,
});
const work = (workClass: WorkAdmissionRequest["workClass"]): WorkAdmissionRequest => ({
  id: `work-${workClass}`,
  workClass,
});

describe("operations admission decision", () => {
  it("refuses optional teams and subagent fan-out under sustained memory pressure", () => {
    expect(admission.decide(work("optional-team"), pressure(), policy)).toEqual({
      admitted: false,
      reason: "host-memory-pressure",
    });
    expect(admission.decide(work("subagent-fanout"), pressure(), policy)).toEqual({
      admitted: false,
      reason: "host-memory-pressure",
    });
  });

  it("keeps collectors, deterministic actions, one minimal incident lane and dead-man work admitted", () => {
    for (const workClass of [
      "collector",
      "deterministic-action",
      "minimal-incident",
      "dead-man",
    ] as const) {
      expect(admission.decide(work(workClass), pressure(), policy)).toEqual({ admitted: true });
    }
  });

  it("does not trip before the pressure window is sustained", () => {
    expect(
      admission.decide(
        work("optional-team"),
        pressure({ observedForMs: policy.sustainedMemoryPressureMs - 1 }),
        policy,
      ),
    ).toEqual({ admitted: true });
  });

  it("does not treat an unknown pressure reading as proof of memory pressure", () => {
    expect(
      admission.decide(work("optional-team"), pressure({ memoryState: "unknown" }), policy),
    ).toEqual({ admitted: true });
  });

  it("restores optional concurrency only after a sustained recovery window", () => {
    expect(
      admission.decide(
        work("optional-team"),
        pressure({
          memoryState: "ok",
          recoveringFromPressure: true,
          recoveredForMs: 1,
        }),
        policy,
      ),
    ).toEqual({ admitted: false, reason: "host-memory-pressure-recovery" });
    expect(
      admission.decide(
        work("optional-team"),
        pressure({
          memoryState: "ok",
          recoveringFromPressure: true,
          recoveredForMs: policy.sustainedRecoveryMs,
        }),
        policy,
      ),
    ).toEqual({ admitted: true });
  });
});
