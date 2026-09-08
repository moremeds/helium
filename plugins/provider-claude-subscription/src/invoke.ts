import { curlPostJson } from "@helium/provider-sdk/curl";
import {
  parseToolArgs,
  runToolCall,
  toolCallEvents,
  toolSpecs,
} from "@helium/provider-sdk/tool-loop";
import type { ToolSpec } from "@helium/provider-sdk/tool-loop";
import type { EcosystemTool, LogEvent } from "@helium/core";
import type { ClaudeEffort } from "./catalog.js";

/**
 * How many times this provider lets a model answer with tool calls before the
 * loop gives up. Provider-local on purpose: the shared `MAX_TOOL_TURNS` in
 * `@helium/provider-sdk` is 8, sized for "the option-wizard team's longest
 * role calls five tools once each", and raising THAT would silently change
 * the codex edge too.
 *
 * Why it had to move. The flash-review reviewer needs, at minimum,
 * `fr_rubric` + `fr_page` + `fr_dated_events` + one `fr_evidence` index call
 * + one `fr_evidence` read per recording — 13 calls against the nine-file
 * 2026-09-06 weekly sample, before it re-reads anything to check a finding.
 * At 8 it returned nothing but "[helium: stopped after 8 tool turns]" on all
 * four calibration mutations (2026-09-08).
 *
 * Why 64 and not a number closer to 13. The provider that DOES complete this
 * review, `plugins/provider-dsh`, imposes no turn ceiling at all — the dsh
 * runtime loops until the model stops. So the order of magnitude to match is
 * "does not bind", and the cap's remaining job is only to stop a model stuck
 * re-asking the same question forever. 64 is 8x the old ceiling and ~5x the
 * measured need, and every turn re-sends the transcript, so a runaway still
 * ends in bounded, not quadratic-forever, spend.
 *
 * A second ceiling binds independently and is NOT this one: each turn is a
 * single request with `timeoutMs: work.constraints.maxLatencyMs ??
 * REQUEST_TIMEOUT_MS`
 * (`provider.ts`, `executor.ts`), plus curl's own +2s hard kill. A turn that
 * exceeds it fails the whole call however many turns are left — which is
 * exactly how the codex edge failed this same review.
 */
export const MAX_TOOL_TURNS = 64;

/**
 * Per-REQUEST ceiling, in milliseconds, when the work order names no latency
 * constraint of its own. One turn of the tool loop is one request, so this is
 * not a ceiling on the whole call.
 *
 * 300_000 was the original value and it was measured to be too low: on
 * 2026-09-08 a flash-review run through this backend produced NO SSE bytes at
 * all on its FIRST request and was killed at 300_014 ms with zero tokens
 * billed. The user's tribunal-review skill drives the same backend and has
 * 600s as its working ceiling, so that is the number here — taken from a
 * measurement on this backend, not chosen for roundness.
 */
export const REQUEST_TIMEOUT_MS = 600_000;

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
  /**
   * Every turn's usage plus every tool call, already in the shape
   * `foldSessionLog` bills. Present on success; a tool-free call yields the
   * one turn it always did.
   */
  events?: LogEvent[];
  /** How many model turns the loop took. 1 unless a tool was called. */
  turns?: number;
}

export interface ClaudeInvocation {
  model: string;
  effort?: ClaudeEffort;
  prompt: string;
  /** System prompt appended after the mandatory Claude Code identity block. */
  systemPrompt?: string;
  timeoutMs: number;
  /** Role-declared ceiling on the reply, in tokens. Absent uses this edge's own default. */
  maxOutputTokens?: number;
  /**
   * The provider's declared environment. Three keys are read: the credential,
   * as `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token`) then
   * `ANTHROPIC_API_KEY`, and `HELIUM_PROXY` — the egress the mini needs and the
   * laptop does not (§3.1). Nothing is inherited from the ambient process;
   * `loadOperatorEnv` puts the file's values into the env that is handed here.
   */
  env: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Tool IMPLEMENTATIONS this step may call, handed down by the runner in
   * `selection.options.tools`. Empty or absent means single-shot inference,
   * which is exactly what this provider did before the loop existed.
   */
  tools?: readonly EcosystemTool[];
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

/**
 * One turn's accounting, in the shape `foldSessionLog` reads.
 *
 * A tool loop is several model turns, and each is billed separately by the
 * vendor — folding them into one event would hide every turn but the last, so
 * the cost of a chatty tool loop would read as the cost of a single answer.
 */
export function turnEvents(
  seq: number,
  turn: number,
  startedAt: number,
  usage: Record<string, unknown>,
): LogEvent[] {
  const num = (key: string): number =>
    typeof usage[key] === "number" ? (usage[key] as number) : 0;
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
          inputTokens: num("input_tokens"),
          outputTokens: num("output_tokens"),
          cacheReadTokens: num("cache_read_input_tokens"),
        },
      },
    },
  ];
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * Single-shot inference, or a tool loop when the step was handed tools.
 *
 * The two are one function on purpose: a tool-free call is just the loop that
 * exits after its first turn, so there is no second code path to keep in step
 * and no way for the tool-free case to drift from the tool-using one.
 */
