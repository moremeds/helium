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
 * apex screener/backtest compute paths, fail-closed by default. apex's
 * local dev service (127.0.0.1:8322) was not reachable from this laptop
 * while this task ran (`curl` to /openapi.json and /health both returned no
 * connection, `lsof -iTCP:8322` showed nothing listening, 2026-08-24) — not
 * tunneled per the brief, since 8322 is a local-dev port, not the remote
 * macmini case `ssh -L` applies to. Verified instead by reading the route
 * decorators directly in the apex source (~/projects/apex,
 * src/api/routes/{screener,backtest}.py): `APIRouter(prefix="/screener")`
 * with `@router.post("/momentum", status_code=202)` and
 * `@router.post("/pead", status_code=202)`, and `APIRouter(prefix="/backtest")`
 * with `@router.post("/run", status_code=202)`; `server.py`'s
 * `create_app()` mounts every router with no additional prefix, matching
 * "root-mounted, no /api prefix". All three are literal (non-templated)
 * paths, so postTool()'s exact-match design can express them.
 */
export const APEX_COMPUTE_PATHS: readonly string[] = [
  "/screener/momentum",
  "/screener/pead",
  "/backtest/run",
];

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
