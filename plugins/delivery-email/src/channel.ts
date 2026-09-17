/**
 * The email delivery channel: Resend plus a per-tenant daily rate cap, salvaged
 * from v1's `delivery.ts` (design §8, keep-trim).
 *
 * What was dropped in the move: the write-ahead JSONL state machine, the
 * dead-letter stream and the `uncertain` reconciliation pass. Those existed to
 * make delivery itself an auditable ledger; v2's audit table already records
 * every step of a run, and a second append-only log for one channel is exactly
 * the ceremony doctrine 6 asks us to delete. What survives is the part that
 * earned its keep: retry with backoff, and a cap counted from state this
 * channel owns.
 *
 * The cap is counted from a small JSON file beside the reports rather than
 * from a scan of every historic row: the question is "how many today", the
 * file answers it in one read, and a lost file caps LOW (it re-counts from
 * zero and sends), never high.
 * @module dsh-plugin-delivery-email/channel
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Channel, DeliveryOutcome, DeliveryPayload } from "@helium/core";

/** The one thing this channel needs from `fetch`: send a body, read a status
 *  and the error text. Narrow on purpose — a test injects a few lines instead of
 *  a Response. */
export type Poster = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

const RESEND_URL = "https://api.resend.com/emails";

export const DEFAULT_FROM = "Helium <helium@rsiarc.com>";

export interface ResendConfig {
  apiKey: string;
  from: string;
}

