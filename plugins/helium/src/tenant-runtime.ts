/**
 * The tenant trigger loop: one `croner` Cron per declared trigger, each firing
 * a `TeamRunInput` at that tenant's own `TeamController`. This is the whole of
 * the tenant lane's scheduling — `tenant.yaml` declares cron triggers only, so
 * there is no poller, no calendar watcher and no state-change dedup here.
 *
 * A tenant that failed to load is NOT silently absent: it gets a
 * `tenant-health` row with `load: "invalid"` and the recorded reason, because
 * the operator-visible symptom of a vanished tenant is a fleet that looks
 * entirely healthy while one tenant is not running.
 * @module dsh-plugin-helium/tenant-runtime
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  nowIso,
  type JsonlWriter,
  type TeamRunProjection,
} from "@helium/core";
import { Cron } from "croner";
import {
  createBuiltinOutputContractRegistry,
  type OutputContractRegistry,
} from "./output-contract-registry.js";
import type { TeamRunInput } from "./team-controller.js";
import {
  loadTenantDescriptor,
  loadTenants,
  type LoadedTenant,
  type SkippedTenant,
} from "./tenants.js";
import {
  loadTenantTools,
  validateTeamTools,
  type MergedToolCatalog,
} from "./tenant-tools.js";

export type { TenantTrigger } from "./tenants.js";

export interface TenantTriggerEvent {
  tenant: string;
  kind: "cron";
  firedAt: string;
  dedupKey: string;
  payload: Record<string, unknown>;
}

/**
 * Poll `cycle()` on a self-rescheduling timer, returning a disposer. Lifted
 * unchanged from the retired `sensor.ts`; the controlled-canary inbox is its
 * only remaining consumer.
 */
export function scheduleLoop(
  intervalMs: () => number,
  cycle: () => Promise<void>,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = (): void => {
    if (stopped) return;
    void cycle()
      .catch((error: unknown) => {
        console.error("helium.scheduleLoop:", error);
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(run, intervalMs());
        timer.unref();
      });
  };
  run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function buildTenantRunInput(
  tenant: string,
  event: TenantTriggerEvent,
  prompt: string,
): TeamRunInput {
  const content = canonicalJson({ tenant, event });
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    caseId: `tenant-${digest.slice(0, 24)}`,
    subject: `${tenant}:${event.kind}`,
    prompt,
    inputArtifacts: [
      {
        ref: `artifact://tenant-trigger/${digest}`,
        hash: `sha256:${digest}`,
        content,
      },
    ],
  };
}

/**
 * The ONE load path. Startup (`apply()`) and the pre-flip release check
 * both call this, so the two can
 * never diverge: `loadTenants` + `loadTenantTools` + `validateTeamTools` +
 * `loadTenantDescriptor` + `readiness()`, with every failure landing in
 * `skipped` and nothing thrown except a duplicate tenant name.
 */
export async function loadValidatedTenants(opts: {
  tenantsDir: string;
  stateRoot: string;
  env: Record<string, string | undefined>;
}): Promise<{
  tenants: LoadedTenant[];
  skipped: SkippedTenant[];
  catalog: MergedToolCatalog;
}> {
  const loaded = loadTenants(opts.tenantsDir); // throws ONLY on a duplicate name
  const catalog = await loadTenantTools(loaded.tenants, {
    stateRoot: opts.stateRoot,
    env: opts.env,
  });
  const badTools = new Set(catalog.skipped.map((entry) => entry.tenant));
  const skipped: SkippedTenant[] = [...loaded.skipped, ...catalog.skipped];
  const tenants: LoadedTenant[] = [];
  for (const tenant of loaded.tenants) {
    if (badTools.has(tenant.spec.tenant)) continue;
    try {
      // A tenant whose roles name a tool no tenant provides is disabled with a
      // recorded reason rather than started blind (acceptance criterion 7).
      validateTeamTools(tenant.manifest, catalog.vocabulary);
      tenant.descriptor = await loadTenantDescriptor(tenant);
      tenants.push(tenant);
    } catch (error: unknown) {
      skipped.push({
        dir: tenant.dir,
        tenant: tenant.spec.tenant,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // A tenant whose environment is not ready is skipped with a reason, on the
  // same channel as a malformed manifest -- so "disabled" is a recorded fact,
  // not a log line. Bounded so a hung probe cannot hold up start-up.
  for (const tenant of [...tenants]) {
    const probe = tenant.descriptor?.readiness;
    if (probe === undefined) continue;
    let verdict: { ok: boolean; reason?: string };
    try {
      verdict = await Promise.race([
        probe(),
        new Promise<{ ok: boolean; reason: string }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: false,
                reason: "readiness probe timed out after 20s",
              }),
            20_000,
          ).unref();
        }),
      ]);
    } catch (error: unknown) {
      verdict = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (verdict.ok) continue;
    tenants.splice(tenants.indexOf(tenant), 1);
    skipped.push({
      dir: tenant.dir,
      tenant: tenant.spec.tenant,
      reason: `not ready: ${verdict.reason ?? "unspecified"}`,
    });
  }
  return { tenants, skipped, catalog };
}

