import { canonicalJson } from "@helium/core";
import { ShepherdEventSchema, type ShepherdEvent } from "./events.js";
import type { HashedArtifactRef, ShepherdState, ShepherdWorkUnit } from "./work-unit.js";

export interface AttemptProjection {
  attemptId: string;
  leaseId: string;
  ownerId: string;
  expiresAt: string;
  state: "leased" | "intent-recorded" | "completed" | "no-op" | "quota-exhausted" | "temporary-unavailable" | "failed" | "uncertain" | "expired";
  operation?: "probe" | "analysis" | "stage" | "publish" | "verify" | "rollback";
}

export interface WorkUnitProjection {
  unit: ShepherdWorkUnit;
  state: ShepherdState;
  revision: number;
  evidence: Record<string, HashedArtifactRef>;
  claims: Record<string, { statement: string; decision?: "pass" | "fail" | "inconclusive" }>;
  attempts: Record<string, AttemptProjection>;
  activeLease?: AttemptProjection;
  verificationPassed: boolean;
  repairVerificationPassed: boolean;
  retry?: { wakeAt: string; trigger: string; reason: string };
}

export interface ShepherdProjection {
  workUnits: Record<string, WorkUnitProjection>;
  eventIds: string[];
  cycles: string[];
}

const LOCAL_FROM_DISCOVERED = new Set<ShepherdState>([
  "EVIDENCE_PENDING",
  "ADJUDICATING",
  "REPAIR_READY",
  "AWAITING_PROVIDER",
  "AWAITING_USER",
  "QUARANTINED",
  "ENGINEERING_ESCALATED",
  "UNRESOLVED",
  "RETRY_SCHEDULED",
]);
const ALLOWED: Partial<Record<ShepherdState, ReadonlySet<ShepherdState>>> = {
  DISCOVERED: LOCAL_FROM_DISCOVERED,
  EVIDENCE_PENDING: new Set(["ADJUDICATING", "REPAIR_READY", "AWAITING_PROVIDER", "AWAITING_USER", "QUARANTINED", "ENGINEERING_ESCALATED", "UNRESOLVED", "RETRY_SCHEDULED", "VERIFIED"]),
  ADJUDICATING: new Set(["REPAIR_READY", "AWAITING_PROVIDER", "AWAITING_USER", "QUARANTINED", "ENGINEERING_ESCALATED", "UNRESOLVED", "RETRY_SCHEDULED", "VERIFIED"]),
  REPAIR_READY: new Set(["REPAIRING", "QUARANTINED", "ENGINEERING_ESCALATED"]),
  REPAIRING: new Set(["VERIFYING", "QUARANTINED", "RETRY_SCHEDULED"]),
  VERIFYING: new Set(["VERIFIED", "QUARANTINED", "UNRESOLVED", "RETRY_SCHEDULED"]),
  AWAITING_PROVIDER: new Set(["EVIDENCE_PENDING", "ADJUDICATING", "RETRY_SCHEDULED"]),
  AWAITING_USER: new Set(["EVIDENCE_PENDING", "ADJUDICATING", "RETRY_SCHEDULED"]),
  QUARANTINED: new Set(["EVIDENCE_PENDING", "REPAIR_READY", "ENGINEERING_ESCALATED", "UNRESOLVED"]),
  ENGINEERING_ESCALATED: new Set(["EVIDENCE_PENDING", "RETRY_SCHEDULED", "UNRESOLVED"]),
  UNRESOLVED: new Set(["EVIDENCE_PENDING", "ADJUDICATING"]),
  RETRY_SCHEDULED: new Set(["EVIDENCE_PENDING", "ADJUDICATING", "REPAIR_READY", "AWAITING_PROVIDER", "AWAITING_USER"]),
};

