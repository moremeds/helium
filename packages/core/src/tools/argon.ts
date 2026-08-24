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
  // An encoded slash is the one character the pathname-equality gate below
  // cannot police: the WHATWG parser leaves "%2f" alone in .pathname, but
  // argon's Starlette router DECODES it into a real separator (verified
  // read-only on the mini, argon 0.12.16: GET /api%2fhealth -> 200, same
  // response as /api/health). That makes the path we check and the path the
  // server routes disagree — precisely what the equality gate exists to
  // prevent — so refuse it outright rather than reasoning per-route.
  if (/%2f/i.test(path))
    throw new Error(
      `path "${path}" contains an encoded slash ("%2f"), which the upstream server decodes into a path separator -- refused as a likely path-traversal escape`,
    );
  const baseOrigin = new URL(base).origin;
  const url = new URL(base.replace(/\/$/, "") + path);
  // The URL parser silently rewrites the path via RFC 3986 dot-segment
  // removal ("." and ".." segments collapse) -- and that collapse applies
  // just as much to a PERCENT-ENCODED ".." ("%2e%2e", any case) as to a
  // literal one: new URL("http://h/api/stock/%2e%2e/%2e%2e/api/admin/x")
  // .pathname === "/api/admin/x" (verified live). A raw-string substring
  // check for a literal ".." can be defeated by encoding it, so it isn't a
  // sound guard on its own. Requiring the parsed pathname to come back
  // byte-identical to the requested path turns "the path that is checked is
  // the path that is sent" into a structural guarantee instead of a
  // blocklist an attacker can out-encode -- reject instead of trusting the
  // parser's normalization to be safe.
  if (url.pathname !== path) {
    throw new Error(
      `path "${path}" resolves to a different path ("${url.pathname}") once parsed -- refused as a likely path-traversal escape`,
    );
  }
  // Defense in depth: a path starting with "/" concatenated onto `base`
  // should never be able to change the origin, but confirm it structurally
  // rather than assuming it.
  if (url.origin !== baseOrigin) {
    throw new Error(
      `path "${path}" escapes the configured base origin ("${baseOrigin}" -> "${url.origin}") -- refused`,
    );
  }
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/** Matches ThesisStore's own 64 KiB cap (spec §7) — one size budget for anything this toolkit hands back to the agent. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

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
  const rawText = await res.text();
  const rawBytes = Buffer.from(rawText, "utf8");
  const truncated = rawBytes.byteLength > MAX_RESPONSE_BYTES;
  const text = truncated
    ? rawBytes.subarray(0, MAX_RESPONSE_BYTES).toString("utf8")
    : rawText;
  let body: unknown;
  try {
    // A truncated body is cut mid-structure by construction; parsing it as
    // JSON would either throw (falling through to the raw-string branch
    // below anyway) or, worse, succeed on a coincidentally-valid prefix.
    // Skip the attempt and always hand back the capped text directly.
    body = truncated ? text : JSON.parse(text);
  } catch {
    body = text;
  }
  return JSON.stringify({ status: res.status, url, body, truncated });
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
      // Traversal/encoding escapes (literal ".." or its percent-encoded
      // form, a double slash, ...) are caught structurally inside buildUrl()
      // below, not here -- see its own comment for why a raw-string check on
      // the prefix-matched path can't be a sound guard on its own.
      if (!path.startsWith("/")) {
        throw new Error(`${name}: path must start with "/", got: ${path}`);
      }
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
        "/api/gold/, /api/regime, /api/health, /api/stock/. Returns {status, url, body, " +
        "truncated}; body is cut to 64 KiB with truncated: true when the response is larger.",
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
