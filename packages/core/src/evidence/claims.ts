/** Normalized, provider-neutral claims exchanged by team roles. */
import { z } from "zod";

const UniqueStrings = z.array(z.string().min(1)).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", message: "values must be unique" });
  }
});

export const CLAIM_KINDS = ["fact", "inference", "judgment"] as const;

export const ClaimSchema = z.strictObject({
  key: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(CLAIM_KINDS),
  evidenceRefs: UniqueStrings,
  confidence: z.number().min(0).max(1),
  assumptions: UniqueStrings,
  asOf: z.iso.datetime().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimSetSchema = z.strictObject({
  claimSetId: z.string().min(1),
  producerRole: z.string().min(1),
  claims: z.array(ClaimSchema),
}).superRefine((value, ctx) => {
  const keys = value.claims.map((claim) => claim.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "claim keys must be unique within a claim set" });
  }
});
export type ClaimSet = z.infer<typeof ClaimSetSchema>;
