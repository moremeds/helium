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
import { ACTION_OUTCOMES, PostconditionSampleSchema } from "./action.js";
import { MutationOwnershipSchema, OpsIdSchema } from "./component.js";
import { ATTRIBUTIONS } from "./events.js";
import { CONTROLLER_PROBE_RESULTS } from "./mutation-owner.js";
import { SOP_AUTHORITIES } from "./sop.js";

/** Fields that may be absent only with a stated reason. */
export const OPTIONAL_RECOVERY_FIELDS = ["baseline", "intent", "receipt", "lease"] as const;
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
    /** Every raw probe/check/controller artifact cited below, with its own hash. */
    rawArtifacts: z.array(HashedRefSchema).min(1),
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
    baseline: z
      .strictObject({
        capturedAt: z.string().min(1),
        samples: z.array(PostconditionSampleSchema).min(1),
        allPassing: z.boolean(),
      })
      .optional(),
    intent: z
      .strictObject({
        actionId: OpsIdSchema,
        argv: z.array(z.string().max(4096)),
        scopeId: z.string().min(1).max(256).refine((value) => !value.includes("|")).optional(),
        inputArtifacts: z.array(HashedRefSchema).min(1).max(50).optional(),
      })
      .superRefine((intent, ctx) => {
        if ((intent.scopeId === undefined) !== (intent.inputArtifacts === undefined)) {
          ctx.addIssue({
            code: "custom",
            path: [intent.scopeId === undefined ? "scopeId" : "inputArtifacts"],
            message: "scoped recovery intent requires both scopeId and inputArtifacts",
          });
        }
      })
      .optional(),
    receipt: z
      .strictObject({
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        outputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        evidence: HashedRefSchema,
      })
      .optional(),

    postconditionSamples: z.array(
      z.strictObject({
        checkId: OpsIdSchema,
        state: z.enum(["pass", "fail", "unknown"]),
        observedAt: z.string().min(1),
        evidenceRefs: z.array(z.string().min(1).max(512)).min(1),
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
        baseline: z.string().min(1).max(300).optional(),
        intent: z.string().min(1).max(300).optional(),
        receipt: z.string().min(1).max(300).optional(),
        lease: z.string().min(1).max(300).optional(),
      })
      .optional(),
  })
  .superRefine((bundle, ctx) => {
    const issue = (path: (string | number)[], message: string) => {
      ctx.addIssue({ code: "custom", path, message });
    };
    for (const field of OPTIONAL_RECOVERY_FIELDS) {
      if (bundle[field] !== undefined) continue;
      if (bundle.notApplicable?.[field] !== undefined) continue;
      issue(
        [field],
        `${field} is absent with no notApplicableReason; state why rather than omitting it`,
      );
    }
    const grant = bundle.authorityManifestEntry;
    if (grant.sopId !== bundle.sopId || grant.version !== bundle.sopVersion ||
        grant.digest !== bundle.sopDigest || grant.authority !== bundle.authority) {
      issue(
        ["authorityManifestEntry"],
        "authority manifest entry does not match the exact SOP grant",
      );
    }
    if (bundle.intent !== undefined) {
      if (bundle.lease === undefined) {
        issue(["lease"], "a recorded intent requires its action lease");
      }
      if (!bundle.eligibility.eligible || bundle.eligibility.reasons.length > 0) {
        issue(["eligibility"], "a recorded intent requires certified eligibility");
      }
      if (bundle.mutationOwner.owner !== "opsd") {
        issue(["mutationOwner"], "a recorded intent requires opsd mutation ownership");
      }
      if (bundle.controllerProbe.result !== "clear") {
        issue(["controllerProbe"], "a recorded intent requires a clear controller probe");
      }
      if (bundle.baseline === undefined) {
        issue(["baseline"], "a recorded intent requires its exact baseline samples");
      }
    }
    if (bundle.receipt !== undefined && bundle.intent === undefined) {
      issue(["receipt"], "an execution receipt requires a recorded intent");
    }
    // A success claim requires the evidence a success is made of.
    if (bundle.outcome === "succeeded") {
      if (bundle.intent === undefined || bundle.receipt === undefined) {
        issue(["outcome"], "a succeeded outcome requires both an intent and a receipt");
      } else if (bundle.baseline === undefined) {
        issue(["baseline"], "a succeeded outcome requires its exact baseline");
      } else if (bundle.baseline.allPassing) {
        issue(
          ["outcome"],
          "a succeeded outcome requires a baseline with at least one failing postcondition",
        );
      }
      if (bundle.receipt !== undefined &&
          (bundle.receipt.exitCode !== 0 || bundle.receipt.timedOut)) {
        issue(["receipt"], "a succeeded outcome requires a successful process receipt");
      }
      const latestByCheck = new Map<string, (typeof bundle.postconditionSamples)[number]>();
      for (const sample of bundle.postconditionSamples) latestByCheck.set(sample.checkId, sample);
      if (latestByCheck.size === 0 ||
          [...latestByCheck.values()].some((sample) => sample.state !== "pass")) {
        issue(["postconditionSamples"], "a succeeded outcome requires passing postcondition samples");
      }
      if (bundle.attribution !== "automatic") {
        issue(["attribution"], "a succeeded outcome requires automatic attribution");
      }
    }
    if (bundle.attribution === "automatic" && bundle.intent === undefined) {
      issue(["attribution"], "automatic attribution requires a recorded intent");
    }
    if (bundle.outcome === "not-needed" && bundle.baseline?.allPassing !== true) {
      issue(["baseline"], "a not-needed outcome requires an all-passing baseline");
    }
    if (bundle.outcome === "failed") {
      if (bundle.status !== "FAILED" || bundle.verifier.decision !== "fail") {
        issue(
          ["outcome"],
          "a failed outcome requires FAILED status and a failing verifier",
        );
      }
    } else if (bundle.outcome === "uncertain") {
      if (bundle.status !== "PARTIAL" || bundle.verifier.decision !== "inconclusive") {
        issue(
          ["outcome"],
          "an uncertain outcome requires PARTIAL status and an inconclusive verifier",
        );
      }
    } else if (bundle.status !== "PROVEN" || bundle.verifier.decision !== "pass") {
      issue(
        ["outcome"],
        "a proven recovery outcome requires PROVEN status and a passing verifier",
      );
    }
  });
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
