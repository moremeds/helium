/**
 * The email delivery channel: SMTP plus a per-tenant daily rate cap, salvaged
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
import nodemailer, { type Transporter } from "nodemailer";
import type { Channel, DeliveryOutcome, DeliveryPayload } from "@helium/core";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Builds SMTP config from `SMTP_*` env keys. Never logs the returned values. */
export function smtpFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null {
  if (!env.SMTP_HOST) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? "587"),
    secure: env.SMTP_SECURE === "true",
    ...(env.SMTP_USER === undefined ? {} : { user: env.SMTP_USER }),
    ...(env.SMTP_PASS === undefined ? {} : { pass: env.SMTP_PASS }),
    from: env.SMTP_FROM ?? `helium@${env.SMTP_HOST}`,
  };
}

const BACKOFF_MS = [5_000, 25_000];

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
  const maxPerDay = config.maxPerDay ?? config.max_per_day;
  if (typeof to !== "string" || to.trim() === "") {
    throw new Error("email channel config needs a `to` address, or HELIUM_EMAIL_TO set");
  }
  if (typeof maxPerDay !== "number" || maxPerDay <= 0) {
    throw new Error("email channel config needs a positive `maxPerDay`");
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
  #transport: Transporter | null = null;

  // Every dep is optional so the module can default-export a working INSTANCE:
  // discovery imports the default and calls `.deliver` on it, with no chance to
  // pass constructor arguments. Tests still inject all of them.
  constructor(
    private readonly deps: {
      stateDir?: string;
      smtp?: SmtpConfig | null;
      env?: NodeJS.ProcessEnv;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
      transport?: Transporter;
    } = {},
  ) {}

  async deliver(
    payload: DeliveryPayload,
    config: Record<string, unknown>,
  ): Promise<DeliveryOutcome> {
    const email = readConfig(config, this.#env);
    const smtp = this.#smtp;
    const transport = this.#ensureTransport();
    if (transport === null || smtp === null) {
      return { state: "skipped", detail: "no SMTP configured" };
    }

    const day = this.#now().toISOString().slice(0, 10);
    const counters = this.#read();
    const used = counters[payload.tenant]?.[day] ?? 0;
    if (used >= email.maxPerDay) {
      return {
        state: "rate-capped",
        detail: `${used}/${email.maxPerDay} already sent today`,
      };
    }

    const subject =
      email.subjectPrefix === undefined
        ? payload.subject
        : `${email.subjectPrefix} ${payload.subject}`;
    const mail = {
      from: smtp.from,
      to: email.to,
      subject,
      text: [
        payload.body,
        "",
        ...(payload.artifacts ?? []).map((path) => `Artifact: ${path}`),
      ].join("\n"),
    };

    let error = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await transport.sendMail(mail);
        counters[payload.tenant] = { ...counters[payload.tenant], [day]: used + 1 };
        this.#write(counters);
        return { state: "sent", detail: `attempt ${attempt}` };
      } catch (cause: unknown) {
        error = cause instanceof Error ? cause.message : String(cause);
        if (attempt < 3) await this.#sleep(BACKOFF_MS[attempt - 1]!);
      }
    }
    return { state: "failed", detail: error };
  }

  get #env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Injected config wins, including an explicit `null`; otherwise the
   *  environment answers, which is what the default export relies on. */
  get #smtp(): SmtpConfig | null {
    return this.deps.smtp !== undefined ? this.deps.smtp : smtpFromEnv(this.#env);
  }

  #ensureTransport(): Transporter | null {
    if (this.deps.transport !== undefined) return this.deps.transport;
    if (this.#transport !== null) return this.#transport;
    const smtp = this.#smtp;
    if (smtp === null) return null;
    this.#transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user === undefined ? {} : { auth: { user: smtp.user, pass: smtp.pass } }),
    });
    return this.#transport;
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))();
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
