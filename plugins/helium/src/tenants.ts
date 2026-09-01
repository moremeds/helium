/**
 * Tenant discovery. A tenant is any `plugins/<name>/tenant.yaml`; there is no
 * registry and no list to edit. The host owns identity, cron triggers,
 * promotion mode and delivery policy; `team.yaml` is handed to core's
 * `parseTeamYaml` untouched, and `universe`/`screener`/`preflight` are carried
 * through as opaque tenant-owned blocks the host never reads inside.
 *
 * Each tenant is validated on its own: a malformed file skips exactly that
 * tenant with a recorded reason, which is the containment `loadJobs()` gave v1.
 * A DUPLICATE tenant name is different in kind and throws for the whole load —
 * two tenants under one name means every per-tenant record (heartbeat, review
 * item, delivery row) is ambiguous, and silently dropping one of them would
 * make a tenant that is not running look healthy.
 * @module dsh-plugin-helium/tenants
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  parseTeamYaml,
  type ExpectedTenant,
  type ArtifactProjection,
  type TeamManifest,
  type TeamRunProjection,
} from "@helium/core";
import type { OutputContractDefinition } from "./output-contract-registry.js";

export interface TenantTrigger {
  kind: "cron";
  schedule: string;
  timezone: string;
}

export interface TenantEmailPolicy {
  to: string;
  subjectPrefix: string;
  maxPerDay: number;
}

export interface TenantDeliveryPolicy {
  jsonl: boolean;
  email?: TenantEmailPolicy;
}

export interface TenantSpec {
  tenant: string;
  enabled: boolean;
  team: string;
  promotionMode: "shadow" | "review-only" | "delivered";
  triggers: TenantTrigger[];
  delivery: TenantDeliveryPolicy;
  /** Environment key NAMES forwarded to the MCP child. Never values. */
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
  /** Filled in by `loadTenantDescriptor()` after the sync load; never by `loadTenants()`. */
  descriptor?: TenantDescriptor;
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

export interface TenantRenderInput {
  tenant: string;
  teamRunId: string;
  team: TeamRunProjection;
  /**
   * `TeamRunProjection.artifacts` widened with each artifact's body. Populated
   * by the delivery port from the same `TeamStore` it already holds;
   * `ArtifactRegistry.read` is synchronous, so `renderEmail` stays synchronous
   * and no caller becomes async.
   */
  artifacts: Record<string, ArtifactProjection & { content: string }>;
}

/**
 * Optional, tenant-supplied behaviour. Loaded from the DEFAULT export of
 * `<tenantDir>/lib/index.js` when that file exists; absent means the generic
 * host behaviour, and `plugins/fake-tenant` deliberately ships none. Every
 * field is optional and independently overridable.
 */
export interface TenantDescriptor {
  /**
   * ADDS to the builtin registry; it can never replace or empty it. The tenant
   * returns plain `OutputContractDefinition`s keyed by id and the HOST calls
   * `register()` on the base registry, so a duplicate id throws with the
   * tenant's name attached and core's `ClaimSet.v1` /
   * `EvidenceDecisionSet.v1` / `AdjudicatedSynthesis.v1` contracts survive by
   * construction.
   */
  outputContracts?: () => Record<string, OutputContractDefinition>;
  /**
   * SYNCHRONOUS by contract. `ArtifactRegistry.read` is synchronous, the
   * delivery port has the bodies before it calls this, and making it async
   * would push `await` into `TeamControllerOptions.delivery` and from there
   * into the append-ordering path. Do not "helpfully" widen it to a Promise.
   */
  renderEmail?: (input: TenantRenderInput) => {
    subject: string;
    text: string;
    html?: string;
  };
  /**
   * Environment preflight, run once at load. `ok: false` skips the tenant with
   * the given reason — the same `SkippedTenant` channel as a malformed manifest
   * or an unknown tool, so "disabled" is a recorded fact, not a log line.
   * A throw is treated as `{ ok: false, reason: <message> }`; absent means ready.
   */
  readiness?: () => Promise<{ ok: boolean; reason?: string }>;
}

const CronTriggerSchema = z.strictObject({
  kind: z.literal("cron"),
  schedule: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64),
});

