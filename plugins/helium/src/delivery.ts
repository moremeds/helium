/**
 * Delivery (spec §3, §8) as a write-ahead state machine. Every delivery gets a
 * `deliveryId` and a `delivery-intent` row that is durable *before* any
 * external side effect, then a single `delivery-outcome` row closing it; a
 * failed send adds a third `dead-letter` row under the same id. Markdown
 * reports and retried email sit on top of that audit record as best-effort
 * delivery, never as the record itself.
 *
 * What that buys, precisely: an intent is on disk before SMTP is touched; a
 * `deliveryId` has at most one unresolved intent; an intent whose outcome is
 * unknown is never blindly retried — `reconcileDeliveries()` closes it
 * `uncertain`, a real terminal row for a human or a later reconciliation to
 * resolve. SMTP acceptance followed by a crash before the outcome append is
 * genuinely indeterminate from the audit trail, and this lane does not pretend
 * otherwise; completion is idempotent only as far as the transport's own dedup
 * key reaches.
 *
 * Per-job email rate cap is counted from today's own `deliveries` JSONL
 * outcome rows rather than new persisted state — `SensorState` is a fixed
 * contract (spec §8) and delivery must not extend it.
 * @module dsh-plugin-helium/delivery
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import type { JobSpec, JsonlWriter } from "@helium/core";
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

/** The stream every delivery row lands in. */
const DELIVERIES = "deliveries";

/** Dated `deliveries` files, the ones `reconcileDeliveries()` may read. */
const DELIVERY_FILE = /^deliveries-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** How a delivery ended. `pending` is the intent; the rest are terminal. */
export type DeliveryState =
  "pending" | "sent" | "skipped" | "rate-capped" | "failed" | "uncertain";

function dayFile(dir: string, stream: string, day: Date): string {
  return join(dir, `${stream}-${day.toISOString().slice(0, 10)}.jsonl`);
}

/** Parse one JSONL file's rows, skipping any line a torn write left unparsable. */
function parseRows(text: string): Record<string, unknown>[] {
  return text
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

function readRows(
  dir: string,
  stream: string,
  day: Date,
): Record<string, unknown>[] {
  const file = dayFile(dir, stream, day);
  if (!existsSync(file)) return [];
  return parseRows(readFileSync(file, "utf8"));
}

/** Every delivery row still on disk, oldest day first — the full unresolved history. */
function readAllDeliveryRows(dir: string): Record<string, unknown>[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => DELIVERY_FILE.test(name))
    .sort()
    .flatMap((name) => parseRows(readFileSync(join(dir, name), "utf8")));
}

/**
 * Count emails actually sent for a job inside the window, from the audit trail
 * itself. Only closed outcome rows count: an intent is not yet a send, so a
 * crashed delivery can never inflate the cap on its own.
 */
