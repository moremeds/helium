/**
 * The domain-neutral half of the tool surface: the `EcosystemTool` contract
 * and the thesis read/write pair, which is helium's own state and belongs to
 * no business domain.
 *
 * The concrete domain toolkits and the `buildTools()` aggregate that
 * constructs them live in the host (`plugins/helium`). Constructing a tool means
 * knowing a business domain, and acceptance criterion 14 bans that knowledge
 * from core.
 * @module @helium/core/tools
 */
export * from "./types.js";
export { thesisTools } from "./thesis.js";
