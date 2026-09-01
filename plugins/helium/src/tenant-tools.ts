/**
 * Per-tenant tool vocabularies, merged into the single `ToolCatalog` core's
 * `selected()` filters. This is the host's job, not core's: constructing a
 * tool means naming a business domain, which `core-neutrality` bans from
 * `packages/core/src`. It replaces `catalogFromEnv()`/`TOOL_VOCABULARY`, which
 * died with `@helium/v1-compat`.
 *
 * It also closes the gap the design named: `validateToolSelection()` had
 * exactly one caller (v1 job load), so team role `permissions.tools` were
 * never checked against any vocabulary at all — which is how a manifest could
 * name three tools that do not exist and fail nothing.
 * @module dsh-plugin-helium/tenant-tools
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  thesisTools,
  type EcosystemTool,
  type TeamManifest,
  type ToolCatalog,
  type ToolVocabularyEntry,
} from "@helium/core";
import type { LoadedTenant, SkippedTenant } from "./tenants.js";

export interface TenantToolConfig {
  stateRoot: string;
  env: Record<string, string | undefined>;
}

/**
 * A tenant tool is an `EcosystemTool` plus the dsh parameter spec needed for
 * in-process registration. `registerEcosystemTools()` used to look every name
 * up in a hardcoded map and throw for anything absent, which no tenant-supplied
 * tool could ever satisfy; carrying the spec with the tool is what makes the
 * plug-in contract closed.
 */
export interface TenantTool extends EcosystemTool {
  dshParams: Record<string, unknown>;
}

export interface TenantToolModule {
  VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry>;
  buildTools(cfg: TenantToolConfig): TenantTool[];
}

export interface MergedToolCatalog extends ToolCatalog {
  tools: TenantTool[];
  /** Tenants whose tool module failed to load; same shape as `loadTenants`. */
  skipped: SkippedTenant[];
}

/** The dsh parameter specs for the two tools core owns. */
const THESIS_PARAMS: Record<string, Record<string, unknown>> = {
  thesis_read: {
    job: { type: "string", required: true, description: "Tenant name" },
  },
  thesis_write: {
    job: { type: "string", required: true, description: "Tenant name" },
    content: {
      type: "string",
      required: true,
      description: "The full rewritten thesis, max 64 KiB",
    },
  },
};

export async function loadTenantTools(
  tenants: LoadedTenant[],
  cfg: TenantToolConfig,
): Promise<MergedToolCatalog> {
  const tools: TenantTool[] = thesisTools(cfg.stateRoot).map((tool) => ({
    ...tool,
    dshParams: THESIS_PARAMS[tool.name]!,
  }));
  const vocabulary = new Map<string, ToolVocabularyEntry>(
    tools.map((tool) => [tool.name, { mutating: tool.mutating }]),
  );
  const owner = new Map<string, string>(
    tools.map((tool) => [tool.name, "@helium/core"]),
  );

  // One fault domain PER TENANT. A tenant whose module throws on import, names
  // a tool another tenant (or core) already owns, or builds a tool outside its
  // OWN vocabulary loses exactly its own tools and is reported as a
  // SkippedTenant. It must not be able to empty the catalog for everybody --
  // which is what a single try/catch around the whole loop did.
  const skipped: SkippedTenant[] = [];
  for (const tenant of tenants) {
    const entry = join(tenant.dir, "lib", "tools", "index.js");
    if (!existsSync(entry)) continue;
    try {
      const module = (await import(
        pathToFileURL(entry).href
      )) as TenantToolModule;
      const own = new Map<string, ToolVocabularyEntry>(module.VOCABULARY);
      for (const name of own.keys()) {
        const previous = owner.get(name);
        if (previous !== undefined) {
          throw new Error(
            `duplicate tool: ${name} (${previous} and ${tenant.spec.tenant})`,
          );
        }
      }
      const built = module.buildTools(cfg);
      const seen = new Set<string>();
      for (const tool of built) {
        // Validated against the tenant's OWN vocabulary, never the merged one:
        // against the merged map a tenant could build `thesis_read` or another
        // tenant's tool and pass, because the name is already present.
        if (!own.has(tool.name)) {
          throw new Error(
            `built tool ${tool.name} absent from its own VOCABULARY`,
          );
        }
        if (seen.has(tool.name)) {
          throw new Error(`built tool ${tool.name} twice`);
        }
        seen.add(tool.name);
      }
      for (const [name, meta] of own) {
        owner.set(name, tenant.spec.tenant);
        vocabulary.set(name, meta);
      }
      tools.push(...built);
    } catch (error: unknown) {
      skipped.push({
        dir: tenant.dir,
        tenant: tenant.spec.tenant,
        reason: `tools: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { tools, vocabulary, skipped };
}

/**
 * Throws when any role names a tool the merged vocabulary does not have, or
 * names a mutating one. The caller turns the throw into a skipped tenant with
 * a recorded reason (acceptance criterion 7), never into a silent drop.
 */
export function validateTeamTools(
  manifest: TeamManifest,
  vocabulary: ReadonlyMap<string, ToolVocabularyEntry>,
): void {
  const declared = Object.values(manifest.roles).flatMap(
    (role) => role.permissions.tools,
  );
  const unknown = [
    ...new Set(declared.filter((name) => !vocabulary.has(name))),
  ];
  if (unknown.length > 0) {
    throw new Error(`unknown tools: ${unknown.join(", ")}`);
  }
  const mutating = [
    ...new Set(
      declared.filter((name) => vocabulary.get(name)?.mutating === true),
    ),
  ];
  if (mutating.length > 0) {
    throw new Error(
      `mutating tools are forbidden on the team path: ${mutating.join(", ")}`,
    );
  }
}
