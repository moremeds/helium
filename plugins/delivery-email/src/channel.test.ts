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

function channel(send: ReturnType<typeof vi.fn>, env: NodeJS.ProcessEnv = {}) {
  return new EmailChannel({
    stateDir: mkdtempSync(join(tmpdir(), "helium-email-")),
    resend: RESEND,
    env,
    sleep: async () => {},
    send,
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
    const send = vi.fn().mockResolvedValue({});
    const outcome = await channel(send).deliver(payload(), CONFIG);
    expect(outcome.state).toBe("sent");
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "ops@example.test",
      subject: "[helium] daily",
      from: "helium <helium@example.test>",
    });
  });

  it("caps at maxPerDay per tenant per day", async () => {
    const send = vi.fn().mockResolvedValue({});
    const c = channel(send);
    expect((await c.deliver(payload("a"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("b"), CONFIG)).state).toBe("sent");
    const third = await c.deliver(payload("c"), CONFIG);
    expect(third.state).toBe("rate-capped");
    expect(third.detail).toBe("2/2 already sent today");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("counts against the payload's day, so the next report day starts clean", async () => {
    // The two days below are one calendar day apart in the tenant's report
    // zone. Before the day came from the payload this channel read its own
    // clock, and a run whose report was filed on 2026-09-02 could be capped
    // against 2026-09-03's count.
    const send = vi.fn().mockResolvedValue({});
    const c = channel(send);
    expect((await c.deliver(payload("a", "2026-09-02"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("b", "2026-09-02"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("c", "2026-09-02"), CONFIG)).state).toBe("rate-capped");
    expect((await c.deliver(payload("d", "2026-09-03"), CONFIG)).state).toBe("sent");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("retries three times then reports failed, and does not consume the cap", async () => {
    const send = vi.fn().mockRejectedValue(new Error("connection refused"));
    const c = channel(send);
    const outcome = await c.deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "failed", detail: "connection refused" });
    expect(send).toHaveBeenCalledTimes(3);
    send.mockResolvedValue({});
    expect((await c.deliver(payload("next"), CONFIG)).state).toBe("sent");
  });

  it("sends on a later attempt after transient failures", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate_limit_exceeded"))
      .mockRejectedValueOnce(new Error("rate_limit_exceeded"))
      .mockResolvedValue({});
    const outcome = await channel(send).deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "sent", detail: "attempt 3" });
    expect(send).toHaveBeenCalledTimes(3);
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
    const send = vi.fn().mockResolvedValue({});
    const c = channel(send, { HELIUM_EMAIL_MAX_PER_DAY: "0" });
    for (let i = 0; i < 4; i += 1) {
      await expect(c.deliver(payload(`r${i}`), CONFIG)).resolves.toMatchObject({ state: "sent" });
    }
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("takes the recipient from the environment when the manifest names none", async () => {
    // option-wizard's tenant.yaml deliberately carries no address: the same
    // manifest is read on a laptop and on the mini, and only one of them should
    // mail a person.
    const send = vi.fn().mockResolvedValue({});
    const c = channel(send, { HELIUM_EMAIL_TO: "desk@example.test" });
    await expect(c.deliver(payload(), { maxPerDay: 1 })).resolves.toMatchObject({ state: "sent" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: "desk@example.test" });
  });

  it("prefers the tenant's rendered subject, text and html over the transcript", async () => {
    const send = vi.fn().mockResolvedValue({});
    const outcome = await channel(send).deliver(
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
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: "[helium] option-wizard 2026-09-02",
      text: "今日候选 5 个",
      html: "<table><tr><td>候选</td></tr></table>",
    });
  });

  it("keeps the runner's phase subject when the renderer minted none", async () => {
    // The option-wizard renderer deliberately emits no subject: it does not
    // know the phase, and the one it used to mint made the day's five mails
    // arrive under one indistinguishable line.
    const send = vi.fn().mockResolvedValue({});
    await channel(send).deliver(
      {
        ...payload(),
        subject: "[TEST] intraday 2026-09-03",
        rendered: { text: "今日候选 5 个" },
      },
      CONFIG,
    );
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: "[helium] [TEST] intraday 2026-09-03",
      text: "今日候选 5 个",
    });
  });

  it("sends text-only when the rendered form carries no html", async () => {
    const send = vi.fn().mockResolvedValue({});
    await channel(send).deliver(
      { ...payload(), rendered: { subject: "s", text: "plain only" } },
      CONFIG,
    );
    // An `html` key that is present but empty is not the same as no html at
    // all; a text-only render must omit the key, not blank it.
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("html");
    expect(send.mock.calls[0]?.[0]).toMatchObject({ text: "plain only" });
  });
});
