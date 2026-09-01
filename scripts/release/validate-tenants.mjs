#!/usr/bin/env node
/** Validate every tenant from the same clean release that will be flipped. */
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const release = resolve(process.argv[2] ?? "");
if (process.argv.length !== 3 || process.argv[2] === "") {
  throw new Error("usage: validate-tenants.mjs RELEASE_ROOT");
}
// The SAME entry point startup uses. A pre-flip check that only parsed YAML
// left the parts that actually fail -- a tool module that throws, a role naming
// an unknown tool, a descriptor that will not import, a failed readiness probe
// -- to be discovered after the launchd flip.
const modulePath = join(
  release,
  "plugins",
  "helium",
  "lib",
  "tenant-runtime.js",
);
const { loadValidatedTenants } = await import(pathToFileURL(modulePath).href);
if (typeof loadValidatedTenants !== "function") {
  throw new Error("helium release has no loadValidatedTenants export");
}
const tenantsDir = join(release, "plugins");
// The loader validates EVERY discovered tenant, `enabled: false` included, so a
// skip alone cannot tell "this was supposed to run and silently did not" from
// "this ships switched off on purpose". Only the first is a deploy hazard;
// failing on the second would make it impossible to ship a disabled tenant at
// all, and shipping one is part of the design (plugins/livewire-shepherd).
const { inventoryTenantPlugins } = await import(
  pathToFileURL(join(release, "plugins", "helium", "lib", "tenants.js")).href
);
const load = new Map(
  inventoryTenantPlugins(tenantsDir).map((entry) => [entry.tenant, entry.load]),
);
const { tenants, skipped } = await loadValidatedTenants({
  tenantsDir,
  stateRoot: process.env.HELIUM_STATE_ROOT ?? join(release, ".validate-state"),
  env: process.env,
});
// A tenant whose manifest will not even parse is reported as `invalid`, never
// `disabled`, so it still blocks: "unparseable" is not a declaration.
const blocking = skipped.filter((skip) => load.get(skip.tenant) !== "disabled");
for (const skip of skipped) {
  const shipped = load.get(skip.tenant) === "disabled" ? " (disabled)" : "";
  process.stderr.write(`  SKIPPED${shipped} ${skip.tenant}: ${skip.reason}\n`);
}
if (blocking.length > 0) {
  throw new Error(`${blocking.length} enabled tenant(s) failed validation`);
}
process.stdout.write(
  `  ${tenants.length} tenant file(s) parse cleanly: ${tenants
    .map((tenant) => tenant.spec.tenant)
    .join(", ")}\n`,
);
