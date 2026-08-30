/**
 * Provider-neutral durable event vocabulary for cases and team runs.
 *
 * Events contain stable role contracts, never execution-target identity. A
 * provider/model is chosen later for an execution attempt and belongs only in
 * that attempt's audit snapshot.
 * @module @helium/core/team/events
 */
import { z } from "zod";

export const TeamIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const TeamIsoUtcSchema = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value)),
  "expected an ISO-8601 UTC timestamp",
);

export const RoleContractSchema = z.strictObject({
  roleId: TeamIdSchema,
  requires: z.array(z.string().min(1).max(200)).max(100),
  tools: z.array(z.string().min(1).max(200)).max(100),
  workspace: z.literal("isolated"),
  maxDepth: z.number().int().nonnegative().max(32),
  budgetShare: z.number().nonnegative().max(1),
});
export type RoleContract = z.infer<typeof RoleContractSchema>;

const caseBase = {
  version: z.literal(1),
  eventId: TeamIdSchema,
  at: TeamIsoUtcSchema,
  caseId: TeamIdSchema,
};

const teamBase = {
  ...caseBase,
  teamRunId: TeamIdSchema,
};

export const CaseOpenedEventSchema = z.strictObject({
  ...caseBase,
  type: z.literal("case/opened"),
  payload: z.strictObject({ subject: z.string().min(1).max(1_000) }),
});

export const CaseClosedEventSchema = z.strictObject({
  ...caseBase,
  type: z.literal("case/closed"),
  payload: z.strictObject({ reason: z.string().min(1).max(1_000).optional() }),
});

export const TeamStartedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("team/started"),
  payload: z.strictObject({}),
});

export const AgentRosteredEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("agent/rostered"),
  payload: z.strictObject({
    agentId: TeamIdSchema,
    role: RoleContractSchema,
  }),
});

export const TeamCompletedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("team/completed"),
  payload: z.strictObject({}),
});

export const TeamFailedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("team/failed"),
  payload: z.strictObject({ reason: z.string().min(1).max(1_000) }),
});

export const TeamCancelledEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("team/cancelled"),
  payload: z.strictObject({ reason: z.string().min(1).max(1_000) }),
});

export const TASK_STATES = [
  "pending",
  "ready",
  "leased",
  "running",
  "needs-input",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TaskDefinitionSchema = z.strictObject({
  id: TeamIdSchema,
  ownerAgentId: TeamIdSchema,
  dependsOn: z.array(TeamIdSchema).max(500),
  acceptance: z.strictObject({ outputSchema: z.string().min(1).max(200) }),
});
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const TaskPatchSchema = z.strictObject({
  state: z.enum(TASK_STATES).optional(),
  dependsOn: z.array(TeamIdSchema).max(500).optional(),
});
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

export const TaskLeaseSchema = z.strictObject({
  leaseId: TeamIdSchema,
  ownerAgentId: TeamIdSchema,
  expiresAt: TeamIsoUtcSchema,
});
export type TaskLease = z.infer<typeof TaskLeaseSchema>;

export const TaskAddedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("task/added"),
  payload: z.strictObject({
    expectedGraphRevision: z.number().int().nonnegative(),
    graphRevision: z.number().int().positive(),
    task: TaskDefinitionSchema,
  }),
});

export const TaskUpdatedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("task/updated"),
  payload: z.strictObject({
    taskId: TeamIdSchema,
    expectedRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    patch: TaskPatchSchema,
  }),
});

export const TaskLeasedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("task/leased"),
  payload: z.strictObject({
    taskId: TeamIdSchema,
    expectedRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    lease: TaskLeaseSchema,
  }),
});

export const TaskLeaseExpiredEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("task/lease-expired"),
  payload: z.strictObject({
    taskId: TeamIdSchema,
    expectedRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    leaseId: TeamIdSchema,
  }),
});

export const ArtifactPublishedEventSchema = z.strictObject({
  ...teamBase,
  type: z.literal("artifact/published"),
  payload: z.strictObject({
    taskId: TeamIdSchema,
    ref: z.string().min(1).max(1_024).regex(/^artifact:\/\//),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});

export const TeamEventSchema = z.discriminatedUnion("type", [
  CaseOpenedEventSchema,
  CaseClosedEventSchema,
  TeamStartedEventSchema,
  AgentRosteredEventSchema,
  TeamCompletedEventSchema,
  TeamFailedEventSchema,
  TeamCancelledEventSchema,
  TaskAddedEventSchema,
  TaskUpdatedEventSchema,
  TaskLeasedEventSchema,
  TaskLeaseExpiredEventSchema,
  ArtifactPublishedEventSchema,
]);
export type TeamEvent = z.infer<typeof TeamEventSchema>;
