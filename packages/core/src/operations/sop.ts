/**
 * Standard operating procedures: what may be run, against what, under whose
 * authority, and what must be true afterwards.
 *
 * An SOP never carries a command string. The executable is a path plus a
 * pinned identity, and the arguments come from a registered argv schema, so
 * there is no field in which a shell fragment could be represented. That is a
 * structural property of the schema, not a validation rule someone can relax.
 * @module @helium/core/operations/sop
 */
import { z } from "zod";
import { OpsIdSchema } from "./component.js";
import { OBSERVATION_STATES } from "./observation.js";
import type { CheckRegistry } from "./check.js";

export const SOP_AUTHORITIES = ["observe", "auto", "approve", "forbidden"] as const;
export type SopAuthority = (typeof SOP_AUTHORITIES)[number];

export const ExecutableIdentitySchema = z.strictObject({
  kind: z.enum(["sha256", "release"]),
  value: z.string().min(1).max(256),
});

export const ActionSpecSchema = z.strictObject({
  executorId: OpsIdSchema,
  executable: z.strictObject({
    path: z.string().min(1).max(1024),
    /**
     * Optional at the schema level so an uncertified draft can exist, but
     * REQUIRED for `auto` authority -- see {@link certifySop}. An unpinned
     * executable running unattended is a different binary tomorrow.
     */
    identity: ExecutableIdentitySchema.optional(),
  }),
  argvSchemaId: OpsIdSchema,
  cwdId: OpsIdSchema,
  environmentProfileId: OpsIdSchema,
  timeoutMs: z.number().int().positive().max(3_600_000),
});
export type ActionSpec = z.infer<typeof ActionSpecSchema>;

export const SopDefinitionSchema = z.strictObject({
  version: z.number().int().positive(),
  id: OpsIdSchema,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  componentId: OpsIdSchema,
  /** What this SOP answers. Used for match specificity in arbitration. */
  matches: z.strictObject({
    dimension: z.string().min(1).max(64),
    failureClass: z.enum(OBSERVATION_STATES),
  }),
  authority: z.enum(SOP_AUTHORITIES),
  /** Whether running this SOP changes the target. Drives postcondition rigour. */
  mutating: z.boolean(),
  /** Higher wins during arbitration; ties fall through to specificity then id. */
  priority: z.number().int(),
  action: ActionSpecSchema,
  preconditions: z.array(OpsIdSchema),
  postconditions: z.array(OpsIdSchema).min(1),
  /** Only one SOP from a group may hold a lease on a component at a time. */
  exclusiveGroup: OpsIdSchema.optional(),
  graceMs: z.number().int().nonnegative().max(3_600_000),
  maxAttempts: z.number().int().positive().max(100),
  cooldownMs: z.number().int().nonnegative().max(86_400_000),
});
export type SopDefinition = z.infer<typeof SopDefinitionSchema>;

export interface CertificationResult {
  certified: boolean;
  reasons: string[];
}

/**
 * Static certification: everything decidable without running anything.
 *
 * @throws never -- it reports. A caller decides whether an uncertified SOP may
 * load at a lower authority or not at all.
 */
export function certifySop(
  sop: SopDefinition,
  registry: CheckRegistry,
): CertificationResult {
  const reasons: string[] = [];

  for (const [label, refs] of [
    ["precondition", sop.preconditions],
    ["postcondition", sop.postconditions],
  ] as const) {
    try {
      registry.resolveAll(refs);
    } catch (error) {
      reasons.push(`${label}: ${(error as Error).message}`);
    }
  }

  // A mutating SOP owes a business check. "The process came back" is exactly
  // the evidence the audited integrity failure would have passed while the
  // data stayed broken.
  if (sop.mutating && reasons.length === 0) {
    const postconditions = registry.resolveAll(sop.postconditions);
    if (!postconditions.some((c) => c.kind === "business")) {
      reasons.push(
        "a mutating SOP needs at least one business postcondition, not only liveness",
      );
    }
  }

  if (sop.authority === "auto" && sop.action.executable.identity === undefined) {
    reasons.push(
      "auto authority requires a pinned executable identity (sha256 or release)",
    );
  }

  return { certified: reasons.length === 0, reasons };
}
