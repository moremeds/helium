#!/usr/bin/env node
// The deploy flips `current` but never rewrites com.helium.dsh.plist. A release
// that moves or deletes a path the plist names therefore leaves the daemon
// pointing at nothing: launchd restarts it, the process looks alive, and it
// serves zero tools -- silently. This refuses the flip instead and names the
// keys to fix.
//
// Usage: check-plist-paths.mjs <plist> <releasesDir> <newReleaseDir>
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function missingReleasePaths(env, releasesDir, newRelease) {
  const missing = [];
  for (const [key, value] of Object.entries(env).sort()) {
    if (typeof value !== "string" || !value.startsWith(`${releasesDir}/`)) continue;
    // <releases>/<version-or-current>/<rest> -- only <rest> is what the new
    // release must still provide; the version segment is what the flip changes.
    const rest = value.slice(releasesDir.length + 1).split("/").slice(1).join("/");
    if (rest === "") continue;
    if (!existsSync(join(newRelease, rest))) missing.push({ key, value, rest });
  }
  return missing;
}

export function readPlistEnv(plist) {
  return JSON.parse(
    execFileSync("plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plist], {
      encoding: "utf8",
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [plist, releasesDir, newRelease] = process.argv.slice(2);
  if (!plist || !releasesDir || !newRelease) {
    console.error("usage: check-plist-paths.mjs <plist> <releasesDir> <newReleaseDir>");
    process.exit(64);
  }
  if (!existsSync(plist)) process.exit(0); // nothing installed yet: nothing to break
  const missing = missingReleasePaths(readPlistEnv(plist), releasesDir, newRelease);
  if (missing.length > 0) {
    console.error(`REFUSING the flip: ${plist} names paths this release does not contain.`);
    for (const m of missing) console.error(`  ${m.key}=${m.value}\n    -> missing: ${m.rest}`);
    console.error(
      `\nReinstall the plist from ${newRelease}/launchd/com.helium.dsh.plist.template ` +
        `(or edit those keys), then re-run the deploy.`,
    );
    process.exit(1);
  }
}
