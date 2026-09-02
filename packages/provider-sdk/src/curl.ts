import { spawn } from "node:child_process";

/**
 * Both subscription APIs sit behind bot management that fingerprints the TLS
 * ClientHello. Verified 2026-09-02 from one machine, one token, one set of
 * headers: `curl` gets 200, Node's `fetch` and `node:https` get 403 with an
 * HTML challenge. Cipher reordering does not reach it — JA3 also covers the
 * extension and curve ordering, which Node's TLS API does not expose.
 *
 * So HTTP for these providers is spoken by curl. It is a spawn, but a ~10ms one
 * that carries only our prompt — unlike the vendor CLIs it replaces, which
 * prepend their own agent preamble (18,241 tokens for a five-token prompt).
 */
export interface CurlRequest {
  url: string;
  headers: Record<string, string>;
  /**
   * Headers whose value is a secret. Passed to curl as an environment variable
   * and expanded by curl itself, so the token never appears in argv where any
   * local `ps` would show it. Requires curl >= 8.3 (`--variable`/`--expand-*`);
   * macOS 15 ships 8.7.
   */
  secretHeaders?: Record<string, { prefix: string; value: string }>;
  body: string;
  timeoutMs: number;
  /** Explicit egress proxy. Never inherited: see design §3.1. */
  proxy?: string;
  signal?: AbortSignal;
}

export interface CurlResponse {
  status: number;
  body: string;
  /** Set instead of `status` when the request never completed. */
  terminal?: "timeout" | "cancelled" | "transport";
  error?: string;
}

const STATUS_MARK = "\nHELIUM_STATUS:";

/**
 * curl is spawned with an env that has no PATH, so the kernel resolves the name
 * against the default `/usr/bin:/bin`. That is what we want in production — the
 * system curl, never one a caller placed earlier on PATH — so substituting a
 * binary takes an explicit name. Read per call, not cached, so a test can set
 * it around one invocation.
 */
function curlBin(): string {
  return process.env.HELIUM_CURL_BIN ?? "curl";
}

export async function curlPostJson(req: CurlRequest): Promise<CurlResponse> {
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    String(Math.ceil(req.timeoutMs / 1000)),
    // Status is appended after the body behind a marker; we split on its LAST
    // occurrence, so a body that happens to contain the same text is harmless.
    "--write-out",
    `${STATUS_MARK}%{http_code}`,
    "--request",
    "POST",
    "--data-binary",
    "@-",
  ];
  if (req.proxy !== undefined) args.push("--proxy", req.proxy);
  for (const [k, v] of Object.entries(req.headers))
    args.push("--header", `${k}: ${v}`);

  // Secrets go through the environment and are expanded by curl, so no token
  // ever lands in argv where a local `ps` would read it.
  const secretEnv: Record<string, string> = {};
  let n = 0;
  for (const [header, { prefix, value }] of Object.entries(
    req.secretHeaders ?? {},
  )) {
    const name = `HELIUM_SECRET_${String(n++)}`;
    secretEnv[name] = value;
    args.push(
      "--variable",
      `%${name}`,
      "--expand-header",
      `${header}: ${prefix}{{${name}}}`,
    );
  }
  args.push(req.url);

  return await new Promise<CurlResponse>((resolve) => {
    // The env carries the secret-header variables and nothing else. An ambient
    // http_proxy/https_proxy would otherwise silently override the proxy the
    // caller declared — which is how the mini ran unproxied for months while
    // the laptop appeared to work, because its shell happened to export one.
    const child = spawn(curlBin(), args, {
      env: secretEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let terminal: "timeout" | "cancelled" | undefined;
    let settled = false;

    const finish = (r: CurlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => {
      terminal = "cancelled";
      child.kill("SIGKILL");
    };
    // curl's own --max-time is the primary deadline; this is the backstop for a
    // curl that never exits.
    const timer = setTimeout(() => {
      terminal = "timeout";
      child.kill("SIGKILL");
    }, req.timeoutMs + 2_000);
    timer.unref();

    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) =>
      finish({ status: 0, body: "", terminal: "transport", error: e.message }),
    );
    child.on("close", () => {
      if (terminal !== undefined) {
        finish({ status: 0, body: out, terminal });
        return;
      }
      const at = out.lastIndexOf(STATUS_MARK);
      if (at === -1) {
        finish({
          status: 0,
          body: out,
          terminal: "transport",
          error: err.trim() || "curl produced no status",
        });
        return;
      }
      // curl reports 000 when it never got an HTTP response at all (DNS,
      // refused connection, TLS). That is a transport failure, not a status.
      const status = Number.parseInt(out.slice(at + STATUS_MARK.length), 10);
      if (!Number.isFinite(status) || status === 0) {
        finish({
          status: 0,
          body: out.slice(0, at),
          terminal: "transport",
          error: err.trim() || "curl reported no HTTP status",
        });
        return;
      }
      finish({ status, body: out.slice(0, at) });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(req.body);
  });
}