export async function invokeClaude(
  input: ClaudeInvocation,
): Promise<ClaudeInvocationResult> {
  const totals: Record<string, number> = {};
  const runtime = (reported?: string): ClaudeRuntimeSnapshot => ({
    requestedModel: input.model,
    ...(input.effort === undefined
      ? {}
      : { requestedEffort: input.effort, effectiveEffort: input.effort }),
    ...(reported === undefined ? {} : { providerReportedEffort: reported }),
    modelUsage: { ...totals },
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
  const tools = input.tools ?? [];
  const declared = toolSpecs(tools).map((spec: ToolSpec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));

  // The role's declared reply budget, or this edge's default. One number, one
  // place: a reply cut off mid-JSON is indistinguishable from a model that
  // stopped early, and REPLY_HEADROOM was sized for a paragraph.
  const reply = input.maxOutputTokens ?? REPLY_HEADROOM;
  const messages: unknown[] = [{ role: "user", content: input.prompt }];
  const events: LogEvent[] = [];
  // Only the LAST assistant turn's text is the answer. Every turn before it is
  // the model narrating its way to a tool call ("I'll start by reading the
  // rubric"), and concatenating those in front of a structured reply is what
  // made a valid verdict fail its own schema check. `provider-dsh` returns the
  // final message and this edge now agrees with it.
  let said = "";
  let seq = 0;
  let raw: unknown;

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    const startedAt = Date.now();
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: budget + reply,
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        ...(input.systemPrompt === undefined
          ? []
          : [{ type: "text", text: input.systemPrompt }]),
      ],
      messages,
    };
    if (budget > 0) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
    if (declared.length > 0) body.tools = declared;

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
      ...(input.env.HELIUM_PROXY === undefined || input.env.HELIUM_PROXY === ""
        ? {}
        : { proxy: input.env.HELIUM_PROXY }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (res.terminal === "timeout") {
      return { ok: false, classification: "timeout", runtimeSnapshot: runtime() };
    }
    if (res.terminal === "cancelled") {
      return {
        ok: false,
        classification: "cancelled",
        runtimeSnapshot: runtime(),
      };
    }
    if (res.terminal === "transport") {
      // Never reached Anthropic, so it cannot be an auth fault; calling it one
      // is the mistake documented above.
      return {
        ok: false,
        classification: "proxy",
        raw: { error: res.error },
        runtimeSnapshot: runtime(),
      };
    }

    try {
      raw = JSON.parse(res.body);
    } catch {
      raw = { body: res.body.slice(0, 2_000) };
    }

    if (res.status < 200 || res.status >= 300) {
      const retryAfter = (raw as { error?: { retry_after?: string } })?.error
        ?.retry_after;
      return {
        ok: false,
        classification: classify(res.status),
        ...(retryAfter === undefined ? {} : { retryAfter }),
        raw,
        runtimeSnapshot: runtime(),
      };
    }

    const envelope = raw as
      | {
          content?: ClaudeContentBlock[];
          usage?: Record<string, unknown>;
          stop_reason?: string;
        }
      | undefined;
    const usage = envelope?.usage ?? {};
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    }
    events.push(...turnEvents(seq, turn, startedAt, usage));
    seq += 2;

    const content = envelope?.content ?? [];
    const spoken = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (spoken !== "") said = spoken;

    const calls = content.filter(
      (block) => block.type === "tool_use" && typeof block.id === "string",
    );
    if (calls.length === 0) {
      return {
        ok: true,
        text: said,
        raw,
        runtimeSnapshot: runtime(),
        events,
        turns: turn,
      };
    }

    // The assistant turn goes back VERBATIM. With extended thinking on, the
    // content array carries signed thinking blocks the API requires unchanged
    // alongside the tool_use it is answering — rebuilding it from the parts we
    // happen to care about is how a tool loop starts getting 400s under
    // `reason.deep` and not otherwise.
    messages.push({ role: "assistant", content });
    const results: unknown[] = [];
    for (const call of calls) {
      const callStarted = Date.now();
      const outcome = await runToolCall(
        tools,
        call.name ?? "",
        parseToolArgs(call.input),
      );
      events.push(
        ...toolCallEvents(
          seq,
          turn,
          call.id!,
          call.name ?? "unknown",
          callStarted,
          outcome,
        ),
      );
      seq += 2;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  // The ceiling was reached with the model still asking for tools. Returning
  // what it has said so far is right — the turns were paid for and the partial
  // answer is real — but the reader must be told it is partial, or a truncated
  // reply reads as a considered short one.
  return {
    ok: true,
    text: [
      said,
      `[helium: stopped after ${String(MAX_TOOL_TURNS)} tool turns; the model was still calling tools]`,
    ]
      .filter((part) => part !== "")
      .join("\n"),
    raw,
    runtimeSnapshot: runtime(),
    events,
    turns: MAX_TOOL_TURNS,
  };
}
