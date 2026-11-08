/**
 * Delivery: markdown (local file), email (Resend), argon (HTTP ingest).
 * Behaviour ported from the v2 `plugins/delivery-*` channels:
 * - a bundle may only use the channels it declares (anything else throws);
 * - external channels need the operator brake `HELIUM_TENANT_DELIVERY=1`;
 * - email subjects carry `[TEST] ` unless `HELIUM_DEPLOYMENT=production`;
 * - email has a per-bundle per-as-of-day cap counted from this store (so a
 *   deploy no longer resets it); argon is idempotent on (tenant, run_id);
 * - 4xx is not retried, 5xx/network gets two retries with backoff.
 * The intent row is written before the send and updated after it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type ChannelName = "markdown" | "email" | "argon";

export interface Doc {
  subject: string;
  /** Markdown/plain body: the markdown file and the email text part. */
  text: string;
  html?: string;
  /** Structured view for argon; must carry an integer schemaVersion there. */
  data?: { schemaVersion: number; headline?: string; outcome?: string; [k: string]: unknown };
}

export interface Outcome {
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail: string;
}

export interface DeliveryContext {
  db: DatabaseSync;
  stateRoot: string;
  runId: string;
  bundle: string;
  phase: string | undefined;
  day: string;
  code: string;
  env: NodeJS.ProcessEnv;
  fetch?: Poster;
  sleep?: (ms: number) => Promise<void>;
}

export type Poster = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

const EXTERNAL: Record<ChannelName, boolean> = { markdown: false, email: true, argon: true };

