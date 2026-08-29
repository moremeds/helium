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
import { ACTION_OUTCOMES } from "./action.js";
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
  approvedBy: z.string().min(1).max(200).optional(),
});

export const ActionIntentRecordedSchema = z.strictObject({
  ...base,
  type: z.literal("action-intent-recorded"),
  actionId: OpsIdSchema,
  leaseId: OpsIdSchema,
  /** Structured argv. A command string is not representable. */
  argv: z.array(z.string().max(4096)),
  baselineAllPassing: z.boolean(),
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
  stdoutRef: z.string().min(1).max(512).optional(),
  stderrRef: z.string().min(1).max(512).optional(),
});

export const ActionVerifiedSchema = z.strictObject({
  ...base,
  type: z.literal("action-verified"),
  actionId: OpsIdSchema,
  outcome: z.enum(ACTION_OUTCOMES),
  postconditionRefs: z.array(OpsIdSchema),
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
]);
export type OperationsEvent = z.infer<typeof OperationsEventSchema>;
