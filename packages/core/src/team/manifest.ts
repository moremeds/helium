/** Provider-neutral team manifests and their deterministic DAG validation. */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CapabilityList = z.array(z.string().min(1)).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", message: "capability requirements must be unique" });
  }
});

export const TEAM_ARTIFACT_INPUTS = [
  "source-artifacts",
  "dependency-artifacts",
  "accepted-claim-ledger",
] as const;

export const TeamRoleSchema = z.strictObject({
  responsibility: z.enum([
    "evidence",
    "analysis",
    "verification",
    "synthesis",
    "rendering",
  ]),
  requires: CapabilityList,
  permissions: z.strictObject({
    externalResearch: z.boolean(),
    mutations: z.enum(["forbidden", "permitted"]),
    artifactRead: z.array(z.enum(TEAM_ARTIFACT_INPUTS)).min(1),
  }),
});

export const TeamTaskSchema = z.strictObject({
  id: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  requires: CapabilityList,
  inputs: z.array(z.enum(TEAM_ARTIFACT_INPUTS)).min(1),
  outputSchema: z.string().min(1),
});

const TeamManifestShape = z.strictObject({
  manifestVersion: z.string().min(1),
  name: z.string().min(1),
  roles: z.record(z.string().min(1), TeamRoleSchema),
  tasks: z.array(TeamTaskSchema).min(1),
  crossReference: z.strictObject({
    compareClaims: z.literal(true),
    materialContradictions: z.literal("fresh-evidence-work-order"),
    requireIndependentEvidence: z.literal(true),
  }),
  budgets: z.strictObject({
    maxAttempts: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCost: z.number().nonnegative().optional(),
  }),
  acceptance: z.strictObject({
    allowPartialClaims: z.boolean(),
    terminalTasks: z.array(z.string().min(1)).min(1),
  }),
});

export type TeamManifest = z.infer<typeof TeamManifestShape>;

function validateManifest(manifest: TeamManifest): TeamManifest {
  const taskIds = manifest.tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("duplicate task id");
  const knownTasks = new Set(taskIds);

  for (const task of manifest.tasks) {
    const role = manifest.roles[task.role];
    if (role === undefined) throw new Error(`task ${task.id} names unknown role: ${task.role}`);
    for (const dependency of task.dependsOn) {
      if (!knownTasks.has(dependency)) {
        throw new Error(`task ${task.id} names unknown dependency: ${dependency}`);
      }
      if (dependency === task.id) throw new Error(`task DAG cycle at ${task.id}`);
    }
    for (const capability of task.requires) {
      if (!role.requires.includes(capability)) {
        throw new Error(
          `task ${task.id} requires capability ${capability} absent from role ${task.role}`,
        );
      }
    }
    if (role.responsibility === "rendering") {
      if (role.permissions.externalResearch) {
        throw new Error("renderer cannot use external research");
      }
      if (role.permissions.mutations !== "forbidden") {
        throw new Error("renderer cannot use mutation tools");
      }
      if (
        role.permissions.artifactRead.length !== 1 ||
        role.permissions.artifactRead[0] !== "accepted-claim-ledger" ||
        task.inputs.length !== 1 ||
        task.inputs[0] !== "accepted-claim-ledger"
      ) {
        throw new Error("renderer may read only the accepted claim ledger");
      }
    }
  }

  for (const taskId of manifest.acceptance.terminalTasks) {
    if (!knownTasks.has(taskId)) throw new Error(`unknown terminal task: ${taskId}`);
  }

  const state = new Map<string, "visiting" | "visited">();
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (state.get(id) === "visiting") throw new Error(`task DAG cycle includes ${id}`);
    if (state.get(id) === "visited") return;
    state.set(id, "visiting");
    for (const dependency of tasks.get(id)!.dependsOn) visit(dependency);
    state.set(id, "visited");
  };
  for (const id of taskIds) visit(id);
  return manifest;
}

const FORBIDDEN_ROUTING_KEYS = new Set(["provider", "providerid", "model", "modelid"]);

function rejectRoutingKeys(value: unknown, path = "manifest"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectRoutingKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_ROUTING_KEYS.has(key.toLocaleLowerCase("en-US"))) {
      throw new Error(`unrecognized key "${key}" at ${path}`);
    }
    rejectRoutingKeys(nested, `${path}.${key}`);
  }
}

export function parseTeamYaml(text: string): TeamManifest {
  const decoded: unknown = parseYaml(text);
  rejectRoutingKeys(decoded);
  return validateManifest(TeamManifestShape.parse(decoded));
}

export const TeamManifestSchema = TeamManifestShape.superRefine((manifest, ctx) => {
  try {
    validateManifest(manifest);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
