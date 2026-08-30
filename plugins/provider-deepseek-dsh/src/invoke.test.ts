import { describe, expect, it, vi } from "vitest";
import { invokeDeepSeek, type DeepSeekDshBoundary } from "./invoke.js";

describe("invokeDeepSeek", () => {
  it("passes the exact native model and effort through DSH agentOptions", async () => {
    const run = vi.fn<DeepSeekDshBoundary["run"]>().mockResolvedValue({
      text: "DEEPSEEK_OK",
      usage: { inputTokens: 10, outputTokens: 2 },
      providerMetadata: { requestId: "request-1" },
    });
    const out = await invokeDeepSeek({
      model: "deepseek-v4-pro",
      effort: "max",
      prompt: "PROMPTBODY",
      workspace: "/tmp/owned-workspace",
      allowedTools: ["artifact_read"],
      maxTokens: 4_096,
      signal: new AbortController().signal,
      boundary: { run },
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentOptions: {
          provider: "deepseek-official",
          model: "deepseek-v4-pro",
          reasoningEffort: "max",
          maxTokens: 4_096,
        },
        workspace: "/tmp/owned-workspace",
        allowedTools: ["artifact_read"],
      }),
    );
    expect(out.runtimeSnapshot).toMatchObject({
      requestedModel: "deepseek-v4-pro",
      requestedEffort: "max",
      effectiveEffort: "max",
      providerMetadata: { requestId: "request-1" },
    });
  });
});
