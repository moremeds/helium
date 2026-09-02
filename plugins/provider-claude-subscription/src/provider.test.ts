import { describe, expect, it, vi } from "vitest";
import type { EgressVerdict } from "@helium/provider-sdk/probe";

const probeEgress = vi.hoisted(() =>
  vi.fn<(i: { url: string; proxy?: string }) => Promise<EgressVerdict>>(),
);
vi.mock("@helium/provider-sdk/probe", () => ({ probeEgress }));

const { ClaudeSubscriptionProvider, CLAUDE_OVERHEAD_TOKENS, sessionLog } =
  await import("./provider.js");

const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" };

describe("ClaudeSubscriptionProvider", () => {
  it("registers every model as unmetered, never as zero-priced", () => {
    // A subscription bills a month. Priced at 0 it would outrank every metered
    // model in the router for a reason that is not true.
    const provider = new ClaudeSubscriptionProvider(TOKEN);
    expect(provider.models.every((m) => m.unmetered === true)).toBe(true);
    expect(provider.overheadTokens).toBe(CLAUDE_OVERHEAD_TOKENS);
  });

  it("takes the smallest model that covers the request", () => {
    const provider = new ClaudeSubscriptionProvider(TOKEN);
    expect(provider.select({ role: "r", requires: ["cheap.bulk"] }).model).toBe(
      "claude-haiku-4-5-20251001",
    );
    const deep = provider.select({ role: "r", requires: ["reason.deep"] });
    expect(deep.model).toBe("claude-sonnet-5");
    // Extended thinking costs tokens, so it is asked for only when required.
    expect(deep.effort).toBe("high");
    expect(
      provider.select({ role: "r", requires: ["cheap.bulk"] }).effort,
    ).toBeUndefined();
  });

  it("refuses to route a request no model covers", () => {
    expect(() =>
      new ClaudeSubscriptionProvider(TOKEN).select({
        role: "auditor",
        requires: ["vision.ocr"],
      }),
    ).toThrow(/no model covering \[vision.ocr\] for role auditor/);
  });

  it("names the missing credential without sending a request", async () => {
    const provider = new ClaudeSubscriptionProvider({});
    expect(await provider.probe()).toBe(false);
    expect(provider.probeReason()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(probeEgress).not.toHaveBeenCalled();
  });

  it("reports a blocked egress as blocked, not as an auth failure", async () => {
    // The whole point of the control request: 403 before auth is a network
    // fault, and no credential would have changed it.
    probeEgress.mockResolvedValue({
      reachable: false,
      reason: "answered 403 to an unauthenticated request",
    });
    const provider = new ClaudeSubscriptionProvider({
      ...TOKEN,
      HELIUM_PROXY: "http://127.0.0.1:7897",
    });
    expect(await provider.probe()).toBe(false);
    expect(provider.probeReason()).toContain("403");
    expect(probeEgress.mock.calls[0]?.[0].proxy).toBe("http://127.0.0.1:7897");
  });

  it("is live when the vendor evaluated auth at all", async () => {
    probeEgress.mockResolvedValue({ reachable: true });
    expect(await new ClaudeSubscriptionProvider(TOKEN).probe()).toBe(true);
  });

  it("logs the tokens the wire reported and nothing else", () => {
    const events = sessionLog(1_000, {
      input_tokens: 40,
      output_tokens: 4,
      cache_read_input_tokens: 7,
    });
    expect(events[0]).toMatchObject({ type: "step/start", data: { turn: 1, step: 1 } });
    expect(events[1]).toMatchObject({
      type: "assistant/message",
      data: { usage: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 7 } },
    });
    // An absent count is 0, never an invented estimate.
    expect(sessionLog(1_000, {})[1]).toMatchObject({
      data: { usage: { inputTokens: 0, outputTokens: 0 } },
    });
  });

  it("refuses a work order that asks for tools instead of silently dropping them", async () => {
    // The request carries no `tools`, so the model cannot call one. A role that
    // ordered tools and got a model without any is the failure this prevents.
    const work = {
      role: "prober",
      constraints: { tools: ["fs.read"] },
      inputs: { prompt: "hi", artifacts: [] },
    } as never;
    await expect(
      new ClaudeSubscriptionProvider(TOKEN).run(work, { targetId: "t" as never, model: "m" }, new AbortController().signal),
    ).rejects.toThrow(/claude-subscription performs inference only; 1 tool\(s\)/);
  });
});
