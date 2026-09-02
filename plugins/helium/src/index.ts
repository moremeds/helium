/**
 * helium — thin cordis adapter. Reads the pinned env contract into `Config`,
 * discovers every `plugins/<name>/tenant.yaml`, builds one `TeamController` and
 * one `TenantDelivery` per tenant, and hands them to {@link TenantRuntime} on a
 * single `ctx.effect` lifecycle.
 * @module dsh-plugin-helium
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Cron } from "croner";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import { JsonlWriter, type WorkOrder } from "@helium/core";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { processCanaryInbox } from "./canary-inbox.js";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { readEnvFile } from "./envfile.js";
import { ProviderRuntime } from "./provider-runtime.js";
import { narrower, TeamPromotionAdapter } from "./promotion.js";
import { TeamController } from "./team-controller.js";
import { TenantDelivery } from "./tenant-delivery.js";
import {
  loadValidatedTenants,
  TenantRuntime,
  tenantOutputContracts,
} from "./tenant-runtime.js";
import type { LoadedTenant } from "./tenants.js";

export const name = "helium";
export const inject = [
  "agentDefaultModel",
  "agents",
  "sessions",
  "sessionPersistence",
  "subagents",
  "tools",
];
export { type Config } from "./config.js";
export { TeamPromotionAdapter, TeamReviewStore } from "./promotion.js";
export { TeamController } from "./team-controller.js";

/**
 * Runs a synchronous step and swallows (logs) any throw instead of letting it
 * escape. Used to guard cron callbacks: croner@10.0.1 has no `catch` option
 * for a sync `Cron(...)` callback, so an unguarded throw (e.g. a transient FS
 * failure from `jsonl.prune()`) becomes an unhandled rejection that kills the
 * whole daemon.
 */
export function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e: unknown) {
    console.error(`${label}:`, e);
  }
}

