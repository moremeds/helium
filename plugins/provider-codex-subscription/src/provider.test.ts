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

  it("routes each tier to the model it is actually the right answer for", () => {
    const provider = new CodexSubscriptionProvider(TOKEN);
    expect(provider.select({ role: "r", requires: ["cheap.bulk"] })).toMatchObject({
      model: "gpt-5.3-codex-spark",
      effort: "low",
    });
    expect(provider.select({ role: "r", requires: ["code.edit"] })).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "medium",
    });
    expect(provider.select({ role: "r", requires: ["reason.deep"] })).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  it("keeps spark on its own allowance so it outlives the main pool", () => {
    // Spark's separate quota, not its price, is why it is in the menu: it is
    // still there when the subscription session is spent.
    const byId = new Map(
      new CodexSubscriptionProvider(TOKEN).models.map((m) => [m.id, m.quotaDomain]),
    );
    expect(byId.get("gpt-5.3-codex-spark")).toBe("codex-spark");
    expect(byId.get("gpt-5.6-luna")).toBe("codex-subscription-session");
    expect(byId.get("gpt-5.6-sol")).toBe("codex-subscription-session");
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

  it("refuses a work order whose tool implementations never arrived", async () => {
    // The order names a tool and `selection.options.tools` is empty, so the
    // runner and the role manifest disagree. Running anyway would return the
    // model's apology as a completed step. The loop is not a licence to run
    // degraded.
    const work = {
      role: "prober",
      constraints: { tools: ["fs.read"] },
      inputs: { prompt: "hi", artifacts: [] },
    } as never;
    await expect(
      new CodexSubscriptionProvider(TOKEN).run(
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
    // `invoke.ts` speaks the Responses API function-call protocol; delete the
    // loop and this test fails.
    const provider = new CodexSubscriptionProvider(TOKEN);
    const claimsTools = provider.models
      .filter((model) => model.caps.includes("tool.use"))
      .map((model) => model.id);
    expect(claimsTools).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(provider.capabilities).toContain("tool.use");
    // Every model is unmetered, so `select` takes the first covering entry —
    // a chore tier claiming tool.use would win every tool-using step.
    expect(
      provider.models.find((model) => model.caps.includes("cheap.bulk"))!.caps,
    ).not.toContain("tool.use");
  });
});
