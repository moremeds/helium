/**
 * Pure tool selection for an MCP stdio server, split out of the server module
 * so it is importable and unit-testable without that module's own top-level
 * side effect (connecting a real StdioServerTransport on import).
 *
 * The catalog is **injected**, not built here. Building a tool means knowing a
 * concrete business domain, and core may not; what stays here is the generic
 * policy — mutation filter before name filter, fail-closed — plus the
 * degradation report.
 * @module @helium/core/mcp/selection
 */
import type { EcosystemTool, ToolVocabularyEntry } from "../tools/index.js";

/** The subset of process.env selected() reads. Both keys are domain-neutral. */
export interface SelectionEnv {
  HELIUM_ALLOW_MUTATIONS?: string;
  HELIUM_TOOLS?: string;
}

/**
 * What this process can serve, supplied by the caller that knows the domains.
 *
 * `tools` is what this configuration actually built; `vocabulary` is every
 * name the BUILD knows about, configured here or not. They are deliberately
 * different sets: a tool whose backing store is unconfigured on this host is a
 * real, known name that is simply absent from this process's catalog, and
 * reporting it as an unknown name would be wrong.
 */
export interface ToolCatalog {
  tools: EcosystemTool[];
  vocabulary: ReadonlyMap<string, ToolVocabularyEntry>;
}

/** One capability the tenant declared that this process cannot serve. */
export interface ToolDegradation {
  tool: string;
  /** Named, never a bare boolean: the health row has to say which and why. */
  reason: string;
}

export interface Selection {
  tools: EcosystemTool[];
  degraded: ToolDegradation[];
}

/**
 * Tool set for the running server, filtered by env: HELIUM_TOOLS (csv
 * allow-list; empty/unset means "all") and HELIUM_ALLOW_MUTATIONS ('1'
 * admits mutating tools; otherwise they are dropped, matching the in-process
 * registration's own always-read-only default). The mutation filter runs
 * before the name filter, so naming a mutating tool in HELIUM_TOOLS without
 * also setting HELIUM_ALLOW_MUTATIONS=1 still drops it -- fail-closed even
 * under an explicit allow-list.
 *
 * **This function never throws, and that is a hard requirement rather than a
 * style preference.** The server module calls it at module top level, so any
 * throw here happens during module initialization: the MCP server never starts
 * and the senior lane loses EVERY tool instead of one capability. The
 * fail-loud half of the tool contract therefore lives in the job-load
 * validator, which runs in the daemon, before this process is ever spawned.
 *
 * A declared name that is missing from the built catalog is reported in
 * `degraded` with a named reason and omitted from `tools`. The shipped tenant
 * shape is exactly this case: it declares a capability whose backing store is
 * unconfigured on the host, and the server must still start carrying the rest.
 */
export function selected(
  catalog: ToolCatalog,
  env: SelectionEnv = process.env,
): Selection {
  const allowMutations = env.HELIUM_ALLOW_MUTATIONS === "1";
  const declared = env.HELIUM_TOOLS;
  const names = (declared ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const built = new Set(catalog.tools.map((t) => t.name));

  // Only names genuinely ABSENT from the built catalog are degradations.
  // A name dropped by the MUTATION filter is not one: the catalog carries
  // mutating tools regardless, so such a name is in `built` and simply does
  // not survive the filter below. That is policy working as designed, not a
  // configuration gap, and it must not show up as degraded health.
  const degraded: ToolDegradation[] = names
    .filter((name) => !built.has(name))
    .map((name) => {
      const entry = catalog.vocabulary.get(name);
      if (entry === undefined) {
        // Should be unreachable: job-load validation rejects unknown names.
        // Reported rather than thrown so that a config which reaches this
        // process by some other route still starts.
        return { tool: name, reason: "unknown tool name" };
      }
      return {
        tool: name,
        reason:
          entry.requiresEnv === undefined
            ? "unconfigured"
            : `unconfigured: ${entry.requiresEnv}`,
      };
    });

  return {
    tools: catalog.tools
      .filter((t) => allowMutations || !t.mutating)
      // UNSET means "no allow-list configured" (dev, ops) and serves the
      // catalog. An EMPTY STRING is a real, explicit allow-list of nothing: a
      // role that declares `tools: []` must reach no tool at all. Fail closed.
      .filter((t) => declared === undefined || names.includes(t.name)),
    degraded,
  };
}
