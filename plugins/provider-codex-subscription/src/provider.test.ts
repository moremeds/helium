import { describe, expect, it, vi } from "vitest";
import type { EgressVerdict } from "@helium/provider-sdk/probe";

const probeEgress = vi.hoisted(() =>
  vi.fn<(i: { url: string; proxy?: string }) => Promise<EgressVerdict>>(),
);
vi.mock("@helium/provider-sdk/probe", () => ({ probeEgress }));

const { CodexSubscriptionProvider, CODEX_OVERHEAD_TOKENS, sessionLog } =
  await import("./provider.js");

const TOKEN = { CODEX_ACCESS_TOKEN: "header.payload.sig" };

describe("CodexSubscriptionProvider", () => {
  it("registers every model as unmetered, never as zero-priced", () => {
    const provider = new CodexSubscriptionProvider(TOKEN);
    expect(provider.models.every((m) => m.unmetered === true)).toBe(true);
    expect(provider.overheadTokens).toBe(CODEX_OVERHEAD_TOKENS);
  });

  it("takes the smallest covering model and always states an effort", () => {
    // Unlike Anthropic's, this API has no "no effort" setting, so the fast case
    // is an explicit floor rather than an omitted field.
    const provider = new CodexSubscriptionProvider(TOKEN);
    expect(provider.select({ role: "r", requires: ["cheap.bulk"] })).toMatchObject({
      model: "gpt-5.4-mini",
      effort: "low",
    });
    expect(provider.select({ role: "r", requires: ["reason.deep"] })).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  it("refuses to route a request no model covers", () => {
    expect(() =>
      new CodexSubscriptionProvider(TOKEN).select({
        role: "auditor",
        requires: ["vision.ocr"],
      }),
    ).toThrow(/no model covering \[vision.ocr\] for role auditor/);
  });

  it("names the missing credential without sending a request", async () => {
    const provider = new CodexSubscriptionProvider({});
    expect(await provider.probe()).toBe(false);
    expect(provider.probeReason()).toContain("CODEX_ACCESS_TOKEN");
    expect(probeEgress).not.toHaveBeenCalled();
  });

  it("reports a blocked egress as blocked, not as an auth failure", async () => {
    probeEgress.mockResolvedValue({
      reachable: false,
      reason: "answered 403 to an unauthenticated request",
    });
    const provider = new CodexSubscriptionProvider({
      ...TOKEN,
      HELIUM_PROXY: "http://127.0.0.1:7897",
    });
    expect(await provider.probe()).toBe(false);
    expect(provider.probeReason()).toContain("403");
    expect(probeEgress.mock.calls[0]?.[0].proxy).toBe("http://127.0.0.1:7897");
  });

  it("logs the tokens the stream reported and nothing else", () => {
    expect(sessionLog(1_000, { inputTokens: 21, outputTokens: 5 })[1]).toMatchObject({
      type: "assistant/message",
      data: { turn: 1, step: 1, usage: { inputTokens: 21, outputTokens: 5 } },
    });
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
      new CodexSubscriptionProvider(TOKEN).run(work, { targetId: "t" as never, model: "m" }, new AbortController().signal),
    ).rejects.toThrow(/codex-subscription performs inference only; 1 tool\(s\)/);
  });
});
