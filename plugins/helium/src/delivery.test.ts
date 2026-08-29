import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlWriter } from "@helium/core";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { ev, job } from "./testing/fixtures.js";

/** The one instant every rig runs at — injected into both the writer and Delivery. */
const NOW = new Date("2026-08-23T12:00:00.000Z");

/**
 * A writer that stops accepting appends after `budget` of them, standing in for
 * the process dying mid-delivery: whatever reached the file is what survives.
 */
class CrashingWriter extends JsonlWriter {
  private budget: number;

  constructor(dir: string, now: () => Date, budget: number) {
    super(dir, now);
    this.budget = budget;
  }

  override append(stream: string, record: Record<string, unknown>): void {
    if (this.budget <= 0) throw new Error("crash: process died mid-delivery");
    this.budget -= 1;
    super.append(stream, record);
  }
}

function rig(
  opts: {
    failures?: number;
    crashAfterAppends?: number;
    reportsDir?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "helium-deliver-"));
  const jsonlDir = join(root, "jsonl");
  const reportsDir = opts.reportsDir ?? join(root, "reports");
  const sent: Record<string, unknown>[] = [];
  /** The last durable row at the moment each delivery email hit the transport. */
  const observed: (Record<string, unknown> | undefined)[] = [];
  let failures = opts.failures ?? 0;
  const rows = (stream: string): Record<string, unknown>[] => {
    const file = join(jsonlDir, `${stream}-2026-08-23.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const transport = {
    sendMail: async (mail: Record<string, unknown>) => {
      // The daily synthesis is not a per-delivery send and has no intent row.
      if (!String(mail.subject ?? "").includes("daily synthesis")) {
        const last = rows("deliveries").at(-1);
        observed.push(last);
        expect(last).toMatchObject({
          kind: "delivery-intent",
          deliveryId: expect.any(String),
          state: "pending",
        });
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error("smtp 421 try later");
      }
      sent.push(mail);
      return { envelope: {}, messageId: "x", message: JSON.stringify(mail) };
    },
  };
  const build = (jsonl: JsonlWriter) =>
    new Delivery({
      jsonl,
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
      now: () => NOW,
    });
  const delivery = build(
    opts.crashAfterAppends === undefined
      ? new JsonlWriter(jsonlDir, () => NOW)
      : new CrashingWriter(jsonlDir, () => NOW, opts.crashAfterAppends),
  );
  /** A fresh process over the same durable state — nothing in-memory carries over. */
  const restart = () => build(new JsonlWriter(jsonlDir, () => NOW));
  return {
    delivery,
    restart,
    jsonlDir,
    reportsDir,
    root,
    sent,
    observed,
    rows,
  };
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
  it("makes the pending intent durable before the transport is touched", async () => {
    const r = rig();
    await r.delivery.deliver(job, ev, senior);
    expect(r.observed).toHaveLength(1);
    expect(r.observed[0]).toMatchObject({
      kind: "delivery-intent",
      deliveryId: expect.any(String),
      job: "macro-watch",
      runId: "r1",
      dedupKey: ev.dedupKey,
      state: "pending",
    });
  });

  it("writes an intent row, then a report, then the email, then the outcome row", async () => {
    const r = rig();
    await r.delivery.deliver(job, ev, senior);
    const rows = r.rows("deliveries");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "delivery-intent",
      state: "pending",
    });
    expect(rows[1]).toMatchObject({
      kind: "delivery-outcome",
      deliveryId: rows[0]!.deliveryId,
      job: "macro-watch",
      tier: "senior",
      state: "sent",
    });
    const reportPath = rows[1]!.report as string;
    expect(readFileSync(reportPath, "utf8")).toContain(
      "The long end is repricing.",
    );
    expect(readdirSync(join(r.reportsDir, "macro-watch"))).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ to: "ops@example.com" });
    expect(String(r.sent[0]!.subject)).toContain("[helium/macro]");
  });

  it("writes JSONL but no report or email for a triage-only result", async () => {
    const r = rig();
    await r.delivery.deliver(job, ev, {
      runId: "r0",
      tier: "triage",
      outcome: "run_completed",
      verdict: { escalate: false, severity: "noise", reason: "quiet" },
    });
    expect(r.rows("deliveries").at(-1)).toMatchObject({
      kind: "delivery-outcome",
      tier: "triage",
      state: "skipped",
    });
    expect(r.sent).toHaveLength(0);
  });

  it("retries a failing send and succeeds on the third attempt", async () => {
    const r = rig({ failures: 2 });
    await r.delivery.deliver(job, ev, senior);
    expect(r.sent).toHaveLength(1);
    expect(r.rows("deliveries").at(-1)).toMatchObject({
      kind: "delivery-outcome",
      state: "sent",
      attempts: 3,
    });
  });

  it("closes the intent as failed and dead-letters it when every attempt fails", async () => {
    const r = rig({ failures: 99 });
    await r.delivery.deliver(job, ev, senior);
    const rows = r.rows("deliveries");
    const deliveryId = rows[0]!.deliveryId;
    expect(rows[0]).toMatchObject({
      kind: "delivery-intent",
      state: "pending",
    });
    expect(rows[1]).toMatchObject({
      kind: "delivery-outcome",
      deliveryId,
      state: "failed",
    });
    expect(rows[2]).toMatchObject({
      kind: "dead-letter",
      deliveryId,
      job: "macro-watch",
    });
    expect(rows[2]!.error).toContain("421");
    // The intent is resolved, so a restart has nothing left to close.
    expect(r.restart().reconcileDeliveries()).toBe(0);
  });

  it("enforces the per-job hourly email cap from outcome rows, not intents", async () => {
    const r = rig();
    for (let i = 0; i < 5; i += 1) await r.delivery.deliver(job, ev, senior);
    expect(r.sent).toHaveLength(job.delivery.email!.maxPerHour);
    expect(r.rows("deliveries").at(-1)).toMatchObject({
      kind: "delivery-outcome",
      state: "rate-capped",
    });
  });

  it("records heartbeats and budget exhaustion as their own rows", async () => {
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
    const r = rig();
    await r.delivery.deliver(job, ev, senior);
    r.delivery.budgetExhausted(job, ev, { tier: "senior", count: 12, cap: 12 });
    await r.delivery.dailySynthesis();
    const body = String(r.sent.at(-1)!.text);
    expect(body).toContain("senior runs: 1");
    expect(body).toContain("emails sent: 1");
    expect(body).toContain("budget exhaustions: 1");
    expect(body).toContain("dead letters: 0");
    expect(body).toContain("uncertain deliveries: 0");
  });

  it("leaves the intent unresolved when the report write fails before SMTP", async () => {
    // reportsDir is a regular file, so the per-job mkdir throws: a failure
    // after the intent is durable and before the transport is reached.
    const root = mkdtempSync(join(tmpdir(), "helium-deliver-blocked-"));
    const blocked = join(root, "reports-file");
    writeFileSync(blocked, "not a directory\n");
    const r = rig({ reportsDir: blocked });
    await expect(r.delivery.deliver(job, ev, senior)).rejects.toThrow();
    expect(r.sent).toHaveLength(0);
    expect(r.observed).toHaveLength(0);
    const rows = r.rows("deliveries");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "delivery-intent",
      state: "pending",
    });
  });

  it("closes an intent orphaned by a crash before the outcome append as uncertain", async () => {
    // One append lands (the intent), then the process dies — after the
    // transport already accepted the message.
    const r = rig({ crashAfterAppends: 1 });
    await expect(r.delivery.deliver(job, ev, senior)).rejects.toThrow("crash");
    expect(r.sent).toHaveLength(1);
    const afterCrash = r.rows("deliveries");
    expect(afterCrash).toHaveLength(1);
    const deliveryId = afterCrash[0]!.deliveryId;

    // The audit trail cannot tell an accepted send from one that never left,
    // so the restart closes the intent `uncertain` — a real terminal row —
    // rather than re-sending it.
    const restarted = r.restart();
    expect(restarted.reconcileDeliveries()).toBe(1);
    const rows = r.rows("deliveries");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: "delivery-outcome",
      deliveryId,
      job: "macro-watch",
      runId: "r1",
      state: "uncertain",
    });
    expect(r.sent).toHaveLength(1);

    // Resolved is resolved: a second pass adds nothing and sends nothing.
    expect(restarted.reconcileDeliveries()).toBe(0);
    expect(r.rows("deliveries")).toHaveLength(2);
    expect(r.sent).toHaveLength(1);
  });

  it("counts an uncertain delivery in the daily synthesis", async () => {
    const r = rig({ crashAfterAppends: 1 });
    await expect(r.delivery.deliver(job, ev, senior)).rejects.toThrow("crash");
    const restarted = r.restart();
    restarted.reconcileDeliveries();
    await restarted.dailySynthesis();
    const body = String(r.sent.at(-1)!.text);
    expect(body).toContain("uncertain deliveries: 1");
    expect(body).toContain("emails sent: 0");
  });
});
