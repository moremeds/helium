import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RegisteredScriptSchema, ScriptRegistry } from "dsh-plugin-ops-agent";
import { parseDocument } from "yaml";
import { z } from "zod";

const AbsolutePathSchema = z.string().min(1).max(2_000).refine(isAbsolute, "path must be absolute");

export const ShepherdRuntimeConfigSchema = z.strictObject({
  version: z.literal(1),
  stateRoot: AbsolutePathSchema,
  appendLockRoot: AbsolutePathSchema,
  intervalMs: z.number().int().positive().max(86_400_000),
  providerRetryMs: z.number().int().positive().max(86_400_000),
  livewire: z.strictObject({
    executorId: z.string().min(1).max(128),
    changedPathRoots: z.array(AbsolutePathSchema).min(1),
    repair: z.strictObject({
      executorId: z.string().min(1).max(128),
      readyDir: AbsolutePathSchema,
      dataLakeRoots: z.array(AbsolutePathSchema).min(1).max(16),
    }),
  }),
  scripts: z.array(RegisteredScriptSchema).min(1),
}).superRefine((config, ctx) => {
  try {
    const registry = ScriptRegistry.load(config.scripts);
    if (registry.get(config.livewire.executorId) === undefined) {
      ctx.addIssue({ code: "custom", path: ["livewire", "executorId"], message: "probe executor is not registered" });
    }
    if (registry.get(config.livewire.repair.executorId) === undefined) {
      ctx.addIssue({ code: "custom", path: ["livewire", "repair", "executorId"], message: "repair executor is not registered" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", path: ["scripts"], message: error instanceof Error ? error.message : "invalid scripts" });
  }
});
export type ShepherdRuntimeConfig = z.infer<typeof ShepherdRuntimeConfigSchema>;

export function loadShepherdRuntimeConfig(path: string): ShepherdRuntimeConfig {
  if (!isAbsolute(path)) throw new Error("Shepherd config path must be absolute");
  const document = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`invalid Shepherd config YAML: ${document.errors[0]?.message}`);
  }
  return ShepherdRuntimeConfigSchema.parse(document.toJS());
}
