/**
 * argon (macro/rates, REST 127.0.0.1:8400) HTTP tools: a read-only GET tool
 * plus two fail-closed mutating POST tools.
 * @module @helium/core/tools/argon
 */
import { z } from "zod";
import type { EcosystemTool, ToolRunContext } from "./types.js";

/** Verified argon routes (2026-08-23). Read-only surface. */
export const ARGON_READ_PREFIXES = [
  "/api/macro/",
  "/api/rates/snapshot",
  "/api/gold/",
  "/api/regime",
  "/api/health",
  "/api/stock/",
] as const;

/**
 * Mutating argon routes, fail-closed. Filled from argon's live
 * `/openapi.json` at 127.0.0.1:8400 (2026-08-24; "UW Watchlist API" 0.12.15):
 * `POST /api/watchlist/rescan-all` is the one literal (non-templated) rescan
 * route — `postTool()` matches by exact path, so it is the only rescan route
 * this allow-list design can express. argon's only ai-analysis route,
 * `POST /api/stock/{ticker}/trade-insights/ai-analysis`, is per-ticker
 * templated; an exact-match allow-list cannot safely name "any ticker"
 * without enumerating every symbol, so `ARGON_AI_ANALYSIS_PATHS` stays empty
 * — fail-closed until the matcher grows templated-path support (Phase 3+).
 */
export const ARGON_RESCAN_PATHS: readonly string[] = [
  "/api/watchlist/rescan-all",
];
export const ARGON_AI_ANALYSIS_PATHS: readonly string[] = [];

const PathParams = z.object({
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
});

export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string>,
): string {
  if (!path.startsWith("/"))
    throw new Error(`path must start with "/", got: ${path}`);
  const url = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export async function call(
  url: string,
  method: "GET" | "POST",
  ctx?: ToolRunContext,
  jsonBody?: unknown,
): Promise<string> {
  const impl = ctx?.fetchImpl ?? fetch;
  const init: RequestInit = { method, signal: AbortSignal.timeout(30_000) };
  if (jsonBody !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(jsonBody);
  }
  const res = await impl(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return JSON.stringify({ status: res.status, url, body });
}

/**
 * Reject a raw path containing a dot-segment ("..") or a double slash ("//")
 * before any allow-list check runs. readTool()'s allow-list check is a
 * prefix match on the RAW path string — e.g. "/api/macro/../../../etc/passwd"
 * starts with the allow-listed "/api/macro/" prefix as a literal string.
 * Only buildUrl()'s `new URL(...)` later collapses ".." segments (RFC 3986
 * dot-segment removal), by which point the outgoing request has silently
 * become "/etc/passwd" — a route the allow-list never approved. Reject
 * before the allow-list check ever runs, rather than trusting URL
 * normalization to be defensive.
 */
function rejectPathTraversal(name: string, path: string): void {
  if (path.includes("..") || path.includes("//")) {
    throw new Error(
      `${name}: "${path}" contains a path-traversal ("..") or double-slash ("//") segment`,
    );
  }
}

/** Shared with apex.ts: a read-only GET tool gated by an allow-listed prefix set. */
export function readTool(
  name: string,
  description: string,
  base: string,
  prefixes: readonly string[],
): EcosystemTool {
  return {
    name,
    description,
    paramsSchema: PathParams,
    mutating: false,
    async run(args, ctx) {
      const { path, query } = PathParams.parse(args);
      // Reject a non-path (e.g. an absolute URL) before the allow-list check,
      // so an escape attempt gets buildUrl's specific diagnostic rather than
      // being folded into the generic "not an allow-listed path" message.
      if (!path.startsWith("/")) {
        throw new Error(`${name}: path must start with "/", got: ${path}`);
      }
      rejectPathTraversal(name, path);
      if (!prefixes.some((p) => path.startsWith(p))) {
        throw new Error(
          `${name}: "${path}" is not an allow-listed read path (${prefixes.join(", ")})`,
        );
      }
      return await call(buildUrl(base, path, query), "GET", ctx);
    },
  };
}

/**
 * Shared with apex.ts: a POST tool gated by an exact-match allow-list.
 * No separate rejectPathTraversal() call here: unlike readTool()'s prefix
 * match, this check is exact-string equality against literal allow-listed
 * paths (none of which contain ".."), so a traversal segment can only ever
 * make `path` fail to equal an allowed entry — it cannot forge a match.
 *
 * `bodies` maps an allow-listed path to the fixed JSON body its real route
 * requires (e.g. argon's `/api/watchlist/rescan-all` 400s without
 * `{"confirmed": true}`). A path with no entry gets no body — only add a
 * route to `allowed` once its real body requirement (none, or a fixed
 * literal one) is known; a route needing a caller-supplied body has no
 * allow-listed entry at all (see apex.ts's `/backtest/run`).
 */
export function postTool(
  name: string,
  description: string,
  base: string,
  allowed: readonly string[],
  mutating: boolean,
  bodies: Readonly<Record<string, unknown>> = {},
): EcosystemTool {
  return {
    name,
    description,
    paramsSchema: PathParams,
    mutating,
    async run(args, ctx) {
      const { path, query } = PathParams.parse(args);
      if (!path.startsWith("/")) {
        throw new Error(`${name}: path must start with "/", got: ${path}`);
      }
      if (!allowed.includes(path)) {
        throw new Error(
          `${name}: "${path}" is not an allow-listed path for this tool`,
        );
      }
      return await call(buildUrl(base, path, query), "POST", ctx, bodies[path]);
    },
  };
}

export function argonTools(argonBase: string): EcosystemTool[] {
  return [
    readTool(
      "argon_api",
      "GET a read-only argon route. Allowed prefixes: /api/macro/, /api/rates/snapshot, " +
        "/api/gold/, /api/regime, /api/health, /api/stock/. Returns {status, url, body}.",
      argonBase,
      ARGON_READ_PREFIXES,
    ),
    postTool(
      "argon_rescan",
      "POST an argon rescan job. Mutating: requires the job's allowMutations flag.",
      argonBase,
      ARGON_RESCAN_PATHS,
      true,
      { "/api/watchlist/rescan-all": { confirmed: true } },
    ),
    postTool(
      "argon_ai_analysis",
      "POST an argon ai-analysis job. Mutating: requires the job's allowMutations flag.",
      argonBase,
      ARGON_AI_ANALYSIS_PATHS,
      true,
    ),
  ];
}
