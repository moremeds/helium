/**
 * apex (signals/chart data, REST 127.0.0.1:8322, root-mounted, no /api
 * prefix) HTTP tools: a read-only GET tool plus a fail-closed compute POST.
 * @module @helium/core/tools/apex
 */
import type { EcosystemTool } from "@helium/core";
import { postTool, readTool } from "./argon.js";

/**
 * Verified apex routes. Read-only surface. `/screener/results/` and
 * `/backtest/results/` (added 2026-08-24) read back a run's result by
 * run_id. `/screener/results/` closes the loop with apex_compute's screener
 * routes; `/backtest/results/` is included too even though apex_compute has
 * no `/backtest/run` route (its real body can't be expressed by this
 * allow-list, see APEX_COMPUTE_PATHS below) -- a backtest run started some
 * other way is still a legitimate read for this agent to make.
 */
export const APEX_READ_PREFIXES = [
  "/health",
  "/v1/",
  "/screener/results/",
  "/backtest/results/",
] as const;

/**
 * apex screener compute paths, fail-closed by default. apex's local dev
 * service (127.0.0.1:8322) was not reachable from this laptop while this
 * task ran (`curl` to /openapi.json and /health both returned no
 * connection, `lsof -iTCP:8322` showed nothing listening, 2026-08-24) — not
 * tunneled per the brief, since 8322 is a local-dev port, not the remote
 * macmini case `ssh -L` applies to. Verified instead by reading the route
 * decorators directly in the apex source (~/projects/apex,
 * src/api/routes/{screener,backtest}.py): `APIRouter(prefix="/screener")`
 * with `@router.post("/momentum", status_code=202)` and
 * `@router.post("/pead", status_code=202)`, and `APIRouter(prefix="/backtest")`
 * with `@router.post("/run", status_code=202)`; `server.py`'s
 * `create_app()` mounts every router with no additional prefix, matching
 * "root-mounted, no /api prefix". Both screener paths are literal
 * (non-templated) and bodyless, so postTool()'s exact-match design can
 * express them.
 *
 * `/backtest/run` is deliberately NOT included: apex's real route requires
 * a JSON request body with no defaults (confirmed 422 on a bodyless POST),
 * and postTool()'s body map only supports a fixed per-route literal body
 * (see argon.ts's `argon_rescan` for that shape) — a backtest body carries
 * caller-chosen parameters (universe, date range, ...), which a fixed
 * literal can't represent. macro v1 has no use for backtest, so the
 * fail-closed choice is to leave it off the allow-list entirely rather than
 * grow postTool() to accept caller-supplied bodies.
 */
export const APEX_COMPUTE_PATHS: readonly string[] = [
  "/screener/momentum",
  "/screener/pead",
];

export function apexTools(apexBase: string): EcosystemTool[] {
  return [
    readTool(
      "apex_api",
      "GET a read-only apex route. Allowed prefixes: /health, /v1/, /screener/results/, " +
        "/backtest/results/. Returns {status, url, body, truncated}; body is cut to 64 KiB " +
        "with truncated: true when the response is larger.",
      apexBase,
      APEX_READ_PREFIXES,
    ),
    postTool(
      "apex_compute",
      "POST-to-enqueue screener compute (momentum/pead). No backtest route: apex's real " +
        "/backtest/run needs a caller-supplied body this fixed allow-list can't express. " +
        "Mutates no domain state but is expensive — do not call more than once per analysis.",
      apexBase,
      APEX_COMPUTE_PATHS,
      false,
    ),
  ];
}
