import { curlPostJson } from "./curl.js";

/**
 * Liveness for a provider that speaks HTTP, done the one way that tells a
 * NETWORK fault from a CREDENTIAL fault: send the endpoint a request with no
 * credentials at all and read the status.
 *
 * A vendor that can see us answers 401 — it evaluated auth and found none. A
 * vendor whose edge refuses our egress answers 403 before auth is evaluated,
 * and no token would have changed it. Reporting that as an auth failure is
 * what hid a months-long production outage (design §3.1), so the two are told
 * apart here rather than guessed at from an error string.
 * @module @helium/provider-sdk/probe
 */
export type EgressVerdict =
  | { reachable: true }
  | { reachable: false; reason: string };

export async function probeEgress(input: {
  url: string;
  headers: Record<string, string>;
  proxy?: string;
  timeoutMs?: number;
}): Promise<EgressVerdict> {
  const res = await curlPostJson({
    url: input.url,
    headers: { "content-type": "application/json", ...input.headers },
    body: "{}",
    timeoutMs: input.timeoutMs ?? 10_000,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
  });
  if (res.terminal !== undefined) {
    return {
      reachable: false,
      reason: `${input.url} unreachable (${res.terminal}${res.error === undefined ? "" : `: ${res.error}`})`,
    };
  }
  if (res.status === 403) {
    return {
      reachable: false,
      reason: `${input.url} answered 403 to an unauthenticated request: this egress is blocked, not unauthorised — set HELIUM_PROXY`,
    };
  }
  // 401 is the healthy answer. Anything else that is not 403 still proves the
  // edge let us through, which is all this probe claims.
  return { reachable: true };
}
