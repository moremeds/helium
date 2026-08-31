/**
 * The operations event vocabulary: everything that can be appended to the
 * operations log.
 *
 * Every event is strict, versioned and carries its own id, because the log is
 * the only durable truth about what was attempted and what happened. Nothing
 * here can hold a free-form command string: an execution receipt carries the
 * argv array that was actually run, never a shell line.
 * @module @helium/core/operations/events
 */
import { z } from "zod";
import { ACTION_OUTCOMES, PostconditionSampleSchema } from "./action.js";
import { CheckDefinitionSchema } from "./check.js";
import { EvidenceRefSchema } from "../evidence/bundle.js";
import { CONTROLLER_PROBE_RESULTS } from "./mutation-owner.js";
import { MutationOwnershipSchema, OpsIdSchema } from "./component.js";
import { INCIDENT_STATES } from "./incident.js";
import { IsoTimestampSchema, ObservationSchema } from "./observation.js";
import { SOP_AUTHORITIES } from "./sop.js";

/** Who or what caused a component to become healthy again. */
export const ATTRIBUTIONS = [
  "automatic",
  "operator",
  "external",
  "unknown",
] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

const base = {
  v: z.literal(1),
  id: OpsIdSchema,
  at: IsoTimestampSchema,
};

export const ObservationRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("observation-recorded"),
  observation: ObservationSchema,
});

export const IncidentOpenedSchema = z.strictObject({
  ...base,
  type: z.literal("incident-opened"),
  incidentId: OpsIdSchema,
  componentId: OpsIdSchema,
  dimension: z.string().min(1).max(64),
  observationIds: z.array(OpsIdSchema),
});

export const IncidentUpdatedSchema = z.strictObject({
  ...base,
  type: z.literal("incident-updated"),
  incidentId: OpsIdSchema,
  state: z.enum(INCIDENT_STATES),
});

export const ActionProposedSchema = z.strictObject({
  ...base,
  type: z.literal("action-proposed"),
  actionId: OpsIdSchema,
  incidentId: OpsIdSchema,
  componentId: OpsIdSchema,
  sopId: OpsIdSchema,
  sopVersion: z.number().int().positive(),
  sopDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const ActionAuthorizedSchema = z.strictObject({
  ...base,
  type: z.literal("action-authorized"),
  actionId: OpsIdSchema,
  authority: z.enum(SOP_AUTHORITIES),
  /** The exact signed entry that granted this effective authority. */
  authorityManifestEntry: z
    .strictObject({
      sopId: OpsIdSchema,
      version: z.number().int().positive(),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      authority: z.enum(SOP_AUTHORITIES),
    })
    .optional(),
  approvedBy: z.string().min(1).max(200).optional(),
});

export const ActionIntentRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("action-intent-recorded"),
  actionId: OpsIdSchema,
  leaseId: OpsIdSchema,
  operationId: OpsIdSchema,
  /** Structured argv. A command string is not representable. */
  argv: z.array(z.string().max(4096)),
  /** Optional bounded work scope and exact immutable inputs for scoped adapters. */
  scopeId: z.string().min(1).max(256).refine((value) => !value.includes("|")).optional(),
  inputArtifacts: z.array(z.strictObject({
    ref: z.string().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1).max(50).optional(),
  baseline: z.strictObject({
    capturedAt: IsoTimestampSchema,
    samples: z.array(PostconditionSampleSchema).min(1),
    allPassing: z.boolean(),
  }),
  controllerProbe: z.strictObject({
    result: z.enum(CONTROLLER_PROBE_RESULTS),
    observedLabels: z.array(z.string().max(256)),
    evidenceRef: z.string().min(1).max(512),
  }),
  /** Exact admission-time policy result; never reconstructed from later config. */
  eligibility: z.strictObject({
    eligible: z.boolean(),
    reasons: z.array(z.string().max(200)),
  }),
  /** Exact admission-time ownership; never reconstructed from later config. */
  mutationOwner: MutationOwnershipSchema,
  /** Decision-time dependency and verification policy, immutable across releases. */
  dependencyIds: z.array(OpsIdSchema).max(500),
  verificationPolicy: z.strictObject({
    postconditions: z.array(CheckDefinitionSchema).min(1).max(500),
    graceMs: z.number().int().nonnegative().max(86_400_000),
  }),
}).superRefine((event, ctx) => {
  if ((event.scopeId === undefined) !== (event.inputArtifacts === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [event.scopeId === undefined ? "scopeId" : "inputArtifacts"],
      message: "scoped intent requires both scopeId and inputArtifacts",
    });
  }
});

export const ActionReceiptRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("action-receipt-recorded"),
  actionId: OpsIdSchema,
  /**
   * The process result, and NOTHING more. A zero exit is not a verification:
   * whether the component actually recovered is decided by the postcondition
   * set, in a separate event.
   */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  outputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  outputTail: z.string().max(262_144),
  outputBytes: z.number().int().nonnegative(),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
  stdoutRef: z.string().min(1).max(512).optional(),
  stderrRef: z.string().min(1).max(512).optional(),
});

