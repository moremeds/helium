#!/usr/bin/env node
// Per-tenant liveness check (Phase 0 Task 5). The sibling check-heartbeat.sh is
// a GLOBAL check: it looks at the newest heartbeat row in the newest file, so it
// stays green as long as ANY tenant is alive. This one asks the question that
// misses: is EVERY expected tenant heartbeating on its own?
//
// Exit: 0 every expected tenant accounted for, 10 at least one is not, 2 config.
//
// Env: HELIUM_TENANTS_DIR, HELIUM_STATE_ROOT, HELIUM_DEADMAN_STALE_S (default 600).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Relative, not a bare `@helium/core` specifier: scripts/ is not a workspace
// package, so a bare import does not resolve from here (ERR_MODULE_NOT_FOUND).
const { tenantHealth } = await import(
  join(here, "..", "..", "packages", "core", "lib", "tenant-health.js")
);
// The inventory now lives in the HOST, because a tenant is a plugin directory
// shape rather than a flat `*.yaml` file, and knowing that shape is host
// knowledge core does not carry.
const { inventoryTenantPlugins } = await import(
  join(here, "..", "..", "plugins", "helium", "lib", "tenants.js")
);

const tenantsDir =
  process.env.HELIUM_TENANTS_DIR ?? join(here, "..", "..", "plugins");
const stateRoot =
  process.env.HELIUM_STATE_ROOT ?? join(homedir(), ".helium", "state");
const staleS = Number(process.env.HELIUM_DEADMAN_STALE_S ?? "600");

if (!existsSync(tenantsDir)) {
  console.error(`no tenants directory at ${tenantsDir}`);
  process.exit(2);
}

const expected = inventoryTenantPlugins(tenantsDir);
if (expected.length === 0) {
  console.error(`no plugins/*/tenant.yaml in ${tenantsDir}`);
  process.exit(2);
}

// Read the two newest heartbeat files, not just the newest: the cutoff window
// can straddle a UTC-midnight file boundary, and a tenant heartbeating just
// before midnight would otherwise read as missing for the first cycle after it.
const jsonlDir = join(stateRoot, "jsonl");
const files = existsSync(jsonlDir)
  ? readdirSync(jsonlDir)
      .filter((f) => f.startsWith("heartbeat-") && f.endsWith(".jsonl"))
      .sort()
      .slice(-2)
  : [];

const rows = [];
for (const file of files) {
  for (const line of readFileSync(join(jsonlDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn final line is normal for an append-only file being written
      // concurrently. Skip it; never let it fail the liveness check.
    }
  }
}

const now = Date.now();
const health = tenantHealth(expected, rows, now - staleS * 1000, now);
const bad = health.filter((h) => h.state !== "healthy" && h.state !== "disabled");

for (const h of health) {
  const label =
    h.state === "healthy"
      ? "ok"
      : h.state === "disabled"
        ? "disabled (not required to heartbeat)"
        : h.state === "invalid"
          ? "INVALID (tenant file does not parse — it is NOT running)"
          : `MISSING (no heartbeat within ${staleS}s)`;
  console.log(`${h.tenant}: ${label}`);
}

if (bad.length === 0) {
  console.log(`all ${health.length} tenants accounted for`);
  process.exit(0);
}
console.error(
  `STALE or INVALID tenants: ${bad.map((h) => `${h.tenant} (${h.state})`).join(", ")}`,
);
process.exit(10);