export async function deliver(
  channel: ChannelName,
  doc: Doc,
  allowed: readonly ChannelName[],
  ctx: DeliveryContext,
): Promise<Outcome> {
  if (!allowed.includes(channel)) {
    throw new Error(`bundle ${ctx.bundle} does not declare channel ${channel} (allowed: ${allowed.join(", ")})`);
  }
  const now = () => new Date().toISOString();
  const row = ctx.db
    .prepare("INSERT INTO deliveries (run_id, channel, state, detail, at) VALUES (?, ?, 'intent', NULL, ?)")
    .run(ctx.runId, channel, now());
  let out: Outcome;
  if (EXTERNAL[channel] && ctx.env.HELIUM_TENANT_DELIVERY !== "1") {
    out = { state: "skipped", detail: "operator brake: HELIUM_TENANT_DELIVERY is not 1" };
  } else {
    try {
      out =
        channel === "markdown" ? markdown(doc, ctx) : channel === "email" ? await email(doc, ctx) : await argon(doc, ctx);
    } catch (e) {
      out = { state: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  }
  ctx.db
    .prepare("UPDATE deliveries SET state = ?, detail = ?, at = ? WHERE rowid = ?")
    .run(out.state, out.detail, now(), row.lastInsertRowid);
  return out;
}

/** `<root>/reports/<bundle>-<day>-<phase|run>.md`. A rerun of the same phase
 *  overwrites: it is a correction of that report, not a second one. */
function markdown(doc: Doc, ctx: DeliveryContext): Outcome {
  const dir = join(ctx.stateRoot, "reports");
  const path = join(dir, `${ctx.bundle}-${ctx.day}-${ctx.phase ?? ctx.runId}.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `# ${doc.subject}\n\n- run: \`${ctx.runId}\`\n- audit: \`helium audit ${ctx.runId}\`\n\n${doc.text}\n`);
  return { state: "sent", detail: path };
}

async function email(doc: Doc, ctx: DeliveryContext): Promise<Outcome> {
  const { env } = ctx;
  const to = env.HELIUM_EMAIL_TO;
  const key = env.RESEND_HELIUM_TOKEN;
  if (!to) return { state: "skipped", detail: "no HELIUM_EMAIL_TO" };
  if (!key) return { state: "skipped", detail: "no RESEND_HELIUM_TOKEN" };
  // A deployment fact, set per machine; 0 = uncapped, set deliberately.
  const raw = env.HELIUM_EMAIL_MAX_PER_DAY ?? "";
  const cap = Number(raw) === 0 && raw.trim() !== "" ? Infinity : Number(raw);
  if (!(cap > 0)) return { state: "failed", detail: `HELIUM_EMAIL_MAX_PER_DAY must be a positive number or 0, got "${raw}"` };
  const { n } = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries d JOIN runs r ON r.id = d.run_id
       WHERE d.channel = 'email' AND d.state = 'sent' AND r.bundle = ? AND r.as_of = ?`,
    )
    .get(ctx.bundle, ctx.day) as { n: number };
  if (n >= cap) return { state: "rate-capped", detail: `${n}/${cap} already sent for ${ctx.day}` };

  const test = env.HELIUM_DEPLOYMENT === "production" ? "" : "[TEST] ";
  const body = JSON.stringify({
    from: env.HELIUM_EMAIL_FROM ?? "Helium <helium@rsiarc.com>",
    to,
    subject: `${test}${doc.subject}`,
    text: doc.text,
    ...(doc.html === undefined ? {} : { html: doc.html }),
  });
  return post(ctx, "https://api.resend.com/emails", body, {
    Authorization: `Bearer ${key}`,
    // A send Resend accepted but we never heard about must not become a second mail.
    "Idempotency-Key": `${ctx.bundle}/${ctx.runId}`,
  });
}

async function argon(doc: Doc, ctx: DeliveryContext): Promise<Outcome> {
  const base = ctx.env.ARGON_BASE_URL ?? "";
  const token = ctx.env.ARGON_INGEST_TOKEN ?? "";
  if (base.trim() === "") return { state: "skipped", detail: "no ARGON_BASE_URL" };
  if (token.trim() === "") return { state: "skipped", detail: "no ARGON_INGEST_TOKEN" };
  if (!ctx.phase) return { state: "skipped", detail: "run carries no phase (argon kind)" };
  const data = doc.data;
  if (data === undefined) return { state: "skipped", detail: "document has no data view" };
  if (!Number.isInteger(data.schemaVersion)) return { state: "failed", detail: "document has no integer schemaVersion" };
  const body = JSON.stringify({
    tenant: ctx.bundle,
    kind: ctx.phase,
    run_day: ctx.day,
    week_key: isoWeekOf(ctx.day),
    run_id: ctx.runId,
    code_sha: ctx.code,
    schema_version: data.schemaVersion,
    outcome: data.outcome ?? "completed",
    headline: data.headline ?? "",
    view: data,
    report: { subject: doc.subject, body: doc.text, artifacts: [] },
  });
  return post(ctx, `${base.replace(/\/+$/, "")}/api/agent-runs`, body, { Authorization: `Bearer ${token}` });
}

const BACKOFF_MS = [5_000, 25_000];

async function post(ctx: DeliveryContext, url: string, body: string, headers: Record<string, string>): Promise<Outcome> {
  const send = ctx.fetch ?? (globalThis.fetch as unknown as Poster);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let detail = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await send(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
      if (res.status >= 200 && res.status < 300) return { state: "sent", detail: `HTTP ${res.status}` };
      detail = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      // A rejected body is rejected again; 429 is about the moment, not the body.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { state: "failed", detail };
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await sleep(BACKOFF_MS[attempt - 1]!);
  }
  return { state: "failed", detail };
}

const DAY_MS = 86_400_000;

/** ISO week `yyyy-Www` of a yyyy-mm-dd label, in UTC (a day is a label, not
 *  an instant). The year is the ISO year: 2027-01-01 is 2026-W53. */
export function isoWeekOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`not a yyyy-mm-dd day: ${day}`);
  const weekday = (t: number) => (new Date(t).getUTCDay() + 6) % 7;
  const thursday = at + (3 - weekday(at)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week = Math.round((thursday - (jan4 - weekday(jan4) * DAY_MS)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
