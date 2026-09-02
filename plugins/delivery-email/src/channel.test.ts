import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EmailChannel, smtpFromEnv } from "./channel.js";

const SMTP = { host: "smtp.example.test", port: 587, secure: false, from: "helium@example.test" };
const CONFIG = { to: "ops@example.test", subjectPrefix: "[helium]", maxPerDay: 2 };

function payload(runId = "r1") {
  return { tenant: "demo", runId, subject: "daily", body: "body" };
}

function channel(sendMail: ReturnType<typeof vi.fn>) {
  return new EmailChannel({
    stateDir: mkdtempSync(join(tmpdir(), "helium-email-")),
    smtp: SMTP,
    now: () => new Date("2026-09-02T12:00:00Z"),
    sleep: async () => {},
    transport: { sendMail } as never,
  });
}

describe("EmailChannel", () => {
  it("skips rather than throwing when no SMTP is configured", async () => {
    const c = new EmailChannel({ stateDir: mkdtempSync(join(tmpdir(), "e-")), smtp: null });
    await expect(c.deliver(payload(), CONFIG)).resolves.toEqual({
      state: "skipped",
      detail: "no SMTP configured",
    });
  });

  it("sends and applies the subject prefix", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const outcome = await channel(sendMail).deliver(payload(), CONFIG);
    expect(outcome.state).toBe("sent");
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      to: "ops@example.test",
      subject: "[helium] daily",
      from: "helium@example.test",
    });
  });

  it("caps at maxPerDay per tenant per day", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const c = channel(sendMail);
    expect((await c.deliver(payload("a"), CONFIG)).state).toBe("sent");
    expect((await c.deliver(payload("b"), CONFIG)).state).toBe("sent");
    const third = await c.deliver(payload("c"), CONFIG);
    expect(third.state).toBe("rate-capped");
    expect(third.detail).toBe("2/2 already sent today");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("retries three times then reports failed, and does not consume the cap", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("connection refused"));
    const c = channel(sendMail);
    const outcome = await c.deliver(payload(), CONFIG);
    expect(outcome).toEqual({ state: "failed", detail: "connection refused" });
    expect(sendMail).toHaveBeenCalledTimes(3);
    sendMail.mockResolvedValue({});
    expect((await c.deliver(payload("next"), CONFIG)).state).toBe("sent");
  });

  it("reads SMTP config from env keys and never invents a host", () => {
    expect(smtpFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(smtpFromEnv({ SMTP_HOST: "h" } as NodeJS.ProcessEnv)).toMatchObject({
      host: "h", port: 587, secure: false, from: "helium@h",
    });
  });

  it("refuses a config missing its address or cap", async () => {
    const c = channel(vi.fn());
    await expect(c.deliver(payload(), { maxPerDay: 1 })).rejects.toThrow(/`to` address/);
    await expect(c.deliver(payload(), { to: "x@y.test" })).rejects.toThrow(/maxPerDay/);
  });
});
