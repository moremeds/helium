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
const { tenants, skipped } = await loadValidatedTenants({
  tenantsDir: join(release, "plugins"),
  stateRoot: process.env.HELIUM_STATE_ROOT ?? join(release, ".validate-state"),
  env: process.env,
});
for (const skip of skipped) {
  process.stderr.write(`  SKIPPED ${skip.tenant}: ${skip.reason}\n`);
}
if (skipped.length > 0) {
  throw new Error(`${skipped.length} tenant(s) failed validation`);
}
process.stdout.write(
  `  ${tenants.length} tenant file(s) parse cleanly: ${tenants
    .map((tenant) => tenant.spec.tenant)
    .join(", ")}\n`,
);
