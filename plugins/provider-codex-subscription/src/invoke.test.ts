import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurlRequest, CurlResponse } from "@helium/provider-sdk/curl";

const curl = vi.hoisted(() =>
  vi.fn<(r: CurlRequest) => Promise<CurlResponse>>(),
);
vi.mock("@helium/provider-sdk/curl", () => ({ curlPostJson: curl }));

const { invokeCodex } = await import("./invoke.js");

/** A structurally real JWT with no signature: only the claim is read. */
function jwt(accountId: string | undefined): string {
  const claims =
    accountId === undefined
      ? {}
      : { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const ENV = { CODEX_ACCESS_TOKEN: jwt("acct-0191") };
const CALL = {
  model: "gpt-5.6-sol",
  effort: "low" as const,
  prompt: "hi",
  timeoutMs: 5_000,
  env: ENV,
};

function sse(...events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}
function stream(body: string, status = 200) {
  curl.mockResolvedValue({ status, body });
}
function sent(): CurlRequest {
  const req = curl.mock.calls[0]?.[0];
  if (req === undefined) throw new Error("curl was never called");
  return req;
}

afterEach(() => curl.mockReset());

describe("invokeCodex", () => {
  it("posts to the ChatGPT backend with the account id taken from the token", async () => {
    stream(
      sse(
        { type: "response.output_text.delta", delta: "REA" },
        { type: "response.output_text.delta", delta: "DY" },
        { response: { usage: { input_tokens: 30, output_tokens: 2 } } },
      ),
    );

    const out = await invokeCodex(CALL);

    expect(out).toMatchObject({ ok: true, text: "READY" });
    expect(out.runtimeSnapshot.usage).toEqual({
      inputTokens: 30,
      outputTokens: 2,
    });
    expect(sent().url).toBe("https://chatgpt.com/backend-api/codex/responses");
    // Subscription billing lives on this backend; api.openai.com would bill the
    // API account instead, which is the cost this provider exists to avoid.
    expect(sent().secretHeaders?.["chatgpt-account-id"]?.value).toBe(
      "acct-0191",
    );
    expect(sent().secretHeaders?.authorization?.value).toBe(
      ENV.CODEX_ACCESS_TOKEN,
    );

    const body = JSON.parse(sent().body);
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      reasoning: { effort: "low" },
    });
    expect(body.input[0].content[0].text).toBe("hi");
  });

  it("survives the in-progress events that carry a null usage", async () => {
    // Found by a live call: the stream sends `response.usage: null` while the
    // response is still in progress, which an `!== undefined` guard lets past.
    stream(
      sse(
        { type: "response.created", response: { usage: null } },
        { type: "response.output_text.delta", delta: "READY" },
        { response: { usage: { input_tokens: 30, output_tokens: 2 } } },
      ),
    );
    const out = await invokeCodex(CALL);
    expect(out).toMatchObject({ ok: true, text: "READY" });
    expect(out.runtimeSnapshot.usage).toEqual({
      inputTokens: 30,
      outputTokens: 2,
    });
  });

  it("keeps the secret out of plain headers", async () => {
    stream(sse());
    await invokeCodex(CALL);
    expect(JSON.stringify(sent().headers)).not.toContain(
      ENV.CODEX_ACCESS_TOKEN,
    );
  });

  it("classifies 403 as proxy and 401 as auth", async () => {
    stream("", 403);
    await expect(invokeCodex(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "proxy",
    });

    curl.mockReset();
    stream("", 401);
    await expect(invokeCodex(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "auth",
    });
  });

  it("fails as auth, unsent, when the token is missing or carries no account", async () => {
    await expect(invokeCodex({ ...CALL, env: {} })).resolves.toMatchObject({
      ok: false,
      classification: "auth",
    });
    await expect(
      invokeCodex({ ...CALL, env: { CODEX_ACCESS_TOKEN: jwt(undefined) } }),
    ).resolves.toMatchObject({ ok: false, classification: "auth" });
    expect(curl).not.toHaveBeenCalled();
  });

  it("does not read quota exhaustion out of successful answer text", async () => {
    // Kept from the CLI-era suite: the old implementation regexed the whole
    // output blob, so a model explaining rate limits looked like a rate limit.
    stream(
      sse({
        type: "response.output_text.delta",
        delta: "A 429 means your quota is exhausted; usage limit applies.",
      }),
    );
    await expect(invokeCodex(CALL)).resolves.toMatchObject({ ok: true });
  });

  it("treats a rate-limit error inside a 200 stream as quota exhaustion", async () => {
    stream(sse({ type: "error", error: { message: "rate limit reached" } }));
    await expect(invokeCodex(CALL)).resolves.toMatchObject({
      ok: false,
      classification: "quota-exhausted",
    });
  });

  it("passes the declared proxy through and never inherits one", async () => {
    stream(sse());
    await invokeCodex({ ...CALL, proxy: "http://127.0.0.1:7897" });
    expect(sent().proxy).toBe("http://127.0.0.1:7897");

    curl.mockReset();
    stream(sse());
    await invokeCodex(CALL);
    expect(sent().proxy).toBeUndefined();
  });

  it("reports transport, timeout and cancellation distinctly", async () => {
    for (const [terminal, expected] of [
      ["transport", "proxy"],
      ["timeout", "timeout"],
      ["cancelled", "cancelled"],
    ] as const) {
      curl.mockReset();
      curl.mockResolvedValue({ status: 0, body: "", terminal });
      await expect(invokeCodex(CALL)).resolves.toMatchObject({
        ok: false,
        classification: expected,
      });
    }
  });
});
