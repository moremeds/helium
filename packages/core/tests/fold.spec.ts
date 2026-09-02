import { describe, expect, it } from "vitest";
import { foldSessionLog, type LogEvent } from "../src/index.js";

/**
 * Event shapes are the pinned runtime's own: `assistant/chunk` carrying a
 * `{type:'usage'}` stream chunk, `assistant/message` carrying the assembled
 * step's `usage`, `turn/*` and `step/*` boundaries, and `request/context`
 * naming the route. Nothing here reads a chars-per-token estimate.
 */
const log: LogEvent[] = [
  { type: "turn/start", seq: 1, time: 1_000, data: { turn: 1 } },
  { type: "request/context", seq: 2, time: 1_000, data: { provider: "route-a", model: "model-a", contextWindow: 128_000 } },
  { type: "step/start", seq: 3, time: 1_000, data: { turn: 1, step: 1 } },
  { type: "assistant/chunk", seq: 4, time: 1_400, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hi" } } },
  { type: "assistant/chunk", seq: 5, time: 1_500, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 4321, outputTokens: 210, totalTokens: 4531, cacheReadTokens: 4000 } } } },
  { type: "tool/call", seq: 6, time: 1_600, data: { turn: 1, step: 1, callId: "c1", name: "fake_probe", arguments: "{}" } },
  { type: "tool/result", seq: 7, time: 1_900, data: { turn: 1, step: 1, message: { callId: "c1", content: "0123456789" } } },
  { type: "step/end", seq: 8, time: 1_900, data: { turn: 1, step: 1 } },
  { type: "step/start", seq: 9, time: 2_000, data: { turn: 1, step: 2 } },
  { type: "assistant/message", seq: 10, time: 2_600, data: { turn: 1, step: 2, message: { role: "assistant" }, usage: { inputTokens: 5000, outputTokens: 90 } } },
  { type: "turn/end", seq: 11, time: 2_600, data: { turn: 1, reason: "completed" } },
];

describe("foldSessionLog", () => {
  it("folds a usage chunk and an assembled message into one model span each", () => {
    const spans = foldSessionLog(log, {
      runId: "r1",
      tenant: "fake-tenant",
      role: "prober",
      provider: "fallback",
      model: "fallback",
      price: { usdIn: 1e-6, usdOut: 4e-6 },
    });
    const model = spans.filter((s) => s.toolName === undefined);
    expect(model).toHaveLength(2);
    expect(model[0]).toMatchObject({
      spanId: "step:1:1",
      stepNo: 1,
      provider: "route-a",
      model: "model-a",
      inputTokens: 4321,
      outputTokens: 210,
      cacheReadTokens: 4000,
      contextSize: 4531,
      latencyMs: 500,
    });
    // 4321 * 1e-6 + 210 * 4e-6
    expect(model[0]!.costUsd).toBeCloseTo(0.005161, 9);
    expect(model[1]).toMatchObject({ spanId: "step:1:2", inputTokens: 5000, outputTokens: 90, latencyMs: 600 });
  });

  it("records one tool span with its output bytes and latency", () => {
    const spans = foldSessionLog(log, {
      runId: "r1", tenant: "t", role: "prober", provider: "p", model: "m",
    });
    const tool = spans.find((s) => s.toolName === "fake_probe")!;
    expect(tool).toMatchObject({
      spanId: "tool:c1", toolOutputBytes: 10, latencyMs: 300, inputTokens: 0, costUsd: 0,
    });
  });

  it("folds a step reported by both a chunk and a message exactly once", () => {
    const doubled: LogEvent[] = [
      ...log,
      { type: "assistant/message", seq: 12, time: 1_950, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 4321, outputTokens: 215 } } },
    ];
    const spans = foldSessionLog(doubled, { runId: "r1", tenant: "t", role: "r", provider: "p", model: "m" });
    const first = spans.filter((s) => s.spanId === "step:1:1");
    expect(first).toHaveLength(1);
    // The assembled message supersedes the streamed chunk for the same step.
    expect(first[0]!.outputTokens).toBe(215);
  });

  it("yields no model span at all when the log reported no usage", () => {
    const spans = foldSessionLog(
      [
        { type: "turn/start", seq: 1, time: 0, data: { turn: 1 } },
        { type: "step/start", seq: 2, time: 0, data: { turn: 1, step: 1 } },
        { type: "assistant/chunk", seq: 3, time: 5, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "x" } } },
      ],
      { runId: "r1", tenant: "t", role: "r", provider: "p", model: "m" },
    );
    expect(spans).toEqual([]);
  });
});
