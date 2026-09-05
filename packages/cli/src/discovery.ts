/**
 * Glob discovery for the two plugin kinds a run needs: providers and a
 * tenant's tools. No registry, no list to edit (doctrine 2).
 *
 * A plugin that throws on import is a SKIP with a recorded reason, never a
 * fatal load: one broken directory must not take the harness down.
 * @module @helium/cli/discovery
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Channel,
  EcosystemTool,
  Gate,
  Provider,
  TenantRenderer,
} from "@helium/core";

/**
 * Tenants are CONFIGURATION: which teams this install runs. Relocatable, so a
 * tenant can be developed or run from outside the checkout.
 */
export function tenantsDir(env: NodeJS.ProcessEnv): string {
  return env.HELIUM_TENANTS_DIR ?? resolve(process.cwd(), "plugins");
}

/**
 * Providers, gates and delivery channels are CODE: discovered next to the
 * build that imports their `lib/*.js`. Relocating tenants must not take these
 * with it — before the split, `HELIUM_TENANTS_DIR` moved both, so pointing it
 * at a scratch tenant silently left the run with no providers at all.
 */
export function pluginsDir(env: NodeJS.ProcessEnv): string {
  return env.HELIUM_PLUGINS_DIR ?? resolve(process.cwd(), "plugins");
}

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
    // isDirectory() is false for a symlink, so a symlinked plugin would be
    // invisible with no error. Follow them.
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        entry.name.startsWith("provider-"),
    )
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
          reason:
            "no run(): this provider can route a step but not execute one",
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
export interface TenantToolConfig {
  stateRoot: string;
  env: NodeJS.ProcessEnv;
  /** The past instant this run replays, when it replays one. */
  asOf?: Date;
  /** The run's flavour label. `live` on an ordinary run. */
  variant: string;
  /** Where a tool says it has no history for `asOf`. The runner counts these
   *  and never inspects the reason — what a source is remains the tenant's
   *  business (doctrine 2). */
  pit?: { markUnavailable: (tool: string, reason: string) => void };
  /** The tenant's own declaration of which days are closed. The runner uses it
   *  to decide whether to run at all; a tool needs it to walk BACKWARDS to the
   *  previous open day, which it must not guess. */
  calendar?: { weekdaysOnly: boolean; closed: string[] };
  /** Recorded responses from an earlier run, when the operator named one with
   *  `--replay-from`. A tool with no history for `asOf` may answer from here
   *  instead of refusing. The host supplies the lookup and never decides which
   *  tools want it. */
  recordings?: {
    has: (tool: string) => boolean;
    lookup: (
      tool: string,
      args: Record<string, unknown>,
    ) => string | undefined;
  };
}

export async function loadTenantTools(
  tenantDir: string,
  cfg: TenantToolConfig,
): Promise<EcosystemTool[]> {
  const entry = join(tenantDir, "lib", "tools", "index.js");
  if (!existsSync(entry)) return [];
  const module = (await import(pathToFileURL(entry).href)) as {
    buildTools?: (cfg: {
      stateRoot: string;
      env: Record<string, string | undefined>;
      asOf?: Date;
      variant: string;
      pit?: { markUnavailable: (tool: string, reason: string) => void };
      calendar?: { weekdaysOnly: boolean; closed: string[] };
      recordings?: {
        has: (tool: string) => boolean;
        lookup: (
          tool: string,
          args: Record<string, unknown>,
        ) => string | undefined;
      };
    }) => EcosystemTool[];
  };
  if (typeof module.buildTools !== "function") return [];
  return module.buildTools({
    stateRoot: cfg.stateRoot,
    env: cfg.env,
    variant: cfg.variant,
    ...(cfg.asOf === undefined ? {} : { asOf: cfg.asOf }),
    ...(cfg.pit === undefined ? {} : { pit: cfg.pit }),
    ...(cfg.calendar === undefined ? {} : { calendar: cfg.calendar }),
    ...(cfg.recordings === undefined ? {} : { recordings: cfg.recordings }),
  });
}

/**
 * The tool names this environment cannot serve, from the tenant's own
 * VOCABULARY: every entry whose `requiresEnv` key is unset.
 *
 * `buildTools` builds every tool regardless — each one throws when CALLED with
 * its key missing — so a misconfigured machine looks identical to a quiet
 * market until a role tries. On the day OW_UW_API_KEY was absent the designer
 * would have returned an empty proposal list and the report would have read
 * like a considered "no trades today". This is what makes the gap say its own
 * name, at the top of the report, before anything is reasoned about.
 */
