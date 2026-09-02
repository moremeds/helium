/**
 * Egress proxy, applied in code rather than at the command line.
 *
 * Node's `fetch` ignores `HTTPS_PROXY` unless the process was started with
 * `--use-env-proxy`. That made the proxy a property of how helium is LAUNCHED,
 * which is exactly the class of difference that hid a months-long production
 * failure once already (design §3.1): the laptop's shell had the flag, the
 * mini's launchd job did not, and providers 403'd with nobody the wiser.
 *
 * `setGlobalDispatcher` from the installed undici reaches the `fetch` built
 * into node: both halves store the dispatcher under the same versioned global
 * symbol. So one call at startup covers every bare `fetch` in the tree —
 * pi-ai's included — and the flag stops being load-bearing.
 * @module @helium/cli/proxy
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";

/**
 * @returns the proxy url that was applied, or undefined when none is set.
 */
export function applyProxy(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.HELIUM_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy;
  if (url === undefined || url.trim() === "") return undefined;
  setGlobalDispatcher(new ProxyAgent(url));
  return url;
}
