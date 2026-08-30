/** Provider-native target contracts. This package is an edge SDK, not core. */
import { z } from "zod";

const UnsupportedEffortSchema = z
  .object({ supported: z.literal(false) })
  .strict();

const SupportedEffortSchema = z
  .object({
    supported: z.literal(true),
    options: z.array(z.string().min(1)).min(1).max(8),
    default: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.options).size !== value.options.length) {
      ctx.addIssue({ code: "custom", message: "duplicate effort option" });
    }
    if (!value.options.includes(value.default)) {
      ctx.addIssue({
        code: "custom",
        message: "effort default must be in options",
      });
    }
    if (
      value.options.includes("ultracode") ||
      value.options.includes("ultra")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "orchestration mode is not effort",
      });
    }
  });

export const ProviderTargetSchema = z
  .object({
    targetRef: z.string().min(1),
    model: z.string().min(1),
    invokeAs: z.string().min(1).optional(),
    quotaDomain: z.string().min(1),
    enabled: z.boolean(),
    effort: z.discriminatedUnion("supported", [
      UnsupportedEffortSchema,
      SupportedEffortSchema,
    ]),
  })
  .strict();

export type ProviderTarget = z.infer<typeof ProviderTargetSchema>;

export const ProviderCatalogSchema = z
  .object({
    catalogVersion: z.string().min(1),
    targets: z.array(ProviderTargetSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const references = value.targets.map((target) => target.targetRef);
    if (new Set(references).size !== references.length) {
      ctx.addIssue({ code: "custom", message: "duplicate target reference" });
    }
  });

export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

export function parseProviderCatalog(input: unknown): ProviderCatalog {
  return ProviderCatalogSchema.parse(input);
}
