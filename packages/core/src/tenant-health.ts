/**
 * Per-tenant liveness (Phase 0 Task 5).
 *
 * The existing dead-man check is a GLOBAL one: it finds the newest row in the
 * newest `heartbeat-*.jsonl` and asks how old it is. That passes as long as
 * *any* tenant is alive, so a single silent tenant in a healthy fleet is
 * invisible to it. These two functions close that blind spot, and they are
 * deliberately split: `inventoryTenants()` is the only part that touches the
 * filesystem, `tenantHealth()` is a pure reducer that the dead-man script and
 * the runtime both drive.
 * @module @helium/core/tenant-health
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The two fields {@link inventoryTenants} needs out of a parsed tenant file. */
export interface ParsedTenant {
  name: string;
  enabled: boolean;
}

/**
 * How a tenant file becomes a tenant. Injected rather than imported: parsing a
 * tenant file is host knowledge and lives in the host (`plugins/helium`), while
 * per-tenant liveness is a domain-neutral concern that stays here. Core may not
 * depend on the compatibility package, so the caller supplies the parser.
 */
export type TenantParser = (text: string, source: string) => ParsedTenant;

/** How a tenant's own YAML file resolved at load time. */
export type TenantLoad = "loaded" | "invalid" | "disabled";

export type TenantState = "healthy" | "missing" | "invalid" | "disabled";

export interface ExpectedTenant {
  tenant: string;
  load: TenantLoad;
}

export interface TenantHealthRow {
  tenant: string;
  state: TenantState;
}

/** The fields of a heartbeat row this reducer reads; everything else is ignored. */
export interface HeartbeatRow {
  ts?: unknown;
  job?: unknown;
}

/**
 * Inventory every `*.yaml` in `dir` **before** parsing any of them, so a file
 * that fails to parse still yields a tenant.
 *
 * This ordering is the whole point. If the inventory were built from the
 * successfully parsed jobs, a tenant with a typo in its YAML would simply
 * vanish from the expected set — and a fleet with one tenant silently not
 * running would report as completely healthy. A malformed file therefore stays
 * in the inventory as `invalid`, named after its file, since it has no parsed
 * name to be known by.
 *
 * @param dir - the jobs directory.
 * @param parse - the tenant-file parser; throwing marks the tenant `invalid`.
 * @returns one entry per `*.yaml`, in file-name order.
 */
export function inventoryTenants(
  dir: string,
  parse: TenantParser,
): ExpectedTenant[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => {
      try {
        const spec = parse(readFileSync(join(dir, file), "utf8"), file);
        return {
          tenant: spec.name,
          load: spec.enabled ? ("loaded" as const) : ("disabled" as const),
        };
      } catch {
        return { tenant: file.replace(/\.yaml$/, ""), load: "invalid" as const };
      }
    });
}

/**
 * Reduce an expected inventory plus recent heartbeat rows to one state per
 * tenant.
 *
 * A tenant is `healthy` only on the strength of **its own** heartbeat: the
 * reducer never infers one tenant's liveness from another's row, which is
 * exactly what the global check does wrong.
 *
 * @param expected - the inventory from {@link inventoryTenants}.
 * @param rows - recent heartbeat rows; malformed ones are ignored, not fatal.
 * @param deadline - epoch ms (or a Date); a row at or after it may count as live.
 * @param now - upper bound for freshness; future rows never count as live.
 * @returns one row per expected tenant, in inventory order.
 */
export function tenantHealth(
  expected: ExpectedTenant[],
  rows: HeartbeatRow[],
  deadline: number | Date,
  now: number | Date = Date.now(),
): TenantHealthRow[] {
  const cutoff = typeof deadline === "number" ? deadline : deadline.getTime();
  const upperBound = typeof now === "number" ? now : now.getTime();
  const live = new Set<string>();
  for (const row of rows) {
    if (typeof row.job !== "string" || typeof row.ts !== "string") continue;
    const at = Date.parse(row.ts);
    if (Number.isNaN(at) || at < cutoff || at > upperBound) continue;
    live.add(row.job);
  }
  return expected.map(({ tenant, load }) => ({
    tenant,
    state:
      load === "invalid"
        ? "invalid"
        : load === "disabled"
          ? "disabled"
          : live.has(tenant)
            ? "healthy"
            : "missing",
  }));
}