export const ActionVerifiedSchema = z.strictObject({
  ...base,
  type: z.literal("action-verified"),
  actionId: OpsIdSchema,
  outcome: z.enum(ACTION_OUTCOMES),
  attribution: z.enum(ATTRIBUTIONS).optional(),
  postconditionRefs: z.array(OpsIdSchema),
  postconditionSamples: z.array(PostconditionSampleSchema),
  recoveryEvidence: EvidenceRefSchema.extend({
    schema: z.literal("helium.ops.recovery-evidence/v1"),
    assertionId: OpsIdSchema,
  }).strict(),
});

export const OperatorIntervenedSchema = z.strictObject({
  ...base,
  type: z.literal("operator-intervened"),
  componentId: OpsIdSchema,
  kind: z.string().min(1).max(64),
  confirmed: z.boolean(),
});

/**
 * A change of mutation ownership. Recorded as an event so `mutationOwner` and
 * its `changeRef` appear in the component projection, and therefore in every
 * recovery evidence bundle for that component -- an ownership decision that
 * lived only in configuration would be invisible to the evidence record.
 */
export const MutationOwnershipChangedSchema = z.strictObject({
  ...base,
  type: z.literal("mutation-ownership-changed"),
  componentId: OpsIdSchema,
  ownership: MutationOwnershipSchema,
});

export const AlertRaisedSchema = z.strictObject({
  ...base,
  type: z.literal("alert-raised"),
  incidentId: OpsIdSchema,
  severity: z.enum(["info", "warning", "critical"]),
  summary: z.string().min(1).max(1000),
});

export const AnalysisStatusRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("analysis-status-recorded"),
  analysisId: OpsIdSchema,
  status: z.enum(["available", "unavailable"]),
  consecutiveFailures: z.number().int().nonnegative(),
  reason: z.string().min(1).max(1000).optional(),
  retryAt: IsoTimestampSchema.optional(),
});

export const ControllerCycleRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("controller-cycle-recorded"),
  controllerId: OpsIdSchema,
  releaseRef: z.string().min(1).max(1024),
  observationCount: z.number().int().nonnegative(),
  collectionFailureCount: z.number().int().nonnegative(),
});

export const OperationsEventSchema = z.discriminatedUnion("type", [
  ObservationRecordedSchema,
  IncidentOpenedSchema,
  IncidentUpdatedSchema,
  ActionProposedSchema,
  ActionAuthorizedSchema,
  ActionIntentRecordedSchema,
  ActionReceiptRecordedSchema,
  ActionVerifiedSchema,
  OperatorIntervenedSchema,
  MutationOwnershipChangedSchema,
  AlertRaisedSchema,
  AnalysisStatusRecordedSchema,
  ControllerCycleRecordedSchema,
]);
export type OperationsEvent = z.infer<typeof OperationsEventSchema>;
