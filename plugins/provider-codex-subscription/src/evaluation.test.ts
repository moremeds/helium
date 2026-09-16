import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CurlRequest, CurlResponse } from "@helium/provider-sdk/curl";
import type { EcosystemTool } from "@helium/core";
import { createCodexEvaluation } from "./evaluation.js";

const curl = vi.hoisted(() => vi.fn<(request: CurlRequest) => Promise<CurlResponse>>());
vi.mock("@helium/provider-sdk/curl", () => ({ curlPostJson: curl }));
const roots: string[] = [];
const env = { CODEX_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.sig` };
const limits = { maxRequests: 3, timeoutMs: 10_000, maxOutputTokens: 32, maxRequestBytes: 10_000 };
function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-evaluation-"));
  roots.push(root);
  const outputDir = join(root, "private");
  return { ...createCodexEvaluation({ outputDir, model: "gpt-5.6-luna", env, limits: { ...limits, ...overrides } }), outputDir };
}
const stream = (usage: unknown, ...events: unknown[]): CurlResponse => ({ status: 200, body: [...events, { type: "response.completed", response: { model: "reported-model", usage } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
function run(evaluation: ReturnType<typeof setup>, tools: EcosystemTool[] = []) {
  const selection = evaluation.provider.select({ role: "writer", requires: ["code.edit"] });
  return evaluation.provider.run!({ role: "writer", constraints: { tools: tools.map((tool) => tool.name), maxOutputTokens: 100 }, inputs: { prompt: "test", artifacts: [] } } as never, { ...selection, options: { tools } }, new AbortController().signal);
}
const tool = { name: "frozen", description: "frozen test result", paramsSchema: {} as never, mutating: false, run: vi.fn(async () => "frozen observation") };
const call = { type: "response.output_item.done", item: { type: "function_call", name: "frozen", call_id: "one", arguments: "{}" } };
afterEach(() => { curl.mockReset(); tool.run.mockClear(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });

describe("controlled Codex evaluation", () => {
  it("refuses ignored policy fields and unsupported timers before dispatch", () => {
    expect(() => setup({ maxTotalTokens: 10 })).toThrow("limit fields");
    expect(() => setup({ timeoutMs: 2_147_483_648 })).toThrow("timer limit");
    expect(curl).not.toHaveBeenCalled();
  });
  it("persists exact request before dispatch, clips output, preserves zero usage and private artifacts", async () => {
    const evaluation = setup();
    curl.mockImplementation(async (request) => {
      const recorded = JSON.parse(readFileSync(join(evaluation.outputDir, "request-1.json"), "utf8"));
      expect(recorded.body).toBe(request.body);
      expect(recorded.state).toBe("UNKNOWN");
      expect(JSON.parse(request.body).max_output_tokens).toBe(32);
      expect(evaluation.summary()).toMatchObject({ requestCount: 1, unknown: true, inputTokens: null });
      return stream({ input_tokens: 0, output_tokens: 0 });
    });
    await run(evaluation);
    expect(evaluation.summary()).toMatchObject({ identityGrade: "ROUTE_ONLY", requestCount: 1, inputTokens: 0, outputTokens: 0, unknown: false, reportedModels: ["reported-model"] });
    expect(statSync(evaluation.outputDir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(evaluation.outputDir)) {
      expect(statSync(join(evaluation.outputDir, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(evaluation.outputDir, name), "utf8")).not.toContain(env.CODEX_ACCESS_TOKEN);
    }
  });

  it("counts internal tool requests and refuses a further dispatch without losing billed usage", async () => {
    const evaluation = setup({ maxRequests: 1 });
    curl.mockResolvedValue(stream({ input_tokens: 7, output_tokens: 3 }, call));
    await expect(run(evaluation, [tool])).rejects.toThrow("maxRequests");
    expect(curl).toHaveBeenCalledTimes(1);
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(evaluation.summary()).toMatchObject({ requestCount: 1, inputTokens: 7, outputTokens: 3, unknown: false });
    await expect(run(evaluation)).rejects.toThrow();
    expect(curl).toHaveBeenCalledTimes(1);
  });

  it("sums both actual turns and records the tool observation in the next exact body", async () => {
    const evaluation = setup();
    curl.mockResolvedValueOnce(stream({ input_tokens: 7, output_tokens: 3 }, call)).mockResolvedValueOnce(stream({ input_tokens: 11, output_tokens: 2 }));
    await run(evaluation, [tool]);
    expect(evaluation.summary()).toMatchObject({ requestCount: 2, inputTokens: 18, outputTokens: 5 });
    expect(JSON.parse(readFileSync(join(evaluation.outputDir, "request-2.json"), "utf8")).body).toContain("frozen observation");
  });

  it.each([null, { input_tokens: 4 }, { input_tokens: -1, output_tokens: 2 }])("stops on missing/partial/invalid usage: %j", async (usage) => {
    const evaluation = setup();
    curl.mockResolvedValue(stream(usage, call));
    await expect(run(evaluation, [tool])).rejects.toThrow();
    expect(evaluation.summary().unknown).toBe(true);
    expect(tool.run).not.toHaveBeenCalled();
    await expect(run(evaluation)).rejects.toThrow();
    expect(curl).toHaveBeenCalledTimes(1);
    if (usage && "input_tokens" in usage && usage.input_tokens === 4) {
      expect(evaluation.summary()).toMatchObject({ inputTokens: 4, outputTokens: null, knownInputTokens: 4 });
    }
  });

  it.each(["timeout", "transport", "cancelled"] as const)("retains raw partial %s and never counts unknown as zero", async (terminal) => {
    const evaluation = setup();
    curl.mockResolvedValueOnce(stream({ input_tokens: 7, output_tokens: 3 }, call)).mockResolvedValueOnce({ status: 0, body: "partial stream", terminal });
    await expect(run(evaluation, [tool])).rejects.toThrow();
    expect(evaluation.summary()).toMatchObject({ requestCount: 2, inputTokens: null, outputTokens: null, knownInputTokens: 7, knownOutputTokens: 3, unknown: true });
    expect(readFileSync(join(evaluation.outputDir, "request-2-response.json"), "utf8")).toContain("partial stream");
    await expect(run(evaluation)).rejects.toThrow();
    expect(curl).toHaveBeenCalledTimes(2);
  });

  it.each([[401, "auth"], [429, "quota-exhausted"]] as const)("preserves HTTP %s failure classification while blocking retry", async (status, failure) => {
    const evaluation = setup();
    curl.mockResolvedValue({ status, body: "request refused" });
    await expect(run(evaluation)).rejects.toThrow(failure);
    expect(evaluation.summary().unknown).toBe(true);
    await expect(run(evaluation)).rejects.toThrow();
    expect(curl).toHaveBeenCalledTimes(1);
  });

  it("keeps usage on an incomplete stream as known partial accounting, never a completed total", async () => {
    const evaluation = setup();
    curl.mockResolvedValue({ status: 200, body: 'data: {"type":"response.incomplete","response":{"usage":{"input_tokens":9,"output_tokens":1}}}\n' });
    await expect(run(evaluation)).rejects.toThrow();
    expect(evaluation.summary()).toMatchObject({ unknown: true, inputTokens: null, outputTokens: null, knownInputTokens: 9, knownOutputTokens: 1 });
  });

  it("stops UNKNOWN if response evidence cannot be saved, preserving the existing artifact", async () => {
    const evaluation = setup();
    const path = join(evaluation.outputDir, "request-1-response.json");
    writeFileSync(path, "existing evidence");
    curl.mockResolvedValue(stream({ input_tokens: 7, output_tokens: 2 }));
    await expect(run(evaluation)).rejects.toThrow();
    expect(evaluation.summary()).toMatchObject({ unknown: true, inputTokens: null, outputTokens: null });
    expect(readFileSync(path, "utf8")).toBe("existing evidence");
    await expect(run(evaluation)).rejects.toThrow();
    expect(curl).toHaveBeenCalledTimes(1);
  });

  it("rejects bytes and expired trial deadline before any dispatch", async () => {
    const small = setup({ maxRequestBytes: 1 });
    await expect(run(small)).rejects.toThrow("maxRequestBytes");
    vi.useFakeTimers();
    const expired = setup();
    vi.setSystemTime(Date.now() + limits.timeoutMs + 1);
    await expect(run(expired)).rejects.toThrow("timeoutMs");
    expect(curl).not.toHaveBeenCalled();
    expect(small.summary().requestCount).toBe(0);
  });

  it("clips later requests to the remaining total trial time", async () => {
    vi.useFakeTimers();
    const evaluation = setup();
    curl.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 6000); return stream({ input_tokens: 7, output_tokens: 3 }, call); }).mockResolvedValueOnce(stream({ input_tokens: 8, output_tokens: 1 }));
    await run(evaluation, [tool]);
    expect(curl.mock.calls[1]![0].timeoutMs).toBe(4000);
  });

  it("refuses namespace reuse, invalid policy, unsupported capability and concurrent workers", async () => {
    const evaluation = setup();
    expect(() => createCodexEvaluation({ outputDir: evaluation.outputDir, model: "gpt-5.6-luna", env, limits })).toThrow();
    expect(() => setup({ maxRequests: 0 })).toThrow("invalid evaluation limit");
    expect(() => evaluation.provider.select({ role: "r", requires: ["reason.deep"] })).toThrow("capabilities");
    let finish!: (response: CurlResponse) => void;
    curl.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const active = run(evaluation);
    await expect(run(evaluation)).rejects.toThrow("one worker");
    finish(stream({ input_tokens: 0, output_tokens: 0 }));
    await active;
  });
});
