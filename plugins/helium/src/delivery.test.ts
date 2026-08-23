import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlWriter } from "@helium/core";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { ev, job } from "./testing/fixtures.js";

function rig(opts: { failures?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "helium-deliver-"));
  const jsonlDir = join(root, "jsonl");
  const reportsDir = join(root, "reports");
  const sent: Record<string, unknown>[] = [];
  let failures = opts.failures ?? 0;
  const transport = {
    sendMail: async (mail: Record<string, unknown>) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("smtp 421 try later");
      }
      sent.push(mail);
      return { envelope: {}, messageId: "x", message: JSON.stringify(mail) };
    },
  };
  const delivery = new Delivery({
    jsonl: new JsonlWriter(jsonlDir),
    jsonlDir,
    reportsDir,
    emailTo: "ops@example.com",
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "helium@example.com",
    },
    transport: transport as never,
    sleep: async () => {},
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  const rows = (stream: string) =>
    readFileSync(join(jsonlDir, `${stream}-2026-08-23.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { delivery, jsonlDir, reportsDir, sent, rows };
}

const senior = {
  runId: "r1",
  tier: "senior" as const,
  outcome: "run_completed" as const,
  verdict: { escalate: true, severity: "material" as const, reason: "flip" },
  analysis: "# Macro update\n\nThe long end is repricing.",
};

describe("smtpFromEnv", () => {
  it("builds a config from SMTP_* keys and returns null when the host is missing", () => {
    expect(
      smtpFromEnv({
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "ops",
        SMTP_PASS: "p",
        SMTP_FROM: "helium@example.com",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "ops",
      pass: "p",
      from: "helium@example.com",
    });
    expect(smtpFromEnv({ SMTP_PORT: "587" })).toBeNull();
  });
});

describe("Delivery", () => {
  // JsonlWriter names its dated files from the real system clock, not
  // an injected one — freeze it to match rig()'s injected `now` so file
  // naming and the `rows()` helper below agree deterministically
  // (matches the convention in packages/core/tests/jsonl.spec.ts).
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the JSONL row before anything else, then a report, then the email", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig();
    await r.delivery.deliver(job, ev, senior);
    const rows = r.rows("deliveries");
    expect(rows[0]).toMatchObject({
      job: "macro-watch",
      tier: "senior",
      email: "sent",
    });
    const reportPath = rows[0]!.report as string;
    expect(readFileSync(reportPath, "utf8")).toContain(
      "The long end is repricing.",
    );
    expect(readdirSync(join(r.reportsDir, "macro-watch"))).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ to: "ops@example.com" });
    expect(String(r.sent[0]!.subject)).toContain("[helium/macro]");
  });

  it("writes JSONL but no report or email for a triage-only result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig();
    await r.delivery.deliver(job, ev, {
      runId: "r0",
      tier: "triage",
      outcome: "run_completed",
      verdict: { escalate: false, severity: "noise", reason: "quiet" },
    });
    expect(r.rows("deliveries")[0]).toMatchObject({
      tier: "triage",
      email: "skipped",
    });
    expect(r.sent).toHaveLength(0);
  });

  it("retries a failing send and succeeds on the third attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig({ failures: 2 });
    await r.delivery.deliver(job, ev, senior);
    expect(r.sent).toHaveLength(1);
    expect(r.rows("deliveries")[0]).toMatchObject({
      email: "sent",
      attempts: 3,
    });
  });

  it("writes a dead-letter row when every attempt fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig({ failures: 99 });
    await r.delivery.deliver(job, ev, senior);
    const rows = r.rows("deliveries");
    expect(rows.at(-1)).toMatchObject({
      kind: "dead-letter",
      job: "macro-watch",
    });
    expect(rows.at(-1)!.error).toContain("421");
  });

  it("enforces the per-job hourly email cap from the JSONL trail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig();
    for (let i = 0; i < 5; i += 1) await r.delivery.deliver(job, ev, senior);
    expect(r.sent).toHaveLength(job.delivery.email!.maxPerHour);
    expect(r.rows("deliveries").at(-1)).toMatchObject({ email: "rate-capped" });
  });

  it("records heartbeats and budget exhaustion as their own rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig();
    r.delivery.heartbeat({ job: "macro-watch", state: "unchanged" });
    r.delivery.budgetExhausted(job, ev, { tier: "triage", count: 30, cap: 30 });
    expect(r.rows("heartbeat")[0]).toMatchObject({ state: "unchanged" });
    expect(r.rows("deliveries")[0]).toMatchObject({
      kind: "budget-exhausted",
      tier: "triage",
    });
  });

  it("summarises the day from the JSONL trail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const r = rig();
    await r.delivery.deliver(job, ev, senior);
    r.delivery.budgetExhausted(job, ev, { tier: "senior", count: 12, cap: 12 });
    await r.delivery.dailySynthesis();
    const body = String(r.sent.at(-1)!.text);
    expect(body).toContain("senior runs: 1");
    expect(body).toContain("budget exhaustions: 1");
    expect(body).toContain("dead letters: 0");
  });
});
