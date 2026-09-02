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

  it("routes each tier to the model it is actually the right answer for", async () => {
    // The tag overlap that used to hide opus: `select` takes the FIRST covering
    // model, so sonnet claiming `reason.deep` made opus unreachable.
    const provider = new ClaudeSubscriptionProvider(TOKEN);
    expect(provider.select({ role: "r", requires: ["cheap.bulk"] })).toEqual({
      targetId: "claude-subscription:claude-haiku-4-5-20251001",
      model: "claude-haiku-4-5-20251001",
    });
    expect(provider.select({ role: "r", requires: ["code.edit"] })).toEqual({
      targetId: "claude-subscription:claude-sonnet-5",
      model: "claude-sonnet-5",
      effort: "medium",
    });
    expect(provider.select({ role: "r", requires: ["reason.deep"] })).toEqual({
      targetId: "claude-subscription:claude-opus-5",
      model: "claude-opus-5",
      effort: "high",
    });
  });

  it("spends no thinking tokens on a chore", () => {
    // Extended thinking is billed. A chore asks for none at all, rather than a
    // small amount that nobody decided to spend.
    expect(
      new ClaudeSubscriptionProvider(TOKEN).select({
        role: "r",
        requires: ["cheap.bulk"],
      }).effort,
    ).toBeUndefined();
  });

  it("puts all three tiers on one allowance", () => {
    // They are one subscription session: a 429 on any of them means the pool is
    // spent, so the runner must retire all three together.
    const domains = new Set(
      new ClaudeSubscriptionProvider(TOKEN).models.map((m) => m.quotaDomain),
    );
    expect(domains).toEqual(new Set(["claude-subscription-session"]));
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

  it("refuses a work order whose tool implementations never arrived", async () => {
    // The order names a tool and `selection.options.tools` is empty, so the
    // runner and the role manifest disagree. Running anyway would hand the
    // model a prompt about a tool it cannot call and return its apology as a
    // completed step — the exact silent degradation this provider must not
    // produce. The loop is not the licence to run degraded.
    const work = {
      role: "prober",
      constraints: { tools: ["fs.read"] },
      inputs: { prompt: "hi", artifacts: [] },
    } as never;
    await expect(
      new ClaudeSubscriptionProvider(TOKEN).run(
        work,
        { targetId: "t" as never, model: "m" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/declares 1 tool\(s\), 0 implementation\(s\) reached/);
  });
});

describe("declared capabilities match what run() will actually do", () => {
  it("the labour tiers claim tool.use, and the chore tier does not", () => {
    // The invariant, not the value: `tool.use` and a working tool loop move
    // together. It was removed when `run()` refused tools and is back now that
    // `invoke.ts` speaks the Messages API tool protocol; if the loop is ever
    // deleted, this test is what fails.
    const provider = new ClaudeSubscriptionProvider(TOKEN);
    const claimsTools = provider.models
      .filter((model) => model.caps.includes("tool.use"))
      .map((model) => model.id);
    expect(claimsTools).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(provider.capabilities).toContain("tool.use");
    // Every model is unmetered, so `select` takes the first covering entry —
    // a chore tier claiming tool.use would win every tool-using step.
    expect(
      provider.models.find((model) => model.caps.includes("cheap.bulk"))!.caps,
    ).not.toContain("tool.use");
  });
});
