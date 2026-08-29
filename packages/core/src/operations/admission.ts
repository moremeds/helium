/**
 * Pure host-pressure admission policy.
 *
 * This module decides only whether a class of work may start. Phase P2.5a has
 * no team controller yet, so there is intentionally no caller here; Phase
 * P3.5 wires this decision into the controller after the enforcement seam
 * exists.
 * @module @helium/core/operations/admission
 */
import type { ObservationState } from "./observation.js";

export const WORK_ADMISSION_CLASSES = [
  "optional-team",
  "subagent-fanout",
  "collector",
  "deterministic-action",
  "minimal-incident",
  "dead-man",
] as const;
export type WorkAdmissionClass = (typeof WORK_ADMISSION_CLASSES)[number];

export interface WorkAdmissionRequest {
  id: string;
  workClass: WorkAdmissionClass;
}

export interface ResourcePressure {
  memoryState: ObservationState;
  observedForMs: number;
}

export interface AdmissionPolicy {
  sustainedMemoryPressureMs: number;
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: "host-memory-pressure" };

const OPTIONAL_CLASSES = new Set<WorkAdmissionClass>([
  "optional-team",
  "subagent-fanout",
]);

function decide(
  work: WorkAdmissionRequest,
  pressure: ResourcePressure,
  policy: AdmissionPolicy,
): AdmissionDecision {
  const sustained =
    (pressure.memoryState === "degraded" || pressure.memoryState === "failed") &&
    pressure.observedForMs >= policy.sustainedMemoryPressureMs;
  if (sustained && OPTIONAL_CLASSES.has(work.workClass)) {
    return { admitted: false, reason: "host-memory-pressure" };
  }
  return { admitted: true };
}

export const admission = { decide } as const;
