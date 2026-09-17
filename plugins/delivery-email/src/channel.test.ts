import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import channel_, { DEFAULT_FROM, EmailChannel, resendFromEnv } from "./channel.js";

const RESEND = { apiKey: "re_test", from: "helium <helium@example.test>" };
const CONFIG = { to: "ops@example.test", subjectPrefix: "[helium]", maxPerDay: 2 };

// `day` is the runner's, resolved once in the tenant's report zone. The cap
// counts against THAT day, so a channel clock reading a different midnight
// cannot ration one day's mail against another day's count.
function payload(runId = "r1", day = "2026-09-02") {
  return { tenant: "demo", runId, subject: "daily", body: "body", day };
}

const ok = () => ({ status: 200, text: async () => JSON.stringify({ id: "em_1" }) });
const reject = (status: number, name: string, message: string) => ({
  status,
  text: async () => JSON.stringify({ statusCode: status, name, message }),
});

function channel(post: ReturnType<typeof vi.fn>, env: NodeJS.ProcessEnv = {}) {
  return new EmailChannel({
    stateDir: mkdtempSync(join(tmpdir(), "helium-email-")),
    resend: RESEND,
    env,
    sleep: async () => {},
    fetch: post,
  });
}

describe("EmailChannel", () => {
  it("is exported as an instance, which is what discovery imports", () => {
    // Exporting the class passes `typeof … === "function"` on the constructor
    // and then fails on `.deliver`, so discovery drops it as "default export is
    // not a Channel". This file did exactly that for its whole life: the plugin
    // had seven green tests and had never been loaded by a run.
    expect(typeof channel_.deliver).toBe("function");
    expect(channel_.id).toBe("email");
    expect(channel_.external).toBe(true);
  });

  it("skips rather than throwing when no RESEND_HELIUM_TOKEN is configured", async () => {
    const c = new EmailChannel({ stateDir: mkdtempSync(join(tmpdir(), "e-")), resend: null });
    await expect(c.deliver(payload(), CONFIG)).resolves.toEqual({
      state: "skipped",
      detail: "no RESEND_HELIUM_TOKEN configured",
    });
  });

  it("sends and applies the subject prefix", async () => {
    const post = vi.fn().mockResolvedValue(ok());
    const outcome = await channel(post).deliver(payload(), CONFIG);
    expect(outcome.state).toBe("sent");
    expect(post.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(post.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Idempotency-Key": "demo/r1",
    });
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).toMatchObject({
      to: "ops@example.test",
      subject: "[helium] daily",
      from: "helium <helium@example.test>",
    });
  });

  it("caps at maxPerDay per tenant per day", async () => {
    const post = vi.fn().mockResolvedValue(ok());
    const c = channel(post);
    expect((await c.deliver(payload("a"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("b"), CONFIG)).state).toBe("sent");
    const third = await c.deliver(payload("c"), CONFIG);
    expect(third.state).toBe("rate-capped");
    expect(third.detail).toBe("2/2 already sent today");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("counts against the payload's day, so the next report day starts clean", async () => {
    // The two days below are one calendar day apart in the tenant's report
    // zone. Before the day came from the payload this channel read its own
    // clock, and a run whose report was filed on 2026-09-02 could be capped
    // against 2026-09-03's count.
    const post = vi.fn().mockResolvedValue(ok());
    const c = channel(post);
    expect((await c.deliver(payload("a", "2026-09-02"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("b", "2026-09-02"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("c", "2026-09-02"), CONFIG)).state).toBe("rate-capped");
    expect((await c.deliver(payload("d", "2026-09-03"), CONFIG)).state).toBe("sent");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("retries three times then reports failed, and does not consume the cap", async () => {
    const post = vi.fn().mockRejectedValue(new Error("connection refused"));
    const c = channel(post);
    const outcome = await c.deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "failed", detail: "connection refused" });
    expect(post).toHaveBeenCalledTimes(3);
    post.mockResolvedValue(ok());
    expect((await c.deliver(payload("next"), CONFIG)).state).toBe("sent");
  });

  it("sends on a later attempt after transient failures", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(reject(429, "rate_limit_exceeded", "Too many requests"))
      .mockResolvedValueOnce(reject(429, "rate_limit_exceeded", "Too many requests"))
      .mockResolvedValue(ok());
    const outcome = await channel(post).deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "sent", detail: "attempt 3" });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("does not retry a rejected body", async () => {
    // A 4xx other than 429 is about the body — bad key, unverified sender,
    // invalid address — and the same body is rejected again. One call, then
    // the failure is reported with the reason the API gave.
    const post = vi
      .fn()
      .mockResolvedValue(reject(403, "validation_error", "The rsiarc.com domain is not verified"));
    const c = channel(post);
    const outcome = await c.deliver(payload(), CONFIG);
    expect(outcome).toEqual({
      state: "failed",
      detail: "HTTP 403: validation_error: The rsiarc.com domain is not verified",
    });
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValue(ok());
    expect((await c.deliver(payload("next"), CONFIG)).state).toBe("sent");
  });

  it("retries a 5xx, which is about the moment and not the body", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(reject(500, "internal_server_error", "x"))
      .mockResolvedValue(ok());
    const outcome = await channel(post).deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "sent", detail: "attempt 2" });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps one idempotency key across the attempts of one delivery", async () => {
    // A retry after a timeout could reach a Resend that already accepted the
    // first send: the same key on every attempt makes the repeat land on that
    // stored send instead of mailing a second briefing.
    const post = vi
      .fn()
      .mockResolvedValueOnce(reject(500, "internal_server_error", "x"))
      .mockResolvedValue(ok());
    await channel(post).deliver(payload(), CONFIG);
    expect(post.mock.calls[0]?.[1].headers["Idempotency-Key"]).toBe("demo/r1");
    expect(post.mock.calls[1]?.[1].headers["Idempotency-Key"]).toBe("demo/r1");
  });

  it("quotes a non-JSON error body rather than dropping it", async () => {
    // A proxy or an outage answers HTML, not Resend's `{name, message}` — the
    // detail still carries what came back, clipped by resendMessage.
    const post = vi
      .fn()
      .mockResolvedValue({ status: 502, text: async () => "<html>bad gateway</html>" });
    const outcome = await channel(post).deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "failed", detail: "HTTP 502: <html>bad gateway</html>" });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("reads Resend config from env keys and defaults the sender", () => {
    expect(resendFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resendFromEnv({ RESEND_HELIUM_TOKEN: "re_x" } as NodeJS.ProcessEnv)).toEqual({
      apiKey: "re_x",
      from: DEFAULT_FROM,
    });
    expect(
      resendFromEnv({
        RESEND_HELIUM_TOKEN: "re_x",
        HELIUM_EMAIL_FROM: "ops <ops@example.test>",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ from: "ops <ops@example.test>" });
  });

  it("refuses a config missing its address or cap", async () => {
    const c = channel(vi.fn());
    await expect(c.deliver(payload(), { maxPerDay: 1 })).rejects.toThrow(/`to` address/);
    await expect(c.deliver(payload(), { to: "x@y.test" })).rejects.toThrow(/maxPerDay/);
  });

  it("lets the environment lift the daily cap, which is how a laptop run is not rationed", async () => {
    // The manifest carries the production cap (the mini runs on a cron with
    // nobody watching); a laptop run is driven by hand, so it sets 0 and sends
    // as often as it is told to. Uncapped has to be SET, never the result of
    // forgetting to configure a cap.
    const post = vi.fn().mockResolvedValue(ok());
    const c = channel(post, { HELIUM_EMAIL_MAX_PER_DAY: "0" });
    for (let i = 0; i < 4; i += 1) {
      await expect(c.deliver(payload(`r${i}`), CONFIG)).resolves.toMatchObject({ state: "sent" });
    }
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("takes the recipient from the environment when the manifest names none", async () => {
    // option-wizard's tenant.yaml deliberately carries no address: the same
    // manifest is read on a laptop and on the mini, and only one of them should
    // mail a person.
    const post = vi.fn().mockResolvedValue(ok());
    const c = channel(post, { HELIUM_EMAIL_TO: "desk@example.test" });
    await expect(c.deliver(payload(), { maxPerDay: 1 })).resolves.toMatchObject({ state: "sent" });
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).toMatchObject({ to: "desk@example.test" });
  });

  it("prefers the tenant's rendered subject, text and html over the transcript", async () => {
    const post = vi.fn().mockResolvedValue(ok());
    const outcome = await channel(post).deliver(
      {
        ...payload(),
        rendered: {
          subject: "option-wizard 2026-09-02",
          text: "今日候选 5 个",
          html: "<table><tr><td>候选</td></tr></table>",
        },
      },
      CONFIG,
    );
    expect(outcome.state).toBe("sent");
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).toMatchObject({
      subject: "[helium] option-wizard 2026-09-02",
      text: "今日候选 5 个",
      html: "<table><tr><td>候选</td></tr></table>",
    });
  });

  it("keeps the runner's phase subject when the renderer minted none", async () => {
    // The option-wizard renderer deliberately emits no subject: it does not
    // know the phase, and the one it used to mint made the day's five mails
    // arrive under one indistinguishable line.
    const post = vi.fn().mockResolvedValue(ok());
    await channel(post).deliver(
      {
        ...payload(),
        subject: "[TEST] intraday 2026-09-03",
        rendered: { text: "今日候选 5 个" },
      },
      CONFIG,
    );
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).toMatchObject({
      subject: "[helium] [TEST] intraday 2026-09-03",
      text: "今日候选 5 个",
    });
  });

  it("sends text-only when the rendered form carries no html", async () => {
    const post = vi.fn().mockResolvedValue(ok());
    await channel(post).deliver(
      { ...payload(), rendered: { subject: "s", text: "plain only" } },
      CONFIG,
    );
    // An `html` key that is present but empty is not the same as no html at
    // all; a text-only render must omit the key, not blank it.
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).not.toHaveProperty("html");
    expect(JSON.parse(post.mock.calls[0]?.[1].body)).toMatchObject({ text: "plain only" });
  });
});
