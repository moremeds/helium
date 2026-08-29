/**
 * `@helium/v1-compat` — everything the v1 production path knows that core may
 * not: the v1 job contract and the concrete domain toolkits.
 *
 * Core stays model-blind and domain-blind; this package is where v1's provider
 * and business vocabulary is allowed to live, so that removing it later
 * removes a package rather than editing core.
 * @module @helium/v1-compat
 */
export * from "./job.js";
export * from "./tools/index.js";
