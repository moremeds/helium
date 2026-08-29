/**
 * Pure env-driven tool selection for helium-mcp, split out of server.ts so
 * it is importable and unit-testable without server.ts's own top-level side
 * effect (connecting a real StdioServerTransport on import).
 * @module @helium/core/mcp/selection
 */
import { buildTools, TOOL_VOCABULARY } from "../tools/index.js";
import type { EcosystemTool } from "../tools/index.js";

/** The subset of process.env selected() reads. */
export interface SelectionEnv {
  HELIUM_ARGON_BASE?: string;
  HELIUM_APEX_BASE?: string;
  HELIUM_LIVEWIRE_DB?: string;
  HELIUM_STATE_ROOT?: string;
  HELIUM_ALLOW_MUTATIONS?: string;
  HELIUM_TOOLS?: string;
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
 * admits mutating tools; otherwise they are dropped, matching the dsh
 * in-process registration's own always-read-only default). The mutation
 * filter runs before the name filter, so naming a mutating tool in
 * HELIUM_TOOLS without also setting HELIUM_ALLOW_MUTATIONS=1 still drops it
 * -- fail-closed even under an explicit allow-list.
 *
 * **This function never throws, and that is a hard requirement rather than a
 * style preference.** `mcp/server.ts` calls it at module top level, so any
 * throw here happens during module initialization: the MCP server never
 * starts and the senior lane loses EVERY tool instead of one capability. The
 * fail-loud half of the tool contract therefore lives in
 * `validateToolSelection()`, which runs at job load, in the daemon, before
 * this process is ever spawned.
 *
 * A declared name that is missing from the built catalog is reported in
 * `degraded` with a named reason and omitted from `tools`. The shipped
 * `macro-watch` shape is exactly this case: it declares `livewire_sql` on a
 * host with no `HELIUM_LIVEWIRE_DB`, and it must still start a server
 * carrying the other four tools.
 */
export function selected(env: SelectionEnv = process.env): Selection {
  const tools = buildTools({
    argonBase: env.HELIUM_ARGON_BASE ?? "http://127.0.0.1:8400",
    apexBase: env.HELIUM_APEX_BASE ?? "http://127.0.0.1:8322",
    livewireDb: env.HELIUM_LIVEWIRE_DB,
    stateRoot: env.HELIUM_STATE_ROOT ?? process.cwd(),
  });
  const allowMutations = env.HELIUM_ALLOW_MUTATIONS === "1";
  const names = (env.HELIUM_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const built = new Set(tools.map((t) => t.name));

  // Only names genuinely ABSENT from the built catalog are degradations.
  // A name dropped by the MUTATION filter is not one: `buildTools()` returns
  // mutating tools regardless, so `argon_rescan` is in `built` and simply does
  // not survive the filter below. That is policy working as designed, not a
  // configuration gap, and it must not show up as degraded health.
  const degraded: ToolDegradation[] = names
    .filter((name) => !built.has(name))
    .map((name) => {
      const entry = TOOL_VOCABULARY.get(name);
      if (entry === undefined) {
        // Should be unreachable: validateToolSelection() rejects unknown names
        // at job load. Reported rather than thrown so that a config which
        // reaches this process by some other route still starts.
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
    tools: tools
      .filter((t) => allowMutations || !t.mutating)
      .filter((t) => names.length === 0 || names.includes(t.name)),
    degraded,
  };
}
