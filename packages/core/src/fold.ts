/**
 * Fold a session log into audit rows (design §5).
 *
 * The runtime's append-only session log is truth; this turns it into `span`
 * rows. It reads exactly two accounting sources, both written by the model
 * adapter from what the wire reported:
 *
 *   - `assistant/chunk` whose `chunk.type === "usage"` — the streamed usage
 *     record for one step;
 *   - `assistant/message` carrying `usage` — the assembled message for one
 *     step, which the runtime documents as travelling WITH its accounting.
 *
 * Both name the same `(turn, step)`, so a step reported twice is folded once.
 * `turn/*` and `step/*` supply the boundaries and the wall time;
 * `request/header` and `request/context` supply the model route.
 *
 * It does NOT read any chars-per-token pressure estimate. That is a context
 * gauge, not billing data, and a fabricated-looking number in a cost table is
 * worse than an absent one.
 *
 * The input is a plain event array, deliberately: core must not import a
 * runtime package, and every runtime that keeps an append-only log can shape
 * its events into this.
 * @module @helium/core/fold
 */
import type { Span } from "./audit.js";

/** The minimum an event must have for the fold to read it. */
export interface LogEvent {
  type: string;
  seq: number;
  /** Unix epoch milliseconds. */
  time: number;
  data: unknown;
}

export interface FoldContext {
  runId: string;
  tenant: string;
  role: string;
  /** Fallback identity when the log carries no route header. */
  provider: string;
  model: string;
  parentSpanId?: string;
  /** USD per token for the route, from the owning plugin's catalog. */
  price?: { usdIn: number; usdOut: number };
  /** Step numbers already folded, so a re-fold continues rather than repeats. */
  stepOffset?: number;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
}

function readUsage(value: unknown): Usage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof usage[key] === "number" ? (usage[key] as number) : undefined;
  const input = num("inputTokens");
  const output = num("outputTokens");
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(num("totalTokens") === undefined ? {} : { totalTokens: num("totalTokens") }),
    ...(num("cacheReadTokens") === undefined
      ? {}
      : { cacheReadTokens: num("cacheReadTokens") }),
  };
}

function turnStep(data: unknown): { turn: number; step: number } | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.turn !== "number") return undefined;
  const step = typeof record.step === "number" ? record.step : 0;
  return { turn: record.turn, step };
}

function route(data: unknown): { provider?: string; model?: string } {
  if (data === null || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const header = record.header as Record<string, unknown> | undefined;
  const config = header?.config as Record<string, unknown> | undefined;
  const provider = record.provider ?? config?.provider;
  const model = record.model ?? config?.model;
  return {
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
  };
}

const TOOL_SPAN = "tool";

/**
 * Fold one session log into spans: one MODEL span per `(turn, step)` that
 * reported usage, plus one TOOL span per completed tool call.
 *
 * Cost is computed from the plugin's own per-token price. With no price the
 * cost is 0 and the tokens are still real -- a flat-rate route is not free,
 * it is unmetered, and the token columns are what make that visible.
 */
export function foldSessionLog(
  events: readonly LogEvent[],
  context: FoldContext,
): Span[] {
  const offset = context.stepOffset ?? 0;
  let provider = context.provider;
  let model = context.model;

  const steps = new Map<
    string,
    { usage: Usage; startMs: number; endMs: number; provider: string; model: string }
  >();
  const stepStart = new Map<string, number>();
  const calls = new Map<string, { name: string; startMs: number; key: string }>();
  const toolSpans: Span[] = [];

  for (const event of events) {
    if (event.type === "request/header" || event.type === "request/context") {
      const found = route(event.data);
      if (found.provider !== undefined) provider = found.provider;
      if (found.model !== undefined) model = found.model;
      continue;
    }

    const position = turnStep(event.data);
    const key = position === undefined ? undefined : `${position.turn}:${position.step}`;

    if (event.type === "step/start" && key !== undefined) {
      stepStart.set(key, event.time);
      continue;
    }

    if (key !== undefined && (event.type === "assistant/chunk" || event.type === "assistant/message")) {
      const data = event.data as Record<string, unknown>;
      const chunk = data.chunk as Record<string, unknown> | undefined;
      const usage =
        event.type === "assistant/chunk"
          ? chunk?.type === "usage"
            ? readUsage(chunk.usage)
            : undefined
          : readUsage(data.usage);
      if (usage === undefined) continue;
      const existing = steps.get(key);
      steps.set(key, {
        // Last writer wins on purpose: `assistant/message` is the assembled
        // record and supersedes the streamed chunk for the same step.
        usage: { ...existing?.usage, ...usage },
        startMs: existing?.startMs ?? stepStart.get(key) ?? event.time,
        endMs: event.time,
        provider,
        model,
      });
      continue;
    }

    if (event.type === "tool/call" && key !== undefined) {
      const data = event.data as Record<string, unknown>;
      const callId = String(data.callId ?? `${key}:${event.seq}`);
      calls.set(callId, {
        name: typeof data.name === "string" ? data.name : "unknown",
        startMs: event.time,
        key,
      });
      continue;
    }

    if (event.type === "tool/result") {
      const data = event.data as Record<string, unknown>;
      const message = data.message as Record<string, unknown> | undefined;
      const callId = String(message?.callId ?? data.callId ?? "");
      const call = calls.get(callId);
      if (call === undefined) continue;
      calls.delete(callId);
      const content = message?.content;
      toolSpans.push({
        runId: context.runId,
        spanId: `${TOOL_SPAN}:${callId}`,
        ...(context.parentSpanId === undefined
          ? {}
          : { parentSpanId: context.parentSpanId }),
        tenant: context.tenant,
        role: context.role,
        provider,
        model,
        stepNo: offset + Number(call.key.split(":")[1] ?? 0),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        contextSize: 0,
        latencyMs: Math.max(0, event.time - call.startMs),
        costUsd: 0,
        toolName: call.name,
        toolOutputBytes:
          typeof content === "string"
            ? Buffer.byteLength(content, "utf8")
            : Buffer.byteLength(JSON.stringify(content ?? null), "utf8"),
        summarised: data.summarised === true,
        ts: new Date(event.time).toISOString(),
      });
    }
  }

  const modelSpans: Span[] = [...steps.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en"))
    .map(([key, entry], index) => {
      const input = entry.usage.inputTokens ?? 0;
      const output = entry.usage.outputTokens ?? 0;
      const cache = entry.usage.cacheReadTokens ?? 0;
      return {
        runId: context.runId,
        spanId: `step:${key}`,
        ...(context.parentSpanId === undefined
          ? {}
          : { parentSpanId: context.parentSpanId }),
        tenant: context.tenant,
        role: context.role,
        provider: entry.provider,
        model: entry.model,
        stepNo: offset + index + 1,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cache,
        contextSize: entry.usage.totalTokens ?? input + output,
        latencyMs: Math.max(0, entry.endMs - entry.startMs),
        costUsd:
          context.price === undefined
            ? 0
            : input * context.price.usdIn + output * context.price.usdOut,
        summarised: false,
        ts: new Date(entry.endMs).toISOString(),
      };
    });

  return [...modelSpans, ...toolSpans];
}
