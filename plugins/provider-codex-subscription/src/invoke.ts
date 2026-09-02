import { curlPostJson } from "@helium/provider-sdk/curl";
import type { CodexEffort } from "./catalog.js";

export type CodexClassification =
  "proxy" | "auth" | "timeout" | "cancelled" | "quota-exhausted" | "error";

export interface CodexRuntimeSnapshot {
  requestedModel: string;
  requestedEffort: CodexEffort;
  effectiveEffort: CodexEffort;
  providerReportedEffort?: string;
  usage: { inputTokens?: number; outputTokens?: number };
  events: unknown[];
}

export interface CodexInvocationResult {
  ok: boolean;
  text?: string;
  classification?: CodexClassification;
  retryAfter?: string;
  runtimeSnapshot: CodexRuntimeSnapshot;
}

export interface CodexInvocation {
  model: string;
  effort: CodexEffort;
  prompt: string;
  /** Becomes the Responses API `instructions` field. */
  systemPrompt?: string;
  timeoutMs: number;
  /**
   * The provider's declared environment. One key is read:
   * `CODEX_ACCESS_TOKEN`, the `access_token` from `~/.codex/auth.json`.
   * Nothing is inherited from the ambient process.
   */
  env: Record<string, string>;
  /** Explicit egress proxy; the mini needs one (§3.1). */
  proxy?: string;
  signal?: AbortSignal;
}

/**
 * The ChatGPT subscription backend, not `api.openai.com` — a subscription token
 * is only accepted here. Same endpoint the official CLI uses.
 */
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** The JWT claim that carries the account the subscription bills to. */
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

/**
 * Identifies the caller to OpenAI. Unlike Anthropic's identity string this is
 * not an entitlement check — pi ships `originator: pi` and is served — but the
 * header is required, so we answer honestly rather than impersonate the CLI.
 */
const ORIGINATOR = "helium";

function classify(status: number): CodexClassification {
  if (status === 401) return "auth";
  // 403 here is Cloudflare or geo, never credentials: the token is not even
  // evaluated. See the design §3.1 post-mortem.
  if (status === 403) return "proxy";
  if (status === 429) return "quota-exhausted";
  return "error";
}

function accountIdFrom(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, { chatgpt_account_id?: string } | undefined>;
    return claims[ACCOUNT_CLAIM]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

/**
 * The endpoint only streams, so a complete reply arrives as SSE. We collect
 * rather than surface a stream: every consumer here is a non-interactive run
 * that wants the finished text, and buffering keeps the token accounting in
 * one place.
 */
function collectSse(body: string): {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
  events: unknown[];
  errorMessage?: string;
} {
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let errorMessage: string | undefined;
  const events: unknown[] = [];

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    events.push(event);
    const e = event as {
      type?: string;
      delta?: string;
      message?: string;
      error?: { message?: string };
      response?: {
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      };
    };
    if (
      e.type === "response.output_text.delta" &&
      typeof e.delta === "string"
    ) {
      text += e.delta;
    }
    if (e.type === "error" || e.error !== undefined) {
      errorMessage = e.error?.message ?? e.message ?? errorMessage;
    }
    // In-progress events carry `usage: null`, not an absent key.
    const u = e.response?.usage;
    if (u !== undefined && u !== null) {
      usage = {
        ...(u.input_tokens === undefined
          ? {}
          : { inputTokens: u.input_tokens }),
        ...(u.output_tokens === undefined
          ? {}
          : { outputTokens: u.output_tokens }),
      };
    }
    if (e.response?.error?.message !== undefined) {
      errorMessage = e.response.error.message;
    }
  }
  return {
    text,
    usage,
    events,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

export async function invokeCodex(
  input: CodexInvocation,
): Promise<CodexInvocationResult> {
  const snapshot = (
    usage: { inputTokens?: number; outputTokens?: number } = {},
    events: unknown[] = [],
  ): CodexRuntimeSnapshot => ({
    requestedModel: input.model,
    requestedEffort: input.effort,
    effectiveEffort: input.effort,
    usage,
    events,
  });

  const token = input.env.CODEX_ACCESS_TOKEN;
  if (token === undefined || token === "") {
    return {
      ok: false,
      classification: "auth",
      runtimeSnapshot: snapshot(),
    };
  }
  const accountId = accountIdFrom(token);
  if (accountId === undefined) {
    return {
      ok: false,
      classification: "auth",
      runtimeSnapshot: snapshot(),
    };
  }

  const res = await curlPostJson({
    url: ENDPOINT,
    secretHeaders: {
      authorization: { prefix: "Bearer ", value: token },
      "chatgpt-account-id": { prefix: "", value: accountId },
    },
    headers: {
      originator: ORIGINATOR,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      // The backend refuses `store: true` outright.
      store: false,
      stream: true,
      instructions: input.systemPrompt ?? "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.prompt }],
        },
      ],
      reasoning: { effort: input.effort, summary: "auto" },
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
    timeoutMs: input.timeoutMs,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (res.terminal === "timeout") {
    return {
      ok: false,
      classification: "timeout",
      runtimeSnapshot: snapshot(),
    };
  }
  if (res.terminal === "cancelled") {
    return {
      ok: false,
      classification: "cancelled",
      runtimeSnapshot: snapshot(),
    };
  }
  if (res.terminal === "transport") {
    return { ok: false, classification: "proxy", runtimeSnapshot: snapshot() };
  }

  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      classification: classify(res.status),
      runtimeSnapshot: snapshot(),
    };
  }

  const { text, usage, events, errorMessage } = collectSse(res.body);
  if (errorMessage !== undefined) {
    // A 200 whose stream carries an error: the quota case arrives this way.
    return {
      ok: false,
      classification: /rate limit|quota|usage limit/i.test(errorMessage)
        ? "quota-exhausted"
        : "error",
      runtimeSnapshot: snapshot(usage, events),
    };
  }
  return { ok: true, text, runtimeSnapshot: snapshot(usage, events) };
}