/**
 * The output-contract registry one tenant's controller gets: the builtins,
 * plus whatever the tenant's descriptor ADDS. The tenant returns plain
 * definitions and the HOST registers them, so a tenant can never hand back a
 * fresh (or empty) registry, and `register()` throws on a duplicate id — the
 * builtins survive by construction.
 */
export function tenantOutputContracts(
  tenant: LoadedTenant,
): OutputContractRegistry {
  const outputContracts = createBuiltinOutputContractRegistry();
  for (const [id, definition] of Object.entries(
    tenant.descriptor?.outputContracts?.() ?? {},
  )) {
    try {
      outputContracts.register(id, definition);
    } catch (error: unknown) {
      throw new Error(
        `tenant ${tenant.spec.tenant} output contract ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return outputContracts;
}

export interface TenantRuntimeDeps {
  tenantsDir: string;
  stateRoot: string;
  tenants: LoadedTenant[];
  skipped: SkippedTenant[];
  controllerFor(tenant: LoadedTenant): {
    run(input: TeamRunInput): Promise<TeamRunProjection>;
  };
  /**
   * The single owner of promotion. Every run goes through
   * `TeamPromotionAdapter.handle` (`plugins/helium/src/promotion.ts`), which is
   * what applies the canary allow-list, the per-UTC-day budget and the
   * review-inbox fallback. `TenantRuntime` never calls `controller.run`
   * directly — `controllerFor` is handed TO the adapter, not used beside it.
   */
  promotion: {
    handle(
      tenant: LoadedTenant,
      event: TenantTriggerEvent,
      run: (input: TeamRunInput) => Promise<TeamRunProjection>,
    ): Promise<void>;
    processCanaryInbox(): Promise<void>;
  };
  /**
   * Closes every delivery intent a crash left unresolved, ONCE, before the
   * first trigger is armed. Without it a killed daemon leaves an intent that
   * no later run resolves, and `TenantDelivery` cannot tell an already-sent
   * report from a new one.
   */
  reconcileDeliveries?: () => number;
  /** Runtime liveness heartbeat period; 0 disables it (tests). */
  livenessMs?: number;
  jsonl: JsonlWriter;
  now?: () => Date;
  log?(message: string, extra?: Record<string, unknown>): void;
}

export class TenantRuntime {
  readonly #enabled: LoadedTenant[];
  readonly #disposers: (() => void)[] = [];

  constructor(private readonly deps: TenantRuntimeDeps) {
    this.#enabled = deps.tenants.filter((tenant) => tenant.spec.enabled);
  }

  get tenantNames(): string[] {
    return this.#enabled.map((tenant) => tenant.spec.tenant);
  }

  start(): void {
    const orphaned = this.deps.reconcileDeliveries?.();
    if (orphaned !== undefined && orphaned > 0) {
      this.deps.jsonl.append("tenant-health", {
        load: "reconciled",
        orphanedDeliveries: orphaned,
        phase: "startup",
      });
    }
    for (const skip of this.deps.skipped) {
      this.deps.jsonl.append("tenant-health", {
        tenant: skip.tenant,
        load: "invalid",
        reason: skip.reason,
        phase: "startup",
      });
    }
    for (const tenant of this.deps.tenants) {
      if (tenant.spec.enabled) continue;
      this.deps.jsonl.append("tenant-health", {
        tenant: tenant.spec.tenant,
        load: "disabled",
        phase: "startup",
      });
    }
    for (const tenant of this.#enabled) {
      this.deps.jsonl.append("tenant-health", {
        tenant: tenant.spec.tenant,
        load: "loaded",
        phase: "startup",
      });
      for (const trigger of tenant.spec.triggers) {
        // `protect: true`: a run still in flight when the next tick arrives
        // suppresses that tick rather than overlapping it.
        const cron = new Cron(
          trigger.schedule,
          { timezone: trigger.timezone, protect: true },
          () => {
            const firedAt = nowIso();
            void this.#fire(tenant, {
              tenant: tenant.spec.tenant,
              kind: "cron",
              firedAt,
              dedupKey: `${tenant.spec.tenant}:cron:${firedAt.slice(0, 16)}Z`,
              payload: { scheduledFor: firedAt },
            }).catch((error: unknown) => {
              console.error(`helium.cron(${tenant.spec.tenant}):`, error);
            });
          },
        );
        this.#disposers.push(() => {
          cron.stop();
        });
      }
    }
    // Runtime liveness, not a business event. `trigger: "liveness"` keeps the
    // two distinguishable in the 90-day trail; the dead-man only needs a row
    // inside its window, and a tenant whose process is gone stops writing them.
    //
    // The runtime-level row is written unconditionally, INCLUDING when zero
    // tenants are enabled -- which is the mini's current state. It is the only
    // proof that the plugin parsed its config and this runtime started, and
    // deploy.sh's post-flip health window is built on exactly that. `job` is a
    // fixed non-tenant name; every consumer selects rows by an expected tenant
    // name (tenantHealth, read-latest-heartbeats) or ignores `job` entirely
    // (check-heartbeat.sh), so no consumer mistakes it for a tenant.
    const livenessMs = this.deps.livenessMs ?? 300_000;
    if (livenessMs > 0) {
      const beat = (): void => {
        this.deps.jsonl.append("heartbeat", {
          job: "tenant-runtime",
          trigger: "liveness",
          at: nowIso(),
        });
        for (const tenant of this.#enabled) {
          this.deps.jsonl.append("heartbeat", {
            job: tenant.spec.tenant,
            trigger: "liveness",
            at: nowIso(),
          });
        }
      };
      // One row at start-up, so a freshly restarted daemon is not reported
      // MISSING for a whole liveness period before its first tick.
      beat();
      const timer = setInterval(beat, livenessMs);
      timer.unref();
      this.#disposers.push(() => {
        clearInterval(timer);
      });
    }
    this.#disposers.push(
      scheduleLoop(
        () => 60_000,
        () => this.deps.promotion.processCanaryInbox(),
      ),
    );
  }

  stop(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
  }

  /** Fire one tenant's trigger synchronously. Test seam only. */
  async fireForTest(tenant: string): Promise<void> {
    const loaded = this.#enabled.find((entry) => entry.spec.tenant === tenant);
    if (loaded === undefined) throw new Error(`unknown tenant: ${tenant}`);
    const firedAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.#fire(loaded, {
      tenant,
      kind: "cron",
      firedAt,
      dedupKey: `${tenant}:cron:${firedAt.slice(0, 16)}Z`,
      payload: { scheduledFor: firedAt },
    });
  }

  async #fire(tenant: LoadedTenant, event: TenantTriggerEvent): Promise<void> {
    this.deps.jsonl.append("heartbeat", {
      job: tenant.spec.tenant,
      trigger: "cron",
      firedAt: event.firedAt,
      at: nowIso(),
    });
    // A5: the tenant's own run-level prompt when it ships one. It reaches
    // EVERY task (`team-controller.ts:331-343` joins `input.prompt` first), so
    // a tenant writing per-role text there must address each block by task id
    // and tell each role to ignore blocks addressed to other task ids.
    const run = (): Promise<TeamRunProjection> =>
      this.deps
        .controllerFor(tenant)
        .run(
          buildTenantRunInput(
            tenant.spec.tenant,
            event,
            tenant.prompt ?? `${tenant.spec.tenant} scheduled run`,
          ),
        );
    try {
      // Promotion owns the run. The adapter applies the canary allow-list, the
      // per-UTC-day budget and the review-inbox fallback, then calls this
      // thunk; nothing here bypasses it.
      await this.deps.promotion.handle(tenant, event, run);
    } catch (error: unknown) {
      (
        this.deps.log ??
        ((m: string, e?: Record<string, unknown>) =>
          console.error(`[helium] ${m}`, e ?? ""))
      )("tenant run failed", {
        tenant: tenant.spec.tenant,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
