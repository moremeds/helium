/**
 * The recovery specialization of the canonical `EvidenceBundle`.
 *
 * It does not redefine what proven, partial, failed or blocked mean -- it
 * reuses the canonical vocabulary and adds the fields a recovery claim needs
 * to be checkable: what was observed, what was decided, under whose authority,
 * with which lease, against which baseline, and who actually caused the
 * result.
 *
 * Absent evidence is declared, never fabricated. A `not-needed`, operator or
 * external outcome legitimately has no receipt, but the bundle must say so
 * with an explicit `notApplicableReason` rather than omitting the field and
 * letting a reader assume it was checked.
 * @module @helium/core/operations/recovery-evidence
 */
import { z } from "zod";
import { EVIDENCE_STATUSES, VERIFIER_DECISIONS } from "../evidence/bundle.js";
import { ACTION_OUTCOMES } from "./action.js";
import { MutationOwnershipSchema, OpsIdSchema } from "./component.js";
import { ATTRIBUTIONS } from "./events.js";
import { CONTROLLER_PROBE_RESULTS } from "./mutation-owner.js";
import { SOP_AUTHORITIES } from "./sop.js";

/** Fields that may be absent only with a stated reason. */
export const OPTIONAL_RECOVERY_FIELDS = ["intent", "receipt", "lease"] as const;
export type OptionalRecoveryField = (typeof OPTIONAL_RECOVERY_FIELDS)[number];

const HashedRefSchema = z.strictObject({
  ref: z.string().min(1).max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const RecoveryEvidenceSchema = z
  .strictObject({
    assertionId: OpsIdSchema,
    componentId: OpsIdSchema,
    incidentId: OpsIdSchema,

    /** Raw observations, each with a content hash. */
    observations: z.array(HashedRefSchema).min(1),
    /** The incident and dependency picture the decision was made against. */
    incidentSnapshot: HashedRefSchema,

    sopId: OpsIdSchema,
    sopVersion: z.number().int().positive(),
    /** The exact digest, not merely the human-readable version. */
    sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** The signed manifest entry that GRANTED the authority actually used. */
    authorityManifestEntry: z.strictObject({
      sopId: OpsIdSchema,
      version: z.number().int().positive(),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      authority: z.enum(SOP_AUTHORITIES),
    }),
    authority: z.enum(SOP_AUTHORITIES),
    eligibility: z.strictObject({
      eligible: z.boolean(),
      reasons: z.array(z.string().max(200)),
    }),

    mutationOwner: MutationOwnershipSchema,
    controllerProbe: z.strictObject({
      result: z.enum(CONTROLLER_PROBE_RESULTS),
      observedLabels: z.array(z.string().max(256)),
      evidenceRef: z.string().min(1).max(512),
    }),

    lease: z.strictObject({ leaseId: OpsIdSchema, operationId: OpsIdSchema }).optional(),
    intent: z
      .strictObject({
        actionId: OpsIdSchema,
        argv: z.array(z.string().max(4096)),
        baseline: z.strictObject({
          capturedAt: z.string().min(1),
          allPassing: z.boolean(),
          sampleCount: z.number().int().nonnegative(),
        }),
      })
      .optional(),
    receipt: z
      .strictObject({
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        outputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .optional(),

    postconditionSamples: z.array(
      z.strictObject({
        checkId: OpsIdSchema,
        state: z.enum(["pass", "fail", "unknown"]),
        observedAt: z.string().min(1),
      }),
    ),
    outcome: z.enum(ACTION_OUTCOMES),
    attribution: z.enum(ATTRIBUTIONS).optional(),

    verifier: z.strictObject({
      identity: z.string().min(1).max(200),
      version: z.string().min(1).max(64),
      decision: z.enum(VERIFIER_DECISIONS),
    }),
    /** Where this can be replayed, or which drill exercised it. */
    replayRef: z.string().min(1).max(512),

    status: z.enum(EVIDENCE_STATUSES),
    limitation: z.string(),

    /** Why an optional field is absent. Never omit the field silently. */
    notApplicable: z
      .strictObject({
        intent: z.string().min(1).max(300).optional(),
        receipt: z.string().min(1).max(300).optional(),
        lease: z.string().min(1).max(300).optional(),
      })
      .optional(),
  })
  .superRefine((bundle, ctx) => {
    for (const field of OPTIONAL_RECOVERY_FIELDS) {
      if (bundle[field] !== undefined) continue;
      if (bundle.notApplicable?.[field] !== undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is absent with no notApplicableReason; state why rather than omitting it`,
      });
    }
    // A success claim requires the evidence a success is made of.
    if (bundle.outcome === "succeeded") {
      if (bundle.intent === undefined || bundle.receipt === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "a succeeded outcome requires both an intent and a receipt",
        });
      } else if (bundle.intent.baseline.allPassing) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message:
            "a succeeded outcome requires a baseline with at least one failing postcondition",
        });
      }
    }
    if (bundle.attribution === "automatic" && bundle.intent === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["attribution"],
        message: "automatic attribution requires a recorded intent",
      });
    }
  });
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
