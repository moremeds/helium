/**
 * `@helium/core` — the single import specifier every downstream package uses.
 *
 * Core owns exactly four things (design §2): tenant discovery, capability
 * routing, sandbox KINDS, and the audit projection. Everything else is either
 * dsh's (sessions, tools, subagents, approval — see `plugins/provider-dsh`) or
 * a plugin's. Core carries no vendor and no business-domain vocabulary;
 * `contracts/tests/core-neutrality.contract.spec.ts` enforces that mechanically.
 * @module @helium/core
 */
export * from "./time.js";
export * from "./tools.js";
export * from "./mcp/selection.js";
export * from "./work.js";
export * from "./execution.js";
export * from "./capabilities.js";
export * from "./router.js";
export * from "./sandbox.js";
export * from "./plugins.js";
export * from "./tenant.js";
export * from "./team.js";
export * from "./audit.js";
export * from "./fold.js";
export * from "./budget.js";
export * from "./config.js";
export * from "./report.js";
