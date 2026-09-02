/**
 * Glob discovery for the two plugin kinds a run needs: providers and a
 * tenant's tools. No registry, no list to edit (doctrine 2).
 *
 * A plugin that throws on import is a SKIP with a recorded reason, never a
 * fatal load: one broken directory must not take the harness down.
 * @module @helium/cli/discovery
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EcosystemTool, Provider } from "@helium/core";

export interface Skipped {
  id: string;
  reason: string;
}

export interface DiscoveredProviders {
  live: Provider[];
  skipped: Skipped[];
}

/**
 * Every `plugins/provider-*` whose built `lib/provider.js` default-exports a
 * `Provider` that can EXECUTE a step and whose `probe()` says it is live. A
 * dead one is skipped with its reason, exactly as design §3 requires.
 */
export async function discoverProviders(
  pluginsDir: string,
): Promise<DiscoveredProviders> {
  const live: Provider[] = [];
  const skipped: Skipped[] = [];
  if (!existsSync(pluginsDir)) return { live, skipped };
  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("provider-"))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const entry = join(pluginsDir, name, "lib", "provider.js");
    if (!existsSync(entry)) {
      skipped.push({ id: name, reason: "no built lib/provider.js" });
      continue;
    }
    try {
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: Provider;
      };
      const provider = module.default;
      if (provider === undefined || typeof provider.probe !== "function") {
        skipped.push({ id: name, reason: "default export is not a Provider" });
        continue;
      }
      if (typeof provider.run !== "function") {
        // Routable but not executable. Keeping it would put a target in the
        // catalog that fails every step it wins — and it would win, being the
        // cheapest. Skipping says so once, in the run output.
        skipped.push({
          id: provider.id,
          reason: "no run(): this provider can route a step but not execute one",
        });
        continue;
      }
      if (!(await provider.probe())) {
        const reason = provider.probeReason?.() ?? "probe returned false";
        skipped.push({ id: provider.id, reason });
        continue;
      }
      live.push(provider);
    } catch (error: unknown) {
      skipped.push({
        id: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { live, skipped };
}

/** A tenant's own tools, from its built `lib/tools/index.js`. */
export async function loadTenantTools(
  tenantDir: string,
  cfg: { stateRoot: string; env: NodeJS.ProcessEnv },
): Promise<EcosystemTool[]> {
  const entry = join(tenantDir, "lib", "tools", "index.js");
  if (!existsSync(entry)) return [];
  const module = (await import(pathToFileURL(entry).href)) as {
    buildTools?: (cfg: {
      stateRoot: string;
      env: Record<string, string | undefined>;
    }) => EcosystemTool[];
  };
  if (typeof module.buildTools !== "function") return [];
  return module.buildTools({ stateRoot: cfg.stateRoot, env: cfg.env });
}
