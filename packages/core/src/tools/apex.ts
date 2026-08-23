/**
 * apex (signals/chart data, REST 127.0.0.1:8322, root-mounted, no /api
 * prefix) HTTP tools: a read-only GET tool plus a fail-closed compute POST.
 * @module @helium/core/tools/apex
 */
import type { EcosystemTool } from "./types.js";
import { postTool, readTool } from "./argon.js";

/** Verified apex routes (2026-08-23). Read-only surface. */
export const APEX_READ_PREFIXES = ["/health", "/v1/"] as const;

/**
 * apex screener/backtest compute paths, fail-closed. apex's local dev
 * service (127.0.0.1:8322) was not reachable from this laptop while this
 * task ran (`curl` to /openapi.json and /health both returned no
 * connection, 2026-08-24) — not tunneled per the brief, since 8322 is a
 * local-dev port, not the remote macmini case ssh -L applies to. Left empty
 * (fail-closed, every apex_compute call refused) until a real apex instance
 * is reachable and its POST /v1/... screener/backtest routes are verified.
 */
export const APEX_COMPUTE_PATHS: readonly string[] = [];

export function apexTools(apexBase: string): EcosystemTool[] {
  return [
    readTool(
      "apex_api",
      "GET a read-only apex route. Allowed prefixes: /health, /v1/. Returns {status, url, body}.",
      apexBase,
      APEX_READ_PREFIXES,
    ),
    postTool(
      "apex_compute",
      "POST-to-enqueue compute (screener/backtest). Mutates no domain state but is " +
        "expensive — do not call more than once per analysis.",
      apexBase,
      APEX_COMPUTE_PATHS,
      false,
    ),
  ];
}
