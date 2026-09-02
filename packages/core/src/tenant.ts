/**
 * Tenant discovery. A tenant is any `plugins/<name>/tenant.yaml`; there is no
 * registry and no list to edit. Salvaged from v1's `tenants.ts` -- the glob
 * discovery and the skip-with-reason containment already worked, so they are
 * moved, not rewritten.
 *
 * Each tenant is validated on its own: a malformed file skips exactly that
 * tenant with a recorded reason. A DUPLICATE tenant name is different in kind
 * and throws for the whole load -- two tenants under one name means every
 * per-tenant audit row is ambiguous, and silently dropping one of them would
 * make a tenant that is not running look healthy.
 *
 * v2 changes: `promotionMode`'s shadow/review-only/delivered triple state is
 * gone (it gated a promotion ceremony v2 does not have), and `budget:` is new
 * -- design §5 declares the per-run allowance here.
 * @module @helium/core/tenant
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseTeamYaml, type TeamManifest } from "./team.js";

export interface TenantTrigger {
  kind: "cron";
  schedule: string;
  timezone: string;
}

/**
 * The per-run allowance (design §5). Both ceilings are hard: a run that would
 * exceed either fails `budget-exhausted` rather than silently truncating.
 */
export interface TenantBudget {
  usd: number;
  tokens: number;
}

export interface TenantDelivery {
  /** Channel plugin id (`email`, `github-pr`, `file`) and its opaque config. */
  channel: string;
  config: Record<string, unknown>;
}

export interface TenantSpec {
  tenant: string;
  enabled: boolean;
  team: string;
  budget: TenantBudget;
  triggers: TenantTrigger[];
  delivery: TenantDelivery[];
  /** The sandbox kind every role in this tenant runs inside. */
  sandbox: string;
  /** Environment key NAMES forwarded to a tool child. Never values. */
  env?: string[];
  /** Path, relative to the tenant dir, of the run-level prompt. */
  promptFile?: string;
  /** The tenant-owned opaque block; the host never interprets its contents. */
  extensions: Record<string, unknown>;
}

export interface LoadedTenant {
  spec: TenantSpec;
  dir: string;
  manifest: TeamManifest;
  /** Contents of `spec.promptFile`, read once at load; absent when unset. */
  prompt?: string;
}

export interface SkippedTenant {
  dir: string;
  tenant: string;
  reason: string;
}

export interface TenantLoadResult {
  tenants: LoadedTenant[];
  skipped: SkippedTenant[];
}

const CronTriggerSchema = z.strictObject({
  kind: z.literal("cron"),
  schedule: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64),
});

const DeliverySchema = z.strictObject({
  channel: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()).default({}),
});

const TenantShape = z.strictObject({
  tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  enabled: z.boolean(),
  team: z.string().min(1).max(200),
  budget: z.strictObject({
    usd: z.number().nonnegative(),
    tokens: z.number().int().positive(),
  }),
  triggers: z.array(CronTriggerSchema).max(20).default([]),
  delivery: z.array(DeliverySchema).max(8).default([]),
  sandbox: z.string().min(1).max(64).default("none"),
  // Key NAMES only. The value never appears in tenant.yaml: credentials live
  // in a 0600 env file the launcher sources.
  env: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
    .max(32)
    .optional(),
  promptFile: z.string().min(1).max(200).optional(),
  // ONE opaque block, not a host-maintained allow-list of tenant key names. A
  // tenant adding a fourth block edits only its own file; a typo in a HOST key
  // still fails loudly, because strictObject rejects it.
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The same routing-key ban core applies to `team.yaml`, applied here too. A
 * tenant file is not a manifest, so `parseTeamYaml` never sees it -- without
 * this, `model:` in `tenant.yaml` would be the one unguarded place a vendor
 * name could enter a declaration.
 */
const FORBIDDEN_ROUTING_KEYS = new Set([
  "provider",
  "providerid",
  "model",
  "modelid",
  "effort",
  "reasoningeffort",
]);

export function rejectRoutingKeys(value: unknown, path = "tenant"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectRoutingKeys(entry, `${path}[${index}]`),
    );
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

export function parseTenantYaml(text: string, source: string): TenantSpec {
  const decoded: unknown = parseYaml(text);
  rejectRoutingKeys(decoded);
  const parsed = TenantShape.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `${source}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const raw = parsed.data;
  return {
    tenant: raw.tenant,
    enabled: raw.enabled,
    team: raw.team,
    budget: { ...raw.budget },
    triggers: raw.triggers.map((trigger) => ({ ...trigger })),
    delivery: raw.delivery.map((entry) => ({
      channel: entry.channel,
      config: { ...entry.config },
    })),
    sandbox: raw.sandbox,
    ...(raw.env === undefined ? {} : { env: [...raw.env] }),
    ...(raw.promptFile === undefined ? {} : { promptFile: raw.promptFile }),
    extensions: raw.extensions ?? {},
  };
}

/** Every directory under `dir` that carries a `tenant.yaml`, name-ordered. */
export function tenantDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => existsSync(join(dir, name, "tenant.yaml")));
}

export function loadTenants(dir: string): TenantLoadResult {
  const tenants: LoadedTenant[] = [];
  const skipped: SkippedTenant[] = [];
  const seen = new Map<string, string>();
  for (const name of tenantDirs(dir)) {
    const directory = join(dir, name);
    try {
      const spec = parseTenantYaml(
        readFileSync(join(directory, "tenant.yaml"), "utf8"),
        join(name, "tenant.yaml"),
      );
      const previous = seen.get(spec.tenant);
      if (previous !== undefined) {
        throw new Error(`duplicate tenant: ${spec.tenant} (also in ${previous})`);
      }
      seen.set(spec.tenant, name);
      const manifest = parseTeamYaml(
        readFileSync(join(directory, spec.team), "utf8"),
      );
      // A tenant that declares a run-level prompt and then silently runs
      // without it is the exact failure `promptFile` exists to prevent, so an
      // unreadable file is a skip, not a fallback.
      let prompt: string | undefined;
      if (spec.promptFile !== undefined) {
        try {
          prompt = readFileSync(join(directory, spec.promptFile), "utf8");
        } catch {
          throw new Error(`promptFile unreadable: ${spec.promptFile}`);
        }
      }
      tenants.push({
        spec,
        dir: directory,
        manifest,
        ...(prompt === undefined ? {} : { prompt }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("duplicate tenant:")) throw error;
      skipped.push({ dir: directory, tenant: name, reason: message });
    }
  }
  return { tenants, skipped };
}
