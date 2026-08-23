/**
 * Pure env-driven tool selection for helium-mcp, split out of server.ts so
 * it is importable and unit-testable without server.ts's own top-level side
 * effect (connecting a real StdioServerTransport on import).
 * @module @helium/core/mcp/selection
 */
import { buildTools } from "../tools/index.js";
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

/**
 * Tool set for the running server, filtered by env: HELIUM_TOOLS (csv
 * allow-list; empty/unset means "all") and HELIUM_ALLOW_MUTATIONS ('1'
 * admits mutating tools; otherwise they are dropped, matching the dsh
 * in-process registration's own always-read-only default). The mutation
 * filter runs before the name filter, so naming a mutating tool in
 * HELIUM_TOOLS without also setting HELIUM_ALLOW_MUTATIONS=1 still drops it
 * -- fail-closed even under an explicit allow-list.
 */
export function selected(env: SelectionEnv = process.env): EcosystemTool[] {
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
  return tools
    .filter((t) => allowMutations || !t.mutating)
    .filter((t) => names.length === 0 || names.includes(t.name));
}
