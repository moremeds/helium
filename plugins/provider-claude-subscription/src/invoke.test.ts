import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurlRequest, CurlResponse } from "@helium/provider-sdk/curl";

const curl = vi.hoisted(() => vi.fn<(r: CurlRequest) => Promise<CurlResponse>>());
vi.mock("@helium/provider-sdk/curl", () => ({ curlPostJson: curl }));

const { invokeClaude } = await import("./invoke.js");

const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" };
const CALL = { model: "claude-sonnet-5", prompt: "hi", timeoutMs: 5_000, env: ENV };

function reply(status: number, body: unknown) {
  curl.mockResolvedValue({ status, body: JSON.stringify(body) });
}
function sent(): CurlRequest {
  const req = curl.mock.calls[0]?.[0];
  if (req === undefined) throw new Error("curl was never called");
  return req;
}

afterEach(() => curl.mockReset());

describe("invokeClaude", () => {
  it("sends the Claude Code identity as the first system block", async () => {
    // The subscription entitlement check. Without this exact string the OAuth
    // token is refused; see design 3.1.
    reply(200, {
      content: [{ type: "text", text: "READY" }],
      usage: { input_tokens: 26, output_tokens: 2 },
    });

    const out = await invokeClaude({ ...CALL, systemPrompt: "be terse" });

    expect(out).toMatchObject({ ok: true, text: "READY" });
    expect(out.runtimeSnapshot.modelUsage).toEqual({
      input_tokens: 26,
      output_tokens: 2,
    });
    const body = JSON.parse(sent().body);
    expect(body.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(body.system[1].text).toBe("be terse");
    expect(sent().headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    // The token travels as a secret header so it never reaches curl's argv.
    expect(sent().secretHeaders?.authorization).toEqual({
      prefix: "Bearer ",
      value: "sk-ant-oat01-test",
    });
    expect(JSON.stringify(sent().headers)).not.toContain("sk-ant-oat01-test");
  });

  it("classifies 403 as proxy, never as auth", async () => {
    // The regression this rewrite exists for: Anthropic answers 403 before
    // evaluating auth when egress is blocked, and the CLI wording
    // ("Failed to authenticate ... 403") used to classify as auth, sending
    // every investigation after the credentials instead of the network.
    reply(403, { error: { type: "forbidden", message: "Request not allowed" } });
    await expect(invokeClaude(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "proxy",
    });
  });

  it("classifies 401 as auth and 429 as quota-exhausted", async () => {
    reply(401, { error: { message: "invalid token" } });
    await expect(invokeClaude(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "auth",
    });

    curl.mockReset();
    reply(429, { error: { message: "rate limited", retry_after: "42" } });
    await expect(invokeClaude(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "quota-exhausted",
      retryAfter: "42",
    });
  });

  it("fails as auth without spending a request when the env has no token", async () => {
    const out = await invokeClaude({ ...CALL, env: {} });
    expect(out).toMatchObject({ ok: false, classification: "auth" });
    expect(curl).not.toHaveBeenCalled();
  });

  it("maps effort to a thinking budget and omits thinking at low", async () => {
    reply(200, { content: [] });
    await invokeClaude({ ...CALL, effort: "high" });
    const body = JSON.parse(sent().body);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
    expect(body.max_tokens).toBeGreaterThan(10_000);

    curl.mockReset();
    reply(200, { content: [] });
    const out = await invokeClaude({ ...CALL, effort: "low" });
    expect(JSON.parse(sent().body).thinking).toBeUndefined();
    expect(out.runtimeSnapshot).toMatchObject({
      requestedEffort: "low",
      effectiveEffort: "low",
    });
  });

  it("takes the proxy from the declared env and never inherits one", async () => {
    reply(200, { content: [] });
    await invokeClaude({
      ...CALL,
      env: { ...ENV, HELIUM_PROXY: "http://127.0.0.1:7897" },
    });
    expect(sent().proxy).toBe("http://127.0.0.1:7897");

    // No declared proxy means no --proxy flag, never a fallback to an ambient
    // https_proxy: the mini's direct egress is refused before auth, and a
    // silent fallback is what made that look like a credential fault.
    curl.mockReset();
    reply(200, { content: [] });
    await invokeClaude(CALL);
    expect(sent().proxy).toBeUndefined();
  });

  it("reports transport, timeout and cancellation distinctly", async () => {
    for (const [terminal, expected] of [
      ["transport", "proxy"],
      ["timeout", "timeout"],
      ["cancelled", "cancelled"],
    ] as const) {
      curl.mockReset();
      curl.mockResolvedValue({ status: 0, body: "", terminal, error: "ECONNREFUSED" });
      await expect(invokeClaude(CALL)).resolves.toMatchObject({
        ok: false,
        classification: expected,
      });
    }
  });
});

describe("the tool loop", () => {
  // Not a market tool: this exercises the loop, and putting prices in it would
  // be inventing data to test plumbing that does not care what the data is.
  const echo = {
    name: "echo_args",
    description: "Returns its arguments as JSON.",
    dshParams: { word: { type: "string", required: true as const, description: "any word" } },
    paramsSchema: {} as never,
    mutating: false,
    run: async (args: Record<string, unknown>) => JSON.stringify(args),
  };

  it("runs the tool, feeds the result back, and bills both turns", async () => {
    curl
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu_01", name: "echo_args", input: { word: "helium" } },
          ],
          usage: { input_tokens: 40, output_tokens: 12 },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 90, output_tokens: 5 },
        }),
      });

    const out = await invokeClaude({ ...CALL, tools: [echo] });

    expect(out).toMatchObject({ ok: true, turns: 2 });
    expect(out.text).toBe("checking\ndone");
    // Both turns are billed. Folding only the last would report a chatty tool
    // loop as the cost of one answer.
    expect(out.runtimeSnapshot.modelUsage).toEqual({
      input_tokens: 130,
      output_tokens: 17,
    });

    // The first request declares the tool with its dshParams as JSON Schema.
    const first = JSON.parse(curl.mock.calls[0]![0].body);
    expect(first.tools).toEqual([
      {
        name: "echo_args",
        description: "Returns its arguments as JSON.",
        input_schema: {
          type: "object",
          properties: { word: { type: "string", description: "any word" } },
          required: ["word"],
        },
      },
    ]);

    // The second carries the assistant turn VERBATIM plus the tool result.
    const second = JSON.parse(curl.mock.calls[1]![0].body);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "toolu_01", name: "echo_args", input: { word: "helium" } },
      ],
    });
    expect(second.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: JSON.stringify({ word: "helium" }),
    });

    // The audit fold reads the call id at `message.source.callId`; getting that
    // path wrong once meant every tool call ran and none appeared in the table.
    const call = out.events!.find((e) => e.type === "tool/call");
    const result = out.events!.find((e) => e.type === "tool/result");
    expect(call!.data).toMatchObject({ callId: "toolu_01", name: "echo_args" });
    expect(result!.data).toMatchObject({ message: { source: { callId: "toolu_01" } } });
  });

  it("reports a throwing tool to the model instead of failing the step", async () => {
    const broken = { ...echo, name: "broken", run: async () => { throw new Error("endpoint 502"); } };
    curl
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          content: [{ type: "tool_use", id: "toolu_02", name: "broken", input: {} }],
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          content: [{ type: "text", text: "the tool is down, proceeding without it" }],
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
      });

    const out = await invokeClaude({ ...CALL, tools: [broken] });

    expect(out.ok).toBe(true);
    const second = JSON.parse(curl.mock.calls[1]![0].body);
    expect(second.messages[2].content[0]).toMatchObject({
      is_error: true,
      content: "broken failed: endpoint 502",
    });
  });

  it("stops at the turn ceiling and says the answer is partial", async () => {
    // A model that keeps calling tools re-sends the whole transcript each turn,
    // so an unbounded loop is quadratic against a metered API.
    curl.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        content: [{ type: "tool_use", id: "toolu_loop", name: "echo_args", input: { word: "again" } }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    });

    const out = await invokeClaude({ ...CALL, tools: [echo] });

    expect(out.turns).toBe(8);
    expect(curl).toHaveBeenCalledTimes(8);
    expect(out.text).toContain("stopped after 8 tool turns");
  });
});