export function reduceShepherd(events: ShepherdEvent[]): ShepherdProjection {
  const state: ShepherdProjection = { workUnits: {}, eventIds: [], cycles: [] };
  const seen = new Set<string>();
  for (const input of events) {
    const event = ShepherdEventSchema.parse(input);
    if (seen.has(event.eventId)) throw new Error(`duplicate event ID: ${event.eventId}`);
    seen.add(event.eventId);
    state.eventIds.push(event.eventId);

    if (event.type === "cycle/recorded") {
      state.cycles.push(event.payload.cycleId);
      continue;
    }
    if (event.type === "work-unit/discovered") {
      if (event.payload.unit.revision !== 0) {
        throw new Error(`work-unit initial revision must be zero: ${event.payload.unit.workUnitId}`);
      }
      const existing = state.workUnits[event.payload.unit.workUnitId];
      if (existing !== undefined) {
        if (canonicalJson(existing.unit.scope) !== canonicalJson(event.payload.unit.scope)) {
          throw new Error(`work-unit scope conflict: ${event.payload.unit.workUnitId}`);
        }
        continue;
      }
      state.workUnits[event.payload.unit.workUnitId] = {
        unit: event.payload.unit,
        state: "DISCOVERED",
        revision: event.payload.unit.revision,
        evidence: {},
        claims: {},
        attempts: {},
        verificationPassed: false,
        repairVerificationPassed: false,
      };
      continue;
    }

    const unit = requireUnit(state, event.payload.workUnitId);
    requireRevision(unit, event.payload.expectedRevision, event.payload.revision);

    switch (event.type) {
      case "work-unit/transitioned": {
        if (unit.state !== event.payload.from) {
          throw new Error(`state mismatch: expected ${unit.state}, got ${event.payload.from}`);
        }
        if (!ALLOWED[unit.state]?.has(event.payload.to)) {
          throw new Error(`illegal transition: ${unit.state} -> ${event.payload.to}`);
        }
        if (event.payload.to === "VERIFIED" && !unit.verificationPassed) {
          throw new Error("VERIFIED requires every recorded claim or repair to pass independent verification");
        }
        unit.state = event.payload.to;
        break;
      }
      case "work-unit/retry-scheduled":
        unit.state = "RETRY_SCHEDULED";
        unit.retry = { wakeAt: event.payload.wakeAt, trigger: event.payload.trigger, reason: event.payload.reason };
        break;
      case "attempt/lease-acquired": {
        if (unit.activeLease !== undefined) throw new Error(`active lease exists: ${unit.activeLease.leaseId}`);
        if (Date.parse(event.payload.expiresAt) <= Date.parse(event.at)) throw new Error(`lease already expired: ${event.payload.leaseId}`);
        if (unit.attempts[event.payload.attemptId] !== undefined) throw new Error(`duplicate attempt: ${event.payload.attemptId}`);
        const attempt: AttemptProjection = {
          attemptId: event.payload.attemptId,
          leaseId: event.payload.leaseId,
          ownerId: event.payload.ownerId,
          expiresAt: event.payload.expiresAt,
          state: "leased",
        };
        unit.attempts[attempt.attemptId] = attempt;
        unit.activeLease = attempt;
        break;
      }
      case "attempt/execution-intent": {
        const attempt = matchingAttempt(unit, event.payload.attemptId, event.payload.leaseId);
        if (attempt.state !== "leased") throw new Error(`attempt is not leased: ${attempt.attemptId}`);
        attempt.state = "intent-recorded";
        attempt.operation = event.payload.operation;
        break;
      }
      case "attempt/outcome-recorded": {
        const attempt = matchingAttempt(unit, event.payload.attemptId, event.payload.leaseId);
        if (attempt.state !== "intent-recorded") throw new Error(`attempt has no execution intent: ${attempt.attemptId}`);
        attempt.state = event.payload.outcome;
        delete unit.activeLease;
        for (const evidence of event.payload.evidence ?? []) attachEvidence(unit, evidence);
        break;
      }
      case "attempt/lease-expired": {
        const attempt = matchingAttempt(unit, event.payload.attemptId, event.payload.leaseId);
        if (Date.parse(event.at) < Date.parse(attempt.expiresAt)) throw new Error(`lease is not expired: ${attempt.leaseId}`);
        attempt.state = attempt.state === "intent-recorded" ? "uncertain" : "expired";
        delete unit.activeLease;
        break;
      }
      case "evidence/attached":
        attachEvidence(unit, event.payload.evidence);
        break;
      case "claim/recorded":
        if (unit.claims[event.payload.claimId] !== undefined) throw new Error(`duplicate claim: ${event.payload.claimId}`);
        unit.claims[event.payload.claimId] = { statement: event.payload.statement };
        for (const evidence of event.payload.evidence) attachEvidence(unit, evidence);
        refreshVerification(unit);
        break;
      case "claim/verified": {
        const claim = unit.claims[event.payload.claimId];
        if (claim === undefined) throw new Error(`unknown claim: ${event.payload.claimId}`);
        if (event.payload.verifierRole !== "independent-verifier") throw new Error("claim verifier is not independent");
        claim.decision = event.payload.decision;
        for (const evidence of event.payload.evidence) attachEvidence(unit, evidence);
        refreshVerification(unit);
        break;
      }
      case "repair/verification-recorded":
        if (event.payload.verifierRole !== "independent-verifier") throw new Error("repair verifier is not independent");
        for (const evidence of event.payload.evidence) attachEvidence(unit, evidence);
        unit.repairVerificationPassed = event.payload.decision === "pass";
        refreshVerification(unit);
        break;
      case "repair/intent-recorded":
        if (event.payload.scopeHash !== unit.unit.scopeHash) throw new Error("repair scope hash mismatch");
        attachEvidence(unit, event.payload.manifest);
        break;
      case "repair/receipt-recorded":
      case "repair/rolled-back":
        attachEvidence(unit, event.payload.receipt);
        break;
      case "issue/linked":
        break;
    }
    unit.revision = event.payload.revision;
  }
  return state;
}

function requireUnit(state: ShepherdProjection, workUnitId: string): WorkUnitProjection {
  const unit = state.workUnits[workUnitId];
  if (unit === undefined) throw new Error(`unknown work unit: ${workUnitId}`);
  return unit;
}

function requireRevision(unit: WorkUnitProjection, expected: number, next: number): void {
  if (unit.revision !== expected || next !== expected + 1) {
    throw new Error(`stale revision: expected ${unit.revision}, got ${expected} -> ${next}`);
  }
}

function attachEvidence(unit: WorkUnitProjection, evidence: HashedArtifactRef): void {
  const existing = unit.evidence[evidence.ref];
  if (existing !== undefined && existing.hash !== evidence.hash) {
    throw new Error(`evidence hash conflict: ${evidence.ref}`);
  }
  unit.evidence[evidence.ref] = evidence;
}

function matchingAttempt(unit: WorkUnitProjection, attemptId: string, leaseId: string): AttemptProjection {
  const attempt = unit.attempts[attemptId];
  if (attempt === undefined || attempt.leaseId !== leaseId || unit.activeLease?.leaseId !== leaseId) {
    throw new Error(`attempt lease mismatch: ${attemptId}/${leaseId}`);
  }
  return attempt;
}

function refreshVerification(unit: WorkUnitProjection): void {
  const claims = Object.values(unit.claims);
  const claimsPassed = claims.length > 0 && claims.every((claim) => claim.decision === "pass");
  unit.verificationPassed = unit.repairVerificationPassed || claimsPassed;
}