/** Writes one team attempt's MCP allow-list from its provider-neutral WorkOrder. */
export function writeTeamMcpConfig(
  config: Config,
  work: WorkOrder,
  dir: string,
  envKeys: readonly string[] = [],
): string {
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          helium: {
            command: config.mcpBin,
            args: [],
            env: {
              HELIUM_TOOLS: work.constraints.tools.join(","),
              // Stays the literal "0" on every team path. The forwarded keys
              // below are credentials for READ-ONLY tools and can never change
              // that; `selection.ts` drops a tool outside the allow-list even
              // with mutations enabled.
              HELIUM_ALLOW_MUTATIONS: "0",
              HELIUM_ARGON_BASE: config.argonBase,
              HELIUM_APEX_BASE: config.apexBase,
              ...(config.livewireDb ? { HELIUM_LIVEWIRE_DB: config.livewireDb } : {}),
              HELIUM_STATE_ROOT: config.stateRoot,
              // REQUIRED, ABSOLUTE. The child's cwd is an isolated workspace
              // under stateRoot/workspaces, so a relative "plugins" resolves to
              // nothing and every team agent gets zero tools.
              HELIUM_TENANTS_DIR: config.tenantsDir,
              // Tenant-declared keys, forwarded by NAME from the daemon
              // environment (sourced from HELIUM_ENV_FILE by
              // scripts/launchd/run-dsh.sh). A missing key is omitted, not
              // blanked, so a tool preflight reports "unset", not "wrong".
              ...Object.fromEntries(
                envKeys
                  .map((key) => [key, process.env[key]] as const)
                  .filter(
                    (entry): entry is readonly [string, string] =>
                      entry[1] !== undefined,
                  ),
              ),
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

export function apply(ctx: Context, raw: Config): void {
  const cfg = ConfigSchema.parse(raw);
  const paths = statePaths(cfg);
  const jsonl = new JsonlWriter(paths.jsonl);
  const delivery = new Delivery({
    jsonl,
    jsonlDir: paths.jsonl,
    reportsDir: paths.reports,
    emailTo: cfg.emailTo,
    smtp: smtpFromEnv(readEnvFile(cfg.envFile)),
  });

  const providers = new ProviderRuntime(ctx, {
    stateRoot: paths.state,
    workspacesDir: paths.workspaces,
    claudeTokenFile: cfg.claudeTokenFile,
    envFile: cfg.envFile,
    proxy: cfg.proxy,
  });

  // ONE promotion adapter for the whole daemon: it owns the canary allow-list,
  // the per-UTC-day budget and the review-inbox fallback. The effective mode
  // per tenant is `narrower(host brake, tenant request)`, decided inside it.
  const promotionMode = cfg.teamPromotionMode ?? "off";
  const promotion = new TeamPromotionAdapter({
    mode: promotionMode,
    canaryTenants: cfg.teamCanaryTenants ?? [],
    maxPerUtcDay: cfg.teamCanaryMaxPerUtcDay ?? 1,
    stateRoot: paths.state,
    providerHealth: () => providers.healthSnapshot(),
  });
  // Tenant discovery is ASYNC (a tenant's tool module and descriptor are
  // dynamic imports, and `readiness()` is awaited), and cordis `apply` is
  // synchronous, so the awaited work lives inside the existing effect rather
  // than racing the plugin lifecycle.
  ctx.effect(async () => {
    await ctx.get("loader")?.await();
    // ONE load path for tenant discovery, validation and tool loading.
    // Pre-flip validation that ran a different, shorter check is how a bad
    // tool module or a failed preflight reached the mini and was discovered
    // after the launchd flip.
    const { tenants, skipped, catalog } = await loadValidatedTenants({
      tenantsDir: cfg.tenantsDir,
      stateRoot: cfg.stateRoot,
      env: process.env,
    });
    for (const skip of skipped) {
      console.error(
        `helium: SKIPPING ${skip.tenant} (${skip.dir}) -- this tenant is NOT running: ${skip.reason}`,
      );
    }

    // Global in-process registration for dsh agents / the interactive Web UI:
    // read-only by design (spec §6). A mutating tool never reaches this
    // surface, and no tenant tool may declare itself mutating.
    // Every tool -- core's own and every tenant's -- carries its own dsh
    // parameter spec, so registration is a direct `defineTool` call with no
    // host-side name map to keep in step.
    for (const tool of catalog.tools.filter((t) => !t.mutating)) {
      ctx.tools.register(
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.dshParams as ParameterSchemaSpec,
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: String(value) }],
          },
          execute: async (args) => await tool.run(args as Record<string, unknown>),
        }),
      );
    }

    const controllers = new Map<string, TeamController>();
    const controllerFor = (tenant: LoadedTenant): TeamController => {
      const existing = controllers.get(tenant.spec.tenant);
      if (existing !== undefined) return existing;
      const controller = new TeamController({
        stateRoot: join(paths.state, "teams", tenant.spec.tenant),
        manifest: tenant.manifest,
        outputContracts: tenantOutputContracts(tenant),
        // `delivered` is a request in tenant.yaml; HELIUM_TENANT_DELIVERY is
        // the operator saying this host may actually send. Both are required.
        delivery: new TenantDelivery({
          tenant: tenant.spec.tenant,
          policy: tenant.spec.delivery,
          delivery,
          enabled:
            cfg.tenantDeliveryEnabled === true
            && narrower(promotionMode, tenant.spec.promotionMode) === "delivered",
          ...(tenant.descriptor?.renderEmail === undefined
            ? {}
            : { renderEmail: tenant.descriptor.renderEmail }),
        }),
        routing: {
          route: async (input) => {
            const routed = await providers.routing.route(input);
            return {
              decision: routed.decision,
              ...(routed.lease === undefined ? {} : { lease: routed.lease }),
              catalogVersion: routed.audit.catalogVersion,
            };
          },
        },
        execution: {
          run: (teamRunId, work, lease, signal) =>
            providers.runTeam(teamRunId, work, lease, signal, (candidate, dir) =>
              writeTeamMcpConfig(cfg, candidate, dir, tenant.spec.env ?? []),
            ),
          closeTeam: (teamRunId) => providers.host.closeTeam(teamRunId),
          drain: () => providers.host.drain(),
        },
      });
      controllers.set(tenant.spec.tenant, controller);
      return controller;
    };

    const byName = new Map(tenants.map((t) => [t.spec.tenant, t]));
    const tenantRuntime = new TenantRuntime({
      tenantsDir: cfg.tenantsDir,
      stateRoot: cfg.stateRoot,
      tenants,
      skipped,
      controllerFor,
      jsonl,
      reconcileDeliveries: () => delivery.reconcileDeliveries(),
      ...(cfg.tenantLivenessMs === undefined
        ? {}
        : { livenessMs: cfg.tenantLivenessMs }),
      promotion: {
        handle: (tenant, event, run) => promotion.handle(tenant, event, run),
        processCanaryInbox: async () => {
          // A controlled canary is an explicit operator action against an
          // allow-listed tenant; in `off`/`shadow` there is nothing to promote,
          // so the inbox is not drained rather than draining it into failures.
          if (promotionMode === "off" || promotionMode === "shadow") return;
          const results = await processCanaryInbox({
            directory: join(cfg.stateRoot, "team-canary", "requests"),
            knownTenants: new Set(byName.keys()),
            handle: async (request) => {
              const loaded = byName.get(request.tenant);
              if (loaded === undefined) {
                throw new Error(`unknown canary tenant: ${request.tenant}`);
              }
              await promotion.handleCanary(loaded, request, (input) =>
                controllerFor(loaded).run(input),
              );
            },
          });
          for (const result of results) {
            console.log("[helium] controlled canary processed", result);
          }
        },
      },
    });

    await providers.start();
    tenantRuntime.start();
    return async () => {
      tenantRuntime.stop();
      await providers.dispose();
    };
  }, "helium.tenants()");

  // Daily synthesis (spec §8/§11): the floor, not the product. Also prunes
  // the JSONL trail to the 90-day retention window (controller-pinned
  // addition — kept alongside the synthesis send itself, not a separate cron).
  const synthesis = new Cron(
    "5 17 * * *",
    { timezone: "America/New_York", protect: true },
    () => {
      // Guarded independently of the dailySynthesis catch below (see
      // runGuarded's doc comment for why this needs its own guard).
      runGuarded("helium.prune", () => {
        jsonl.prune(90);
      });
      void delivery.dailySynthesis().catch((e: unknown) => {
        console.error("helium.synthesis:", e);
      });
    },
  );
  ctx.effect(
    () => () => {
      synthesis.stop();
    },
    "helium.delivery.synthesis()",
  );
}
