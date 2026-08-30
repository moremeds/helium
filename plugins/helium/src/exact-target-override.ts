import { z } from "zod";

export const OverridePurposeSchema = z.enum([
  "replay",
  "evaluation",
  "certification",
  "incident-diagnosis",
  "emergency-failover",
]);

export const ExactTargetOverrideSchema = z
  .object({
    targetRef: z.string().min(1),
    operator: z.string().min(1),
    reason: z.string().min(1),
    purpose: OverridePurposeSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ExactTargetOverride = z.infer<typeof ExactTargetOverrideSchema>;

export function parseActiveExactTargetOverride(
  input: unknown,
  now: Date,
): ExactTargetOverride {
  const override = ExactTargetOverrideSchema.parse(input);
  if (Date.parse(override.expiresAt) <= now.getTime()) {
    throw new Error(`exact-target override expired at ${override.expiresAt}`);
  }
  return override;
}