/** Builds Resend config from env. Never logs the returned values. */
export function resendFromEnv(env: NodeJS.ProcessEnv): ResendConfig | null {
  if (!env.RESEND_HELIUM_TOKEN) return null;
  return { apiKey: env.RESEND_HELIUM_TOKEN, from: env.HELIUM_EMAIL_FROM ?? DEFAULT_FROM };
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const BACKOFF_MS = [5_000, 25_000];

/** Resend answers errors as `{ statusCode, name, message }`; anything else is
 *  quoted as-is, clipped so a proxy's HTML page cannot flood the audit row. */
async function resendMessage(res: { text: () => Promise<string> }): Promise<string> {
  const raw = (await res.text().catch(() => "")).trim();
  try {
    const body = JSON.parse(raw) as { name?: unknown; message?: unknown };
    if (typeof body.message === "string")
      return typeof body.name === "string" ? `${body.name}: ${body.message}` : body.message;
  } catch { /* not JSON */ }
  return raw.slice(0, 200);
}

interface EmailConfig {
  to: string;
  subjectPrefix?: string;
  maxPerDay: number;
}

function readConfig(config: Record<string, unknown>, env: NodeJS.ProcessEnv): EmailConfig {
  // The address is a deployment fact, not a tenant fact: the same manifest is
  // read on the laptop and on the mini, and only one of them should mail a
  // person. So `to` falls back to the environment and the manifest can stay
  // free of anyone's inbox.
  const to = config.to ?? env.HELIUM_EMAIL_TO;
  if (typeof to !== "string" || to.trim() === "") {
    throw new Error("email channel config needs a `to` address, or HELIUM_EMAIL_TO set");
  }
  // The cap is a deployment fact like the address: a cron on the mini must not
  // be able to mail sixty times overnight, while a laptop run being iterated on
  // has an operator watching every send. So the environment overrides the
  // manifest, and `0` there means uncapped — set deliberately, per machine,
  // never by forgetting to configure it.
  const override = env.HELIUM_EMAIL_MAX_PER_DAY;
  const maxPerDay =
    override === undefined || override.trim() === ""
      ? (config.maxPerDay ?? config.max_per_day)
      : Number(override) === 0
        ? Number.POSITIVE_INFINITY
        : Number(override);
  if (typeof maxPerDay !== "number" || Number.isNaN(maxPerDay) || maxPerDay <= 0) {
    throw new Error("email channel config needs a positive `maxPerDay`, or HELIUM_EMAIL_MAX_PER_DAY");
  }
  const prefix = config.subjectPrefix ?? config.subject_prefix;
  return {
    to,
    maxPerDay,
    ...(typeof prefix === "string" ? { subjectPrefix: prefix } : {}),
  };
}

/** `{ "<tenant>": { "<yyyy-mm-dd>": <count> } }`, one small file. */
type Counters = Record<string, Record<string, number>>;

export class EmailChannel implements Channel {
  readonly id = "email";
  /** Mail leaves the machine, so the operator brake applies. */
  readonly external = true;

  // Every dep is optional so the module can default-export a working INSTANCE:
  // discovery imports the default and calls `.deliver` on it, with no chance to
  // pass constructor arguments. Tests still inject all of them.
  constructor(
    private readonly deps: {
      stateDir?: string;
      resend?: ResendConfig | null;
      env?: NodeJS.ProcessEnv;
      sleep?: (ms: number) => Promise<void>;
      fetch?: Poster;
    } = {},
  ) {}

  async deliver(
    payload: DeliveryPayload,
    config: Record<string, unknown>,
  ): Promise<DeliveryOutcome> {
    const email = readConfig(config, this.#env);
    const resend = this.#resend;
    if (resend === null) {
      return { state: "skipped", detail: "no RESEND_HELIUM_TOKEN configured" };
    }

    // The runner's day, in the tenant's declared report zone -- never a clock
    // read in here. The cap is "how many for THIS day's report", and a channel
    // rolling its counter at a different midnight than the reports are named
    // for would ration one day's mail against another day's count.
    const day = payload.day;
    const counters = this.#read();
    const used = counters[payload.tenant]?.[day] ?? 0;
    if (used >= email.maxPerDay) {
      return {
        state: "rate-capped",
        detail: `${used}/${email.maxPerDay} already sent today`,
      };
    }

    // The tenant's own renderer wins when it ran: the transcript is the record,
    // the rendered form is what a person reads. Artifact paths stay on the
    // transcript form only -- a rendered brief is a finished document and a
    // local absolute path is not part of it.
    const base = payload.rendered?.subject ?? payload.subject;
    const subject =
      email.subjectPrefix === undefined ? base : `${email.subjectPrefix} ${base}`;
    const text =
      payload.rendered === undefined
        ? [
            payload.body,
            "",
            ...(payload.artifacts ?? []).map((path) => `Artifact: ${path}`),
          ].join("\n")
        : payload.rendered.text;
    const mail: Mail = {
      from: resend.from,
      to: email.to,
      subject,
      text,
      ...(payload.rendered?.html === undefined
        ? {}
        : { html: payload.rendered.html }),
    };

    const post = this.deps.fetch ?? (globalThis.fetch as unknown as Poster);
    // One key per delivery attempt SET, not per attempt: a send Resend accepted
    // but the client never heard about must not become a second briefing.
    const idempotencyKey = `${payload.tenant}/${payload.runId}`;
    let error = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await post(RESEND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resend.apiKey}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(mail),
        });
        if (res.status >= 200 && res.status < 300) {
          counters[payload.tenant] = { ...counters[payload.tenant], [day]: used + 1 };
          this.#write(counters);
          return { state: "sent", detail: `attempt ${attempt}` };
        }
        error = `HTTP ${String(res.status)}: ${await resendMessage(res)}`;
        // A rejected body is rejected again (bad key, unverified sender, invalid
        // address): retrying wastes the window and hides the reason behind a
        // timeout. 429 is the one 4xx that is about the moment, not the body.
        if (res.status >= 400 && res.status < 500 && res.status !== 429)
          return { state: "failed", detail: error };
      } catch (cause: unknown) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (attempt < 3) await this.#sleep(BACKOFF_MS[attempt - 1]!);
    }
    return { state: "failed", detail: error };
  }

  get #env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Injected config wins, including an explicit `null`; otherwise the
   *  environment answers, which is what the default export relies on. */
  get #resend(): ResendConfig | null {
    return this.deps.resend !== undefined ? this.deps.resend : resendFromEnv(this.#env);
  }

  #sleep(ms: number): Promise<void> {
    return (
      this.deps.sleep ?? ((wait: number) => new Promise((r) => setTimeout(r, wait)))
    )(ms);
  }

  get #file(): string {
    const dir =
      this.deps.stateDir ??
      join(this.#env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state"), "reports");
    return join(dir, "email-counters.json");
  }

  #read(): Counters {
    if (!existsSync(this.#file)) return {};
    try {
      return JSON.parse(readFileSync(this.#file, "utf8")) as Counters;
    } catch {
      // A torn counter file caps LOW: re-counting from zero can only send an
      // extra mail, while trusting a corrupt high count would silence a tenant.
      return {};
    }
  }

  #write(counters: Counters): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify(counters));
  }
}

/** Discovery imports the default export and calls `.deliver` on it, so the
 *  default must be an INSTANCE. Exporting the class satisfies
 *  `typeof … === "function"` on the constructor and then fails on `deliver`,
 *  and the channel is dropped as "default export is not a Channel" — which is
 *  exactly what this file did until 2026-09-02, so the plugin had tests and had
 *  never once been loaded by a run. */
export default new EmailChannel();