export function countSentEmails(
  jsonlDir: string,
  job: string,
  sinceMs: number,
  now: Date,
): number {
  const yesterday = new Date(now.getTime() - 86_400_000);
  return [
    ...readRows(jsonlDir, DELIVERIES, yesterday),
    ...readRows(jsonlDir, DELIVERIES, now),
  ].filter(
    (r) =>
      r.job === job &&
      r.kind === "delivery-outcome" &&
      r.state === "sent" &&
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
    this.opts.jsonl.append(DELIVERIES, {
      kind: "budget-exhausted",
      job: job.name,
      dedupKey: ev.dedupKey,
      ...info,
      email: "skipped",
    });
  }

  /**
   * Deliver one dispatch result. The `delivery-intent` row is made durable
   * first — before the report is written and before SMTP is touched — so no
   * external side effect can happen that the audit trail has not already
   * announced. The `delivery-outcome` row then closes that intent, and a
   * failed send adds a `dead-letter` row under the same id.
   */
  async deliver(
    job: JobSpec,
    ev: TriggerEvent,
    result: DispatchResult,
  ): Promise<void> {
    const deliveryId = randomUUID();
    // Write-ahead (spec §3/§8): durable intent before any external side
    // effect. A crash from here on leaves an unresolved intent that
    // `reconcileDeliveries()` closes, never a side effect with no record.
    this.opts.jsonl.append(DELIVERIES, {
      kind: "delivery-intent",
      deliveryId,
      job: job.name,
      runId: result.runId,
      dedupKey: ev.dedupKey,
      state: "pending",
    });

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
    let state: DeliveryState = "skipped";
    let attempts = 0;
    let error: string | undefined;

    if (wanted) {
      const used = countSentEmails(
        this.opts.jsonlDir,
        job.name,
        HOUR_MS,
        this.#now(),
      );
      if (used >= email!.maxPerHour) state = "rate-capped";
      else {
        const outcome = await this.#send(job, result, report);
        state = outcome.ok ? "sent" : "failed";
        attempts = outcome.attempts;
        error = outcome.error;
      }
    }

    // The outcome row closes the intent above. It lands whether or not the
    // email succeeded — the JSONL trail is the audit record, email is best
    // effort on top of it.
    this.opts.jsonl.append(DELIVERIES, {
      kind: "delivery-outcome",
      deliveryId,
      state,
      job: job.name,
      tier: result.tier,
      runId: result.runId,
      outcome: result.outcome,
      dedupKey: ev.dedupKey,
      severity: result.verdict?.severity,
      report,
      attempts,
    });
    if (state === "failed") {
      this.opts.jsonl.append(DELIVERIES, {
        kind: "dead-letter",
        deliveryId,
        job: job.name,
        runId: result.runId,
        report,
        error,
      });
    }
  }

  /**
   * Close every delivery intent left unresolved by a crash, a kill, or a
   * machine sleep. Whether SMTP accepted the message before the process died
   * is not recoverable from the audit trail, so the intent is closed
   * `uncertain` — a real terminal row for a human or a later reconciliation to
   * resolve — and is never blindly re-sent.
   * @returns how many intents were closed `uncertain`.
   */
  reconcileDeliveries(): number {
    const open = new Map<string, Record<string, unknown>>();
    for (const row of readAllDeliveryRows(this.opts.jsonlDir)) {
      if (typeof row.deliveryId !== "string") continue;
      if (row.kind === "delivery-intent") open.set(row.deliveryId, row);
      else if (row.kind === "delivery-outcome") open.delete(row.deliveryId);
    }
    for (const row of open.values()) {
      this.opts.jsonl.append(DELIVERIES, {
        kind: "delivery-outcome",
        deliveryId: row.deliveryId,
        state: "uncertain",
        job: row.job,
        runId: row.runId,
        dedupKey: row.dedupKey,
        detail: { intentAt: row.ts },
      });
    }
    return open.size;
  }

  #writeReport(job: JobSpec, result: DispatchResult): string {
    const dir = join(this.opts.reportsDir, job.name);
    mkdirSync(dir, { recursive: true });
    const stamp = this.#now().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}.md`);
    writeFileSync(
      path,
      [
        `# ${job.name} — ${this.#now().toISOString()}`,
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
    const deliveries = readRows(this.opts.jsonlDir, DELIVERIES, now);
    const runs = readRows(this.opts.jsonlDir, "runs", now);
    // Closed outcome rows only: intents are counted when they resolve, and a
    // budget-exhausted row carries a `tier` field of its own that would
    // otherwise inflate the per-tier run counts.
    const outcomes = deliveries.filter((r) => r.kind === "delivery-outcome");
    const lines = [
      `helium daily synthesis — ${now.toISOString().slice(0, 10)}`,
      "",
      `senior runs: ${outcomes.filter((r) => r.tier === "senior").length}`,
      `triage runs: ${outcomes.filter((r) => r.tier === "triage").length}`,
      `emails sent: ${outcomes.filter((r) => r.state === "sent").length}`,
      `rate-capped: ${outcomes.filter((r) => r.state === "rate-capped").length}`,
      `uncertain deliveries: ${outcomes.filter((r) => r.state === "uncertain").length}`,
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
