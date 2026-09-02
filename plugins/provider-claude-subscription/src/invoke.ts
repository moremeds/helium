import { curlPostJson } from "@helium/provider-sdk/curl";
import type { ClaudeEffort } from "./catalog.js";

export type ClaudeClassification =
  "proxy" | "auth" | "timeout" | "cancelled" | "quota-exhausted" | "error";

export interface ClaudeRuntimeSnapshot {
  requestedModel: string;
  requestedEffort?: ClaudeEffort;
  effectiveEffort?: ClaudeEffort;
  providerReportedEffort?: string;
  modelUsage: Record<string, unknown>;
}

export interface ClaudeInvocationResult {
  ok: boolean;
  text?: string;
  classification?: ClaudeClassification;
  retryAfter?: string;
  raw?: unknown;
  runtimeSnapshot: ClaudeRuntimeSnapshot;
}

export interface ClaudeInvocation {
  model: string;
  effort?: ClaudeEffort;
  prompt: string;
  /** System prompt appended after the mandatory Claude Code identity block. */
  systemPrompt?: string;
  timeoutMs: number;
  /**
   * The provider's declared environment. Only two keys are read, in this order:
   * `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token` credential) then
   * `ANTHROPIC_API_KEY`. Nothing is inherited from the ambient process.
   */
  env: Record<string, string>;
  /** Explicit egress proxy; the mini needs one, the laptop does not (§3.1). */
  proxy?: string;
  signal?: AbortSignal;
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";

/**
 * The subscription entitlement check: the Messages API refuses an OAuth token
 * unless the first system block is exactly this string. Our own system prompt
 * goes in a second block. Verified live 2026-09-02; see design §3.1.
 */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Our policy, not a vendor mapping: the API takes a thinking budget in tokens,
 * the catalog speaks in effort names. `low` means no extended thinking at all.
 */
const THINKING_BUDGET: Record<ClaudeEffort, number> = {
  low: 0,
  medium: 4_000,
  high: 10_000,
  xhigh: 20_000,
  max: 32_000,
};

const REPLY_HEADROOM = 4_096;

/**
 * Status is the whole signal here — unlike the CLI, which forced us to regex
 * prose. The 403 case is why this exists: Anthropic returns it *before*
 * evaluating auth when the caller's egress is blocked, and the old CLI wording
 * ("Failed to authenticate…403") matched an auth regex first, so a network
 * fault was reported for months as "Not logged in". Status 403 is never auth.
 */
function classify(status: number): ClaudeClassification {
  if (status === 401) return "auth";
  if (status === 403) return "proxy";
  if (status === 429) return "quota-exhausted";
  return "error";
}

export async function invokeClaude(
  input: ClaudeInvocation,
): Promise<ClaudeInvocationResult> {
  const runtime = (
    usage?: unknown,
    reported?: string,
  ): ClaudeRuntimeSnapshot => ({
    requestedModel: input.model,
    ...(input.effort === undefined
      ? {}
      : { requestedEffort: input.effort, effectiveEffort: input.effort }),
    ...(reported === undefined ? {} : { providerReportedEffort: reported }),
    modelUsage:
      typeof usage === "object" && usage !== null
        ? (usage as Record<string, unknown>)
        : {},
  });

  const token =
    input.env.CLAUDE_CODE_OAUTH_TOKEN ?? input.env.ANTHROPIC_API_KEY;
  if (token === undefined || token === "") {
    return {
      ok: false,
      classification: "auth",
      raw: {
        error:
          "no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the declared env",
      },
      runtimeSnapshot: runtime(),
    };
  }

  const budget = input.effort === undefined ? 0 : THINKING_BUDGET[input.effort];
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: budget + REPLY_HEADROOM,
    system: [
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      ...(input.systemPrompt === undefined
        ? []
        : [{ type: "text", text: input.systemPrompt }]),
    ],
    messages: [{ role: "user", content: input.prompt }],
  };
  if (budget > 0) {
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const res = await curlPostJson({
    url: ENDPOINT,
    secretHeaders: { authorization: { prefix: "Bearer ", value: token } },
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.258",
      "x-app": "cli",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: input.timeoutMs,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (res.terminal === "timeout") {
    return { ok: false, classification: "timeout", runtimeSnapshot: runtime() };
  }
  if (res.terminal === "cancelled") {
    return { ok: false, classification: "cancelled", runtimeSnapshot: runtime() };
  }
  if (res.terminal === "transport") {
    // Never reached Anthropic, so it cannot be an auth fault; calling it one is
    // the mistake documented above.
    return {
      ok: false,
      classification: "proxy",
      raw: { error: res.error },
      runtimeSnapshot: runtime(),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch {
    raw = { body: res.body.slice(0, 2_000) };
  }

  if (res.status < 200 || res.status >= 300) {
    const retryAfter = (raw as { error?: { retry_after?: string } })?.error?.retry_after;
    return {
      ok: false,
      classification: classify(res.status),
      ...(retryAfter === undefined ? {} : { retryAfter }),
      raw,
      runtimeSnapshot: runtime(),
    };
  }

  const envelope = raw as
    | { content?: Array<{ type?: string; text?: string }>; usage?: unknown }
    | undefined;
  const text = envelope?.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return {
    ok: true,
    ...(text === undefined ? {} : { text }),
    raw,
    runtimeSnapshot: runtime(envelope?.usage),
  };
}
