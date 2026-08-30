import { z } from "zod";
import {
  HashedArtifactRefSchema,
  ShepherdStateSchema,
  ShepherdWorkUnitSchema,
} from "./work-unit.js";

const Id = z.string().min(1).max(200);
const Revision = z.strictObject({
  workUnitId: Id,
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
});
const Evidence = z.array(HashedArtifactRefSchema).min(1);
export const CoverageDimensionSchema = z.enum([
  "universe",
  "identity",
  "bars",
  "corporate-actions",
  "pit",
  "lineage",
  "duckdb-parity",
  "repair",
  "rollback",
]);
export type CoverageDimension = z.infer<typeof CoverageDimensionSchema>;
export const CoverageStateSchema = z.enum([
  "seeded",
  "evidenced",
  "adjudicated",
  "published",
  "verified",
  "quarantined",
  "unresolved",
]);
export type CoverageState = z.infer<typeof CoverageStateSchema>;
const Base = {
  version: z.literal(1),
  eventId: Id,
  at: z.iso.datetime(),
};

const WorkUnitDiscovered = z.strictObject({
  ...Base,
  type: z.literal("work-unit/discovered"),
  payload: z.strictObject({ unit: ShepherdWorkUnitSchema }),
});
const WorkUnitTransitioned = z.strictObject({
  ...Base,
  type: z.literal("work-unit/transitioned"),
  payload: Revision.extend({
    from: ShepherdStateSchema,
    to: ShepherdStateSchema,
    reason: z.string().min(1).max(2_000),
  }),
});
const WorkUnitRetryScheduled = z.strictObject({
  ...Base,
  type: z.literal("work-unit/retry-scheduled"),
  payload: Revision.extend({
    wakeAt: z.iso.datetime(),
    trigger: z.enum(["time", "provider-availability", "user", "resource-pressure"]),
    reason: z.string().min(1).max(2_000),
    domain: Id.optional(),
  }),
});
const AttemptLeaseAcquired = z.strictObject({
  ...Base,
  type: z.literal("attempt/lease-acquired"),
  payload: Revision.extend({
    attemptId: Id,
    leaseId: Id,
    ownerId: Id,
    expiresAt: z.iso.datetime(),
  }),
});
const AttemptLeaseExpired = z.strictObject({
  ...Base,
  type: z.literal("attempt/lease-expired"),
  payload: Revision.extend({ attemptId: Id, leaseId: Id }),
});
const AttemptExecutionIntent = z.strictObject({
  ...Base,
  type: z.literal("attempt/execution-intent"),
  payload: Revision.extend({
    attemptId: Id,
    leaseId: Id,
    operation: z.enum(["probe", "analysis", "stage", "publish", "verify", "rollback"]),
  }),
});
const AttemptOutcomeRecorded = z.strictObject({
  ...Base,
  type: z.literal("attempt/outcome-recorded"),
  payload: Revision.extend({
    attemptId: Id,
    leaseId: Id,
    outcome: z.enum(["completed", "no-op", "quota-exhausted", "temporary-unavailable", "awaiting-user", "failed", "uncertain"]),
    evidence: z.array(HashedArtifactRefSchema).optional(),
    availabilityDomain: Id.optional(),
    retryAt: z.iso.datetime().optional(),
    nextState: ShepherdStateSchema.optional(),
  }),
});
const CoverageRecorded = z.strictObject({
  ...Base,
  type: z.literal("coverage/recorded"),
  payload: Revision.extend({
    dimension: CoverageDimensionSchema,
    state: CoverageStateSchema,
    evidence: Evidence,
  }),
});
const EvidenceAttached = z.strictObject({
  ...Base,
  type: z.literal("evidence/attached"),
  payload: Revision.extend({ evidence: HashedArtifactRefSchema }),
});
const ClaimRecorded = z.strictObject({
  ...Base,
  type: z.literal("claim/recorded"),
  payload: Revision.extend({
    claimId: Id,
    statement: z.string().min(1).max(20_000),
    evidence: Evidence,
  }),
});
const ClaimVerified = z.strictObject({
  ...Base,
  type: z.literal("claim/verified"),
  payload: Revision.extend({
    claimId: Id,
    verifierRole: Id,
    decision: z.enum(["pass", "fail", "inconclusive"]),
    evidence: Evidence,
  }),
});
const RepairIntentRecorded = z.strictObject({
  ...Base,
  type: z.literal("repair/intent-recorded"),
  payload: Revision.extend({ repairId: Id, scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), manifest: HashedArtifactRefSchema }),
});
const RepairReceiptRecorded = z.strictObject({
  ...Base,
  type: z.literal("repair/receipt-recorded"),
  payload: Revision.extend({ repairId: Id, receipt: HashedArtifactRefSchema }),
});
const RepairVerificationRecorded = z.strictObject({
  ...Base,
  type: z.literal("repair/verification-recorded"),
  payload: Revision.extend({
    repairId: Id,
    verifierRole: Id,
    decision: z.enum(["pass", "fail", "inconclusive"]),
    evidence: Evidence,
  }),
});
const RepairRolledBack = z.strictObject({
  ...Base,
  type: z.literal("repair/rolled-back"),
  payload: Revision.extend({ repairId: Id, receipt: HashedArtifactRefSchema }),
});
const IssueLinked = z.strictObject({
  ...Base,
  type: z.literal("issue/linked"),
  payload: Revision.extend({ repository: Id, issueNumber: z.number().int().positive(), url: z.url() }),
});
const CycleRecorded = z.strictObject({
  ...Base,
  type: z.literal("cycle/recorded"),
  payload: z.strictObject({ cycleId: Id, considered: z.number().int().nonnegative(), decided: z.number().int().nonnegative() }),
});

export const ShepherdEventSchema = z.discriminatedUnion("type", [
  WorkUnitDiscovered,
  WorkUnitTransitioned,
  WorkUnitRetryScheduled,
  AttemptLeaseAcquired,
  AttemptLeaseExpired,
  AttemptExecutionIntent,
  AttemptOutcomeRecorded,
  CoverageRecorded,
  EvidenceAttached,
  ClaimRecorded,
  ClaimVerified,
  RepairIntentRecorded,
  RepairReceiptRecorded,
  RepairVerificationRecorded,
  RepairRolledBack,
  IssueLinked,
  CycleRecorded,
]);
export type ShepherdEvent = z.infer<typeof ShepherdEventSchema>;