const EmailSchema = z.strictObject({
  to: z.string().min(1).max(200),
  subject_prefix: z.string().min(1).max(120),
  max_per_day: z.number().int().positive().max(100),
});

const TenantShape = z.strictObject({
  tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  enabled: z.boolean(),
  team: z.string().min(1).max(200),
  promotionMode: z.enum(["shadow", "review-only", "delivered"]),
  triggers: z.array(CronTriggerSchema).min(1).max(20),
  delivery: z.strictObject({
    jsonl: z.boolean(),
    email: EmailSchema.optional(),
  }),
  // Key NAMES only. The value never appears in tenant.yaml: credentials live in
  // the 0600 HELIUM_ENV_FILE that scripts/launchd/run-dsh.sh:14-23 sources.
  env: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
    .max(32)
    .optional(),
  promptFile: z.string().min(1).max(200).optional(),
  // ONE opaque block, not a host-maintained allow-list of tenant key names. A
  // tenant adding a fourth block edits only its own file; a typo in a HOST key
  // ("promotion_mode") still fails loudly, because strictObject rejects it.
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The same routing-key ban core applies to `team.yaml`, applied here too. A
 * tenant file is not a manifest, so `parseTeamYaml` never sees it — without
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

function rejectRoutingKeys(value: unknown, path = "tenant"): void {
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
  const email = raw.delivery.email;
  return {
    tenant: raw.tenant,
    enabled: raw.enabled,
    team: raw.team,
    promotionMode: raw.promotionMode,
    triggers: raw.triggers.map((trigger) => ({ ...trigger })),
    ...(raw.env === undefined ? {} : { env: [...raw.env] }),
    ...(raw.promptFile === undefined ? {} : { promptFile: raw.promptFile }),
    delivery: {
      jsonl: raw.delivery.jsonl,
      ...(email === undefined
        ? {}
        : {
            email: {
              to: email.to,
              subjectPrefix: email.subject_prefix,
              maxPerDay: email.max_per_day,
            },
          }),
    },
    extensions: raw.extensions ?? {},
  };
}

/** Every directory under `dir` that carries a `tenant.yaml`, name-ordered. */
function tenantDirs(dir: string): string[] {
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
        throw new Error(
          `duplicate tenant: ${spec.tenant} (also in ${previous})`,
        );
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

/**
 * Inventory every tenant DIRECTORY before parsing any of it, so a tenant whose
 * YAML is broken stays visible as `invalid` instead of vanishing from the
 * expected set — the same ordering `inventoryTenants()` uses in core, over the
 * plugin directory shape rather than a flat `*.yaml` directory.
 */
export function inventoryTenantPlugins(dir: string): ExpectedTenant[] {
  return tenantDirs(dir).map((name) => {
    try {
      const spec = parseTenantYaml(
        readFileSync(join(dir, name, "tenant.yaml"), "utf8"),
        join(name, "tenant.yaml"),
      );
      return {
        tenant: spec.tenant,
        load: spec.enabled ? ("loaded" as const) : ("disabled" as const),
      };
    } catch {
      return { tenant: name, load: "invalid" as const };
    }
  });
}

/**
 * A tenant MAY ship behaviour the host cannot express declaratively: per-task
 * output contract DEFINITIONS (the host registers them, the tenant never sees
 * the registry), an email renderer that knows its own domain, and an
 * environment readiness probe. All three arrive as the default export of the
 * tenant's built `lib/index.js`. There is exactly one such loader. The file
 * is optional by design -- `plugins/fake-tenant` ships none, and a tenant that
 * ships neither field is indistinguishable from one that ships no file at all.
 * A descriptor that fails to import is a per-tenant fault, not a load failure:
 * it is reported and the tenant falls back to generic behaviour.
 */
export async function loadTenantDescriptor(
  tenant: LoadedTenant,
): Promise<TenantDescriptor | undefined> {
  const entry = join(tenant.dir, "lib", "index.js");
  if (!existsSync(entry)) return undefined;
  const module = (await import(pathToFileURL(entry).href)) as {
    default?: TenantDescriptor;
  };
  return module.default;
}
