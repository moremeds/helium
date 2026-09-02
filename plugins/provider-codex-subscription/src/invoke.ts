import { curlPostJson } from "@helium/provider-sdk/curl";
import {
  MAX_TOOL_TURNS,
  parseToolArgs,
  runToolCall,
  toolCallEvents,
  toolSpecs,
} from "@helium/provider-sdk/tool-loop";
import type { ToolSpec } from "@helium/provider-sdk/tool-loop";
import type { EcosystemTool, LogEvent } from "@helium/core";
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
  /** Every turn's usage plus every tool call, in the shape the fold bills. */
  events?: LogEvent[];
  /** How many model turns the loop took. 1 unless a tool was called. */
  turns?: number;
}

export interface CodexInvocation {
  model: string;
  effort: CodexEffort;
  prompt: string;
  /** Becomes the Responses API `instructions` field. */
  systemPrompt?: string;
  timeoutMs: number;
  /**
   * The provider's declared environment. Two keys are read:
   * `CODEX_ACCESS_TOKEN`, the `access_token` from `~/.codex/auth.json`, and
   * `HELIUM_PROXY`, the egress the mini needs (§3.1). Nothing is inherited from
   * the ambient process; `loadOperatorEnv` puts the file's values into the env
   * that is handed here.
   */
  env: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Tool IMPLEMENTATIONS this step may call, handed down by the runner in
   * `selection.options.tools`. Absent or empty means single-shot inference.
   */
  tools?: readonly EcosystemTool[];
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
export interface CodexFunctionCall {
  callId: string;
  name: string;
  arguments: unknown;
  /** The output_item verbatim, to be replayed into the next request. */
  item: unknown;
}

function collectSse(body: string): {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
  events: unknown[];
  calls: CodexFunctionCall[];
  errorMessage?: string;
} {
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let errorMessage: string | undefined;
  const events: unknown[] = [];
  const calls: CodexFunctionCall[] = [];

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
      item?: {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: unknown;
      };
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
    // A completed function call arrives as its own output item. The Responses
    // API has no `store` here (the backend refuses it), so the item must be
    // replayed VERBATIM into the next request's input or the model is answering
    // a call it cannot see it made.
    if (
      e.type === "response.output_item.done" &&
      e.item?.type === "function_call" &&
      typeof e.item.call_id === "string"
    ) {
      calls.push({
        callId: e.item.call_id,
        name: e.item.name ?? "",
        arguments: e.item.arguments,
        item: e.item,
      });
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
    calls,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

/**
 * One turn's accounting, in the shape `foldSessionLog` reads. A tool loop is
 * several billed turns; folding them into one would report a chatty loop as
 * the cost of a single answer.
 */
export function turnEvents(
  seq: number,
  turn: number,
  startedAt: number,
  usage: { inputTokens?: number; outputTokens?: number },
): LogEvent[] {
  return [
    { type: "step/start", seq, time: startedAt, data: { turn, step: 1 } },
    {
      type: "assistant/message",
      seq: seq + 1,
      time: Date.now(),
      data: {
        turn,
        step: 1,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      },
    },
  ];
}

/**
 * Single-shot inference, or a tool loop when the step was handed tools.
 *
 * One function, not two: a tool-free call is the loop exiting after its first
 * turn, so there is no second path to keep in step.
 */
export async function invokeCodex(
  input: CodexInvocation,
): Promise<CodexInvocationResult> {
  const totals: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  const allEvents: unknown[] = [];
  const snapshot = (): CodexRuntimeSnapshot => ({
    requestedModel: input.model,
    requestedEffort: input.effort,
    effectiveEffort: input.effort,
    usage: { ...totals },
    events: allEvents,
  });

  const token = input.env.CODEX_ACCESS_TOKEN;
  if (token === undefined || token === "") {
    return { ok: false, classification: "auth", runtimeSnapshot: snapshot() };
  }
  const accountId = accountIdFrom(token);
  if (accountId === undefined) {
    return { ok: false, classification: "auth", runtimeSnapshot: snapshot() };
  }

  const tools = input.tools ?? [];
  const declared = toolSpecs(tools).map((spec: ToolSpec) => ({
    type: "function" as const,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // Strict mode would demand every property be required and additionalProperties
    // be false; a tenant tool's params are neither, and forcing them would be
    // changing the tool to suit the wire.
    strict: false,
  }));

  const conversation: unknown[] = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input.prompt }],
    },
  ];
  const log: LogEvent[] = [];
  const said: string[] = [];
  let seq = 0;

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    const startedAt = Date.now();
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
        // The backend refuses `store: true` outright, so the whole
        // conversation is resent every turn — which is also why the loop has
        // a ceiling.
        store: false,
        stream: true,
        instructions: input.systemPrompt ?? "You are a helpful assistant.",
        input: conversation,
        reasoning: { effort: input.effort, summary: "auto" },
        ...(declared.length === 0 ? {} : { tools: declared }),
        tool_choice: "auto",
        parallel_tool_calls: true,
      }),
      timeoutMs: input.timeoutMs,
      ...(input.env.HELIUM_PROXY === undefined || input.env.HELIUM_PROXY === ""
        ? {}
        : { proxy: input.env.HELIUM_PROXY }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (res.terminal === "timeout") {
      return { ok: false, classification: "timeout", runtimeSnapshot: snapshot() };
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

    const { text, usage, events, calls, errorMessage } = collectSse(res.body);
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    allEvents.push(...events);
    if (errorMessage !== undefined) {
      // A 200 whose stream carries an error: the quota case arrives this way.
      return {
        ok: false,
        classification: /rate limit|quota|usage limit/i.test(errorMessage)
          ? "quota-exhausted"
          : "error",
        runtimeSnapshot: snapshot(),
      };
    }
    log.push(...turnEvents(seq, turn, startedAt, usage));
    seq += 2;
    if (text !== "") said.push(text);

    if (calls.length === 0) {
      return {
        ok: true,
        text: said.join("\n"),
        runtimeSnapshot: snapshot(),
        events: log,
        turns: turn,
      };
    }

    for (const call of calls) {
      conversation.push(call.item);
      const callStarted = Date.now();
      const outcome = await runToolCall(
        tools,
        call.name,
        parseToolArgs(call.arguments),
      );
      log.push(
        ...toolCallEvents(
          seq,
          turn,
          call.callId,
          call.name,
          callStarted,
          outcome,
        ),
      );
      seq += 2;
      conversation.push({
        type: "function_call_output",
        call_id: call.callId,
        output: outcome.content,
      });
    }
  }

  // The ceiling was reached with the model still calling tools. The turns were
  // paid for and the partial answer is real, but a truncated reply that does
  // not say it is truncated reads as a considered short one.
  said.push(
    `[helium: stopped after ${String(MAX_TOOL_TURNS)} tool turns; the model was still calling tools]`,
  );
  return {
    ok: true,
    text: said.join("\n"),
    runtimeSnapshot: snapshot(),
    events: log,
    turns: MAX_TOOL_TURNS,
  };
}
