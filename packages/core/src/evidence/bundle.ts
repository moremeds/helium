/**
 * The generic evidence bundle: one assertion bound to its policy, its raw
 * artifacts, the proof stages that policy requires, a verifier decision, a
 * freshness window, a status, and what it still does not prove.
 *
 * It is defined here, in core, so the operations substrate and the research
 * phase use ONE contract. A factual claim, a capability evaluation, and an
 * incident recovery may specialize it by declaring different required stages;
 * none of them may redefine the status vocabulary.
 * @module @helium/core/evidence/bundle
 */
import { z } from "zod";
import { ExecutionSnapshotSchema } from "../work.js";

/**
 * The canonical status vocabulary. Only these five, and no renderer may
 * promote between them. `AgentResult.outcome === "completed"` is never an
 * evidence verdict, which is why "completed" is not a member here.
 */
export const EVIDENCE_STATUSES = [
  "PLANNED",
  "PARTIAL",
  "PROVEN",
  "FAILED",
  "BLOCKED",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_STAGES = [
  "raw",
  "replay",
  "regression",
  "bounded-production",
] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

export const VERIFIER_DECISIONS = ["pass", "fail", "inconclusive"] as const;
export type VerifierDecision = (typeof VERIFIER_DECISIONS)[number];

/**
 * A reference to one immutable artifact. The hash is REQUIRED: a reference
 * with no hash names a file whose content can change after the decision that
 * cited it, which is not evidence.
 */
export const EvidenceRefSchema = z.strictObject({
  ref: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const StageRefs = z.array(EvidenceRefSchema).min(1);

export const EvidenceStagesSchema = z.strictObject({
  raw: StageRefs.optional(),
  replay: StageRefs.optional(),
  regression: StageRefs.optional(),
  "bounded-production": StageRefs.optional(),
});

const NotApplicableSchema = z.strictObject({
  raw: z.string().min(1).optional(),
  replay: z.string().min(1).optional(),
  regression: z.string().min(1).optional(),
  "bounded-production": z.string().min(1).optional(),
});

export const EvidenceBundleSchema = z.strictObject({
  assertionId: z.string().min(1),
  assertion: z.string().min(1),
  acceptanceBound: z.string().min(1),
  /** The policy class -- capability, factual, incident-recovery, and so on. */
  assertionClass: z.string().min(1),
  evidencePolicyVersion: z.string().min(1),
  requiredStages: z.array(z.enum(EVIDENCE_STAGES)).min(1),
  stages: EvidenceStagesSchema,
  notApplicable: NotApplicableSchema.optional(),
  verifier: z.strictObject({
    identity: z.string().min(1),
    version: z.string().min(1),
    decision: z.enum(VERIFIER_DECISIONS),
    decidedAt: z.string().min(1),
  }),
  freshness: z.strictObject({
    recordedAt: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
  }),
  executionSnapshot: ExecutionSnapshotSchema.optional(),
  status: z.enum(EVIDENCE_STATUSES),
  /** May be empty at the schema level; the ledger requires it where it counts. */
  limitation: z.string(),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