export async function tenantToolGaps(
  tenantDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const entry = join(tenantDir, "lib", "tools", "index.js");
  if (!existsSync(entry)) return [];
  const module = (await import(pathToFileURL(entry).href)) as {
    VOCABULARY?: Map<string, { requiresEnv?: string }>;
  };
  if (!(module.VOCABULARY instanceof Map)) return [];
  return [...module.VOCABULARY.entries()]
    .filter(
      ([, spec]) => spec.requiresEnv !== undefined && !env[spec.requiresEnv],
    )
    .map(([name, spec]) => `${name} (${spec.requiresEnv ?? ""} unset)`);
}

/**
 * A tenant's own gates: `<tenant>/gates/<id>.ts`, built to `lib/gates/<id>.js`,
 * `export default` a `Gate`. They live with the tenant and not in core because
 * a gate encodes domain rules — doctrine 2 keeps those out of the harness.
 *
 * A broken gate is a SKIP with a reason, like a broken provider. It is not
 * silently treated as passing: the caller reports the skip in the run output,
 * so a gate that stopped loading cannot quietly stop guarding.
 */
export async function loadGates(
  tenantDir: string,
): Promise<{ gates: Gate[]; skipped: Skipped[] }> {
  const gates: Gate[] = [];
  const skipped: Skipped[] = [];
  const dir = join(tenantDir, "lib", "gates");
  if (!existsSync(dir)) return { gates, skipped };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  for (const file of files) {
    const id = file.replace(/\.js$/, "");
    try {
      const module = (await import(pathToFileURL(join(dir, file)).href)) as {
        default?: Gate;
      };
      const gate = module.default;
      if (gate === undefined || typeof gate.check !== "function") {
        skipped.push({ id, reason: "default export is not a Gate" });
        continue;
      }
      gates.push(gate);
    } catch (error: unknown) {
      skipped.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { gates, skipped };
}

/**
 * A tenant's own renderer: `<tenant>/render/index.ts`, built to
 * `lib/render/index.js`, `export default` a `TenantRenderer`.
 *
 * Optional by construction. A tenant that ships none gets the runner's generic
 * transcript, which is what every tenant got before this existed. A renderer
 * that throws on import is a SKIP with a reason, exactly like a gate: the run
 * still delivers, in the plain form, and the reason travels in the report
 * rather than into a silence.
 */
export async function loadRenderer(
  tenantDir: string,
): Promise<{ renderer: TenantRenderer | null; skipped: Skipped[] }> {
  const entry = join(tenantDir, "lib", "render", "index.js");
  if (!existsSync(entry)) return { renderer: null, skipped: [] };
  try {
    const module = (await import(pathToFileURL(entry).href)) as {
      default?: TenantRenderer;
    };
    if (typeof module.default !== "function") {
      return {
        renderer: null,
        skipped: [
          { id: "render", reason: "default export is not a render function" },
        ],
      };
    }
    return { renderer: module.default, skipped: [] };
  } catch (error: unknown) {
    return {
      renderer: null,
      skipped: [
        {
          id: "render",
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/**
 * Every `plugins/delivery-*` whose built `lib/channel.js` default-exports a
 * `Channel`. Discovery only; whether anything is ever SENT is decided by the
 * tenant's own `delivery:` block and the operator brake, in the runner.
 */
export async function discoverChannels(
  pluginsDir: string,
): Promise<{ channels: Channel[]; skipped: Skipped[] }> {
  const channels: Channel[] = [];
  const skipped: Skipped[] = [];
  if (!existsSync(pluginsDir)) return { channels, skipped };
  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        entry.name.startsWith("delivery-"),
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const entry = join(pluginsDir, name, "lib", "channel.js");
    if (!existsSync(entry)) {
      skipped.push({ id: name, reason: "no built lib/channel.js" });
      continue;
    }
    try {
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: Channel;
      };
      const channel = module.default;
      if (channel === undefined || typeof channel.deliver !== "function") {
        skipped.push({ id: name, reason: "default export is not a Channel" });
        continue;
      }
      channels.push(channel);
    } catch (error: unknown) {
      skipped.push({
        id: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { channels, skipped };
}
