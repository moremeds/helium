/**
 * The full ecosystem toolkit: argon + apex HTTP tools, livewire SQL, and the
 * thesis read/write pair. One buildTools() call is the single source both
 * exposure surfaces (in-process dsh registration, MCP stdio) filter down
 * from.
 * @module @helium/core/tools
 */
import { apexTools } from "./apex.js";
import { argonTools } from "./argon.js";
import { livewireTools } from "./livewire.js";
import { thesisTools } from "./thesis.js";
import type { EcosystemTool } from "./types.js";

export * from "./types.js";
export {
  ARGON_AI_ANALYSIS_PATHS,
  ARGON_READ_PREFIXES,
  ARGON_RESCAN_PATHS,
  argonTools,
} from "./argon.js";
export { APEX_COMPUTE_PATHS, APEX_READ_PREFIXES, apexTools } from "./apex.js";
export { isSelectOnly, livewireTools } from "./livewire.js";
export { thesisTools } from "./thesis.js";

export function buildTools(cfg: {
  argonBase: string;
  apexBase: string;
  livewireDb?: string;
  stateRoot: string;
}): EcosystemTool[] {
  return [
    ...argonTools(cfg.argonBase),
    ...apexTools(cfg.apexBase),
    ...livewireTools(cfg.livewireDb),
    ...thesisTools(cfg.stateRoot),
  ];
}
