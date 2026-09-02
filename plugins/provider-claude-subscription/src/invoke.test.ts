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

  it("passes the declared proxy through and never inherits one", async () => {
    reply(200, { content: [] });
    await invokeClaude({ ...CALL, proxy: "http://127.0.0.1:7897" });
    expect(sent().proxy).toBe("http://127.0.0.1:7897");

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
