/**
 * Team manifests: the role set, what each role REQUIRES, and the task DAG.
 *
 * A role declares capabilities, never a model (doctrine 3). `parseTeamYaml`
 * rejects `provider:` / `model:` / `effort:` anywhere in the document, so a
 * vendor name cannot enter through a declaration.
 *
 * v2 trims v1's manifest to what a run actually needs: the claims-ledger
 * vocabulary (`crossReference`, `outputSchema`, `allowPartialClaims`,
 * `responsibility`) went with the ledger.
 * @module @helium/core/team
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { rejectRoutingKeys } from "./tenant.js";

const CapabilityList = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: "custom",
        message: "capability requirements must be unique",
      });
    }
  });

export const TeamRoleSchema = z.strictObject({
  requires: CapabilityList,
  permissions: z.strictObject({
    mutations: z.enum(["forbidden", "permitted"]).default("forbidden"),
    /** Tool names this role may call. Empty means none. */
    tools: z.array(z.string().min(1).max(200)).default([]),
  }),
  /** Overrides the tenant's sandbox kind for this role only. */
  sandbox: z.string().min(1).max(64).optional(),
  persona: z.string().max(4000).optional(),
});

export const TeamTaskSchema = z.strictObject({
  id: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  requires: CapabilityList,
  prompt: z.string().max(20000).optional(),
});

const TeamManifestShape = z.strictObject({
  manifestVersion: z.string().min(1),
  name: z.string().min(1),
  roles: z.record(z.string().min(1), TeamRoleSchema),
  tasks: z.array(TeamTaskSchema).min(1),
});

export type TeamManifest = z.infer<typeof TeamManifestShape>;
export type TeamRole = z.infer<typeof TeamRoleSchema>;
export type TeamTask = z.infer<typeof TeamTaskSchema>;

function validateManifest(manifest: TeamManifest): TeamManifest {
  const taskIds = manifest.tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("duplicate task id");
  }
  const knownTasks = new Set(taskIds);

  for (const task of manifest.tasks) {
    const role = manifest.roles[task.role];
    if (role === undefined) {
      throw new Error(`task ${task.id} names unknown role: ${task.role}`);
    }
    for (const dependency of task.dependsOn) {
      if (!knownTasks.has(dependency)) {
        throw new Error(
          `task ${task.id} names unknown dependency: ${dependency}`,
        );
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
  }

  const state = new Map<string, "visiting" | "visited">();
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (state.get(id) === "visiting") {
      throw new Error(`task DAG cycle includes ${id}`);
    }
    if (state.get(id) === "visited") return;
    state.set(id, "visiting");
    for (const dependency of tasks.get(id)!.dependsOn) visit(dependency);
    state.set(id, "visited");
  };
  for (const id of taskIds) visit(id);
  return manifest;
}

export function parseTeamYaml(text: string): TeamManifest {
  const decoded: unknown = parseYaml(text);
  rejectRoutingKeys(decoded, "manifest");
  return validateManifest(TeamManifestShape.parse(decoded));
}

/**
 * Task ids in dependency order: every task appears after everything it depends
 * on, ties broken by declaration order so a run is replayable.
 */
export function topologicalOrder(manifest: TeamManifest): string[] {
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const out: string[] = [];
  const visit = (id: string): void => {
    if (done.has(id)) return;
    for (const dependency of tasks.get(id)!.dependsOn) visit(dependency);
    done.add(id);
    out.push(id);
  };
  for (const task of manifest.tasks) visit(task.id);
  return out;
}
