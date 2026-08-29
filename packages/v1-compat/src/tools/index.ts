/**
 * The v1 ecosystem toolkit: the two HTTP toolkits, the SQL lake tool, and the
 * thesis read/write pair core owns. One `buildTools()` call is the single
 * source both exposure surfaces (in-process registration, MCP stdio) filter
 * down from.
 *
 * This aggregate lives in the compatibility package rather than in core
 * because constructing it means naming business domains, which acceptance
 * criterion 14 bans from `@helium/core`.
 * @module @helium/v1-compat/tools
 */
import {
  thesisTools,
  type EcosystemTool,
  type ToolCatalog,
  type ToolVocabularyEntry,
} from "@helium/core";
import { apexTools } from "./apex.js";
import { argonTools } from "./argon.js";
import { livewireTools } from "./livewire.js";

export {
  ARGON_AI_ANALYSIS_PATHS,
  ARGON_READ_PREFIXES,
  ARGON_RESCAN_PATHS,
  argonTools,
} from "./argon.js";
export { APEX_COMPUTE_PATHS, APEX_READ_PREFIXES, apexTools } from "./apex.js";
export {
  hasDeniedTableFunction,
  isSelectOnly,
  livewireTools,
} from "./livewire.js";

/**
 * The env var a vocabulary name needs before it appears in the built catalog.
 * Only the lake tool has one today: `livewireTools()` returns `[]` with no
 * lake configured, so `livewire_sql` is a real, known name that is simply
 * absent from this process's catalog.
 */
const REQUIRES_ENV: Readonly<Record<string, string>> = {
  livewire_sql: "HELIUM_LIVEWIRE_DB",
};

/**
 * Every tool name this BUILD knows about, independent of which are configured
 * in the running environment. This is the vocabulary a job's declared `tools`
 * are validated against, and it is deliberately not the same thing as the
 * catalog `buildTools()` returns for a given config: `livewire_sql` is in the
 * vocabulary always, but in the catalog only when a lake is configured.
 * Checking a job against the catalog instead would reject the shipped
 * `macro-watch` job as a typo on any host without `HELIUM_LIVEWIRE_DB`.
 *
 * Derived from `buildTools()` rather than hand-listed so a new tool cannot
 * enter the build without entering the vocabulary. The probe config is inert:
 * every `*Tools()` factory is a pure descriptor builder (`ThesisStore`'s
 * constructor only stores its path), so nothing here touches the network or
 * the filesystem at import time.
 */
export const TOOL_VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> =
  new Map(
    buildTools({
      argonBase: "http://tool-vocabulary.invalid",
      apexBase: "http://tool-vocabulary.invalid",
      livewireDb: "/tool-vocabulary.invalid",
      stateRoot: "/tool-vocabulary.invalid",
    }).map((t) => [
      t.name,
      REQUIRES_ENV[t.name] === undefined
        ? { mutating: t.mutating }
        : { mutating: t.mutating, requiresEnv: REQUIRES_ENV[t.name] },
    ]),
  );

/**
 * Job-load validation of a declared tool list. Throws — loudly, by design —
 * and is called from `parseJobYaml()`, which runs long before any MCP server
 * process is spawned. It must never be called from `selected()`: the server
 * module invokes that at module top level, so a throw there takes the whole
 * server down and costs the senior lane every tool rather than one capability.
 *
 * @param names - the job's declared tool names.
 * @param opts - `allowMutations` as the job declared it.
 * @throws when a name is not in {@link TOOL_VOCABULARY}, or when a mutating
 * tool is declared by a job that does not permit mutation.
 */
export function validateToolSelection(
  names: string[],
  opts: { allowMutations: boolean },
): void {
  const unknown = names.filter((name) => !TOOL_VOCABULARY.has(name));
  if (unknown.length > 0) {
    throw new Error(`unknown tools: ${unknown.join(", ")}`);
  }
  const forbidden = names.filter(
    (name) => TOOL_VOCABULARY.get(name)?.mutating && !opts.allowMutations,
  );
  if (forbidden.length > 0) {
    throw new Error(
      `tools require mutation permission: ${forbidden.join(", ")}`,
    );
  }
}

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

/** The env keys the v1 catalog is built from. All three name a domain. */
export interface CatalogEnv {
  HELIUM_ARGON_BASE?: string;
  HELIUM_APEX_BASE?: string;
  HELIUM_LIVEWIRE_DB?: string;
  HELIUM_STATE_ROOT?: string;
}

/**
 * Build the catalog core's `selected()` filters. Exported separately from the
 * server module so the env-to-catalog step is unit-testable without importing
 * that module's top-level transport connection.
 */
export function catalogFromEnv(env: CatalogEnv = process.env): ToolCatalog {
  return {
    tools: buildTools({
      argonBase: env.HELIUM_ARGON_BASE ?? "http://127.0.0.1:8400",
      apexBase: env.HELIUM_APEX_BASE ?? "http://127.0.0.1:8322",
      livewireDb: env.HELIUM_LIVEWIRE_DB,
      stateRoot: env.HELIUM_STATE_ROOT ?? process.cwd(),
    }),
    vocabulary: TOOL_VOCABULARY,
  };
}
