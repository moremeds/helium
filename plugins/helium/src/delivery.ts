/**
 * Delivery (spec §3, §8): JSONL append FIRST, always — the delivery row lands
 * before email is even attempted. Markdown reports and retried email sit on
 * top of that audit record as best-effort delivery, never as the record
 * itself. Per-job email rate cap is counted from today's own `deliveries`
 * JSONL rows rather than new persisted state — `SensorState` is a fixed
 * contract (spec §8) and delivery must not extend it.
 * @module dsh-plugin-helium/delivery
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { nowIso, type JobSpec, type JsonlWriter } from "@helium/core";
import type { DispatchResult } from "./dispatch.js";
import type { TriggerEvent } from "./sensor.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Builds SMTP config from `SMTP_*` env keys. Never logs the returned values. */
export function smtpFromEnv(env: Record<string, string>): SmtpConfig | null {
  if (!env.SMTP_HOST) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? "587"),
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM ?? `helium@${env.SMTP_HOST}`,
  };
}

const BACKOFF_MS = [5_000, 25_000];
const HOUR_MS = 3_600_000;

function dayFile(dir: string, stream: string, day: Date): string {
  return join(dir, `${stream}-${day.toISOString().slice(0, 10)}.jsonl`);
}

function readRows(
  dir: string,
  stream: string,
  day: Date,
): Record<string, unknown>[] {
  const file = dayFile(dir, stream, day);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Count emails actually sent for a job inside the window, from the audit trail itself. */
export function countSentEmails(
  jsonlDir: string,
  job: string,
  sinceMs: number,
  now: Date,
): number {
  const yesterday = new Date(now.getTime() - 86_400_000);
  return [
    ...readRows(jsonlDir, "deliveries", yesterday),
    ...readRows(jsonlDir, "deliveries", now),
  ].filter(
    (r) =>
      r.job === job &&
      r.email === "sent" &&
      now.getTime() - Date.parse(String(r.ts)) < sinceMs,
  ).length;
}

export class Delivery {
  readonly #transport: Transporter | null;

  constructor(
    private readonly opts: {
      jsonl: JsonlWriter;
      jsonlDir: string;
      reportsDir: string;
      emailTo: string;
      smtp: SmtpConfig | null;
      transport?: Transporter;
      sleep?: (ms: number) => Promise<void>;
      now?: () => Date;
    },
  ) {
    this.#transport =
      opts.transport ??
      (opts.smtp
        ? nodemailer.createTransport({
            host: opts.smtp.host,
            port: opts.smtp.port,
            secure: opts.smtp.secure,
            auth: opts.smtp.user
              ? { user: opts.smtp.user, pass: opts.smtp.pass }
              : undefined,
          })
        : null);
  }

  #now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** Appends one row to the `heartbeat` stream — spec §8: every sensor cycle, including no-ops. */
  heartbeat(row: Record<string, unknown>): void {
    this.opts.jsonl.append("heartbeat", row);
  }

  /** Budget exhaustion is its own `deliveries` row (spec §5): suppressed dispatch, no email. */
  budgetExhausted(
    job: JobSpec,
    ev: TriggerEvent,
    info: { tier: string; count: number; cap: number },
  ): void {
    this.opts.jsonl.append("deliveries", {
      kind: "budget-exhausted",
      job: job.name,
      dedupKey: ev.dedupKey,
      ...info,
      email: "skipped",
    });
  }

  /**
   * Deliver one dispatch result: JSONL append first and always, then a
   * markdown report for a completed senior run, then a best-effort retried
   * email. The JSONL row lands even when the email fails outright.
   */
  async deliver(
    job: JobSpec,
    ev: TriggerEvent,
    result: DispatchResult,
  ): Promise<void> {
    const report =
      result.tier === "senior" && result.analysis
        ? this.#writeReport(job, result)
        : undefined;

    const email = job.delivery.email;
    const wanted =
      result.tier === "senior" &&
      result.outcome === "run_completed" &&
      email !== undefined &&
      this.#transport !== null &&
      this.opts.smtp !== null;
    let status: "sent" | "skipped" | "rate-capped" | "failed" = "skipped";
    let attempts = 0;
    let error: string | undefined;

    if (wanted) {
      const used = countSentEmails(
        this.opts.jsonlDir,
        job.name,
        HOUR_MS,
        this.#now(),
      );
      if (used >= email!.maxPerHour) status = "rate-capped";
      else {
        const outcome = await this.#send(job, result, report);
        status = outcome.ok ? "sent" : "failed";
        attempts = outcome.attempts;
        error = outcome.error;
      }
    }

    // Append FIRST, always (spec §3/§8): this row lands whether or not the
    // email above succeeded — the JSONL trail is the audit record, email is
    // best effort on top of it.
    this.opts.jsonl.append("deliveries", {
      job: job.name,
      tier: result.tier,
      runId: result.runId,
      outcome: result.outcome,
      dedupKey: ev.dedupKey,
      severity: result.verdict?.severity,
      report,
      email: status,
      attempts,
    });
    if (status === "failed") {
      this.opts.jsonl.append("deliveries", {
        kind: "dead-letter",
        job: job.name,
        runId: result.runId,
        report,
        error,
      });
    }
  }

  #writeReport(job: JobSpec, result: DispatchResult): string {
    const dir = join(this.opts.reportsDir, job.name);
    mkdirSync(dir, { recursive: true });
    const stamp = this.#now().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}.md`);
    writeFileSync(
      path,
      [
        `# ${job.name} — ${nowIso()}`,
        "",
        `- run: ${result.runId}`,
        `- severity: ${result.verdict?.severity ?? "n/a"}`,
        `- verdict reason: ${result.verdict?.reason ?? "n/a"}`,
        "",
        result.analysis ?? "",
        "",
      ].join("\n"),
    );
    return path;
  }

  async #send(
    job: JobSpec,
    result: DispatchResult,
    report: string | undefined,
  ): Promise<{ ok: boolean; attempts: number; error?: string }> {
    const sleep =
      this.opts.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const email = job.delivery.email!;
    const mail = {
      from: this.opts.smtp!.from,
      to: email.to === "operator" ? this.opts.emailTo : email.to,
      subject: `${email.subjectPrefix} ${result.verdict?.severity ?? "update"} — ${job.name}`,
      text: [result.analysis ?? "", "", report ? `Report: ${report}` : ""].join(
        "\n",
      ),
    };
    let error = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.#transport!.sendMail(mail);
        return { ok: true, attempts: attempt };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
        if (attempt < 3) await sleep(BACKOFF_MS[attempt - 1]!);
      }
    }
    return { ok: false, attempts: 3, error };
  }

  /**
   * Daily synthesis (spec §8/§11): assembled from today's own JSONL trail —
   * thesis diffs (reports written today), budget exhaustions, dead letters,
   * interrupted-run counts. The floor, not the product; quiet days still get one.
   */
  async dailySynthesis(): Promise<void> {
    const now = this.#now();
    const deliveries = readRows(this.opts.jsonlDir, "deliveries", now);
    const runs = readRows(this.opts.jsonlDir, "runs", now);
    // Delivery result rows (tier + outcome) vs. the `kind`-tagged rows
    // (budget-exhausted, dead-letter) below: a budget-exhausted row also
    // carries a `tier` field, so per-tier run counts must exclude it.
    const results = deliveries.filter((r) => r.kind === undefined);
    const lines = [
      `helium daily synthesis — ${now.toISOString().slice(0, 10)}`,
      "",
      `senior runs: ${results.filter((r) => r.tier === "senior").length}`,
      `triage runs: ${results.filter((r) => r.tier === "triage").length}`,
      `emails sent: ${deliveries.filter((r) => r.email === "sent").length}`,
      `rate-capped: ${deliveries.filter((r) => r.email === "rate-capped").length}`,
      `budget exhaustions: ${deliveries.filter((r) => r.kind === "budget-exhausted").length}`,
      `dead letters: ${deliveries.filter((r) => r.kind === "dead-letter").length}`,
      `interrupted runs: ${runs.filter((r) => r.phase === "interrupted").length}`,
      "",
      "Reports and thesis versions written today:",
      ...deliveries
        .filter((r) => typeof r.report === "string")
        .map((r) => `- ${String(r.report)}`),
    ];
    if (!this.#transport || !this.opts.smtp) return;
    await this.#transport.sendMail({
      from: this.opts.smtp.from,
      to: this.opts.emailTo,
      subject: `[helium] daily synthesis ${now.toISOString().slice(0, 10)}`,
      text: lines.join("\n"),
    });
  }
}
