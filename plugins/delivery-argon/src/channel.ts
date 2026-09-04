/**
 * A delivery channel that POSTs one structured run to an HTTP ingest endpoint.
 *
 * It reads `payload.tenant`, `payload.phase`, `payload.day`, `payload.runId`,
 * `payload.codeVersion` and `payload.rendered.data`, maps them onto a request
 * body and sends it. It never looks inside the document: the tenant's renderer
 * is the only thing that knows what is in there, and a channel that learned one
 * key name would have to be edited every time a second tenant shipped a
 * different one.
 *
 * What was deliberately NOT built: no write-ahead log, no dead-letter queue,
 * no reconciliation pass, no local mirror of what was posted. The audit table
 * already records every step of a run, and the ingest is idempotent on
 * `(tenant, run_id)` — so a blind retry is safe, and that one property replaces
 * all of it. Do not add them back without a defect that only they would catch.
 * @module dsh-plugin-delivery-argon/channel
 */
import type { Channel, DeliveryOutcome, DeliveryPayload } from "@helium/core";

/** The one thing this channel needs from `fetch`: send a body, read a status.
 *  Narrow on purpose — a test injects three lines instead of a Response. */
export type Poster = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

const BACKOFF_MS = [5_000, 25_000];
const DAY_MS = 86_400_000;

/**
 * Which ISO week a run day belongs to, as `yyyy-Www`.
 *
 * UTC throughout: a report day is a LABEL, not an instant, and running it
 * through a local timezone turns a Monday into the previous Sunday west of UTC.
 * The year in the answer is the ISO year, not the calendar year — 2027-01-01 is
 * 2026-W53, and filing it under 2027 puts it in a week no navigation reaches.
 */
export function isoWeekOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`not a yyyy-mm-dd day: ${day}`);
  // The Thursday of this day's week decides both the ISO year and the number.
  const thursday = new Date(at + (3 - weekdayIndex(at)) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const week =
    Math.round((thursday.getTime() - firstMondayOf(isoYear)) / (7 * DAY_MS)) + 1;
  return `${String(isoYear)}-W${String(week).padStart(2, "0")}`;
}

/**
 * The week before a week.
 *
 * Subtracts seven days from that week's Monday and re-derives, rather than
 * decrementing the number: decrementing breaks at every year boundary, where
 * W01 is preceded by W52 or W53 depending on the year, and "W00" exists nowhere.
 */
export function previousIsoWeek(weekKey: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (match === null) throw new Error(`not a yyyy-Www week: ${weekKey}`);
  const monday =
    firstMondayOf(Number(match[1])) + (Number(match[2]) - 1) * 7 * DAY_MS;
  return isoWeekOf(new Date(monday - 7 * DAY_MS).toISOString().slice(0, 10));
}

/** Monday = 0 … Sunday = 6, the order ISO counts in. */
function weekdayIndex(at: number): number {
  return (new Date(at).getUTCDay() + 6) % 7;
}

/** The Monday of week 1: the week holding January 4th, by definition. */
function firstMondayOf(isoYear: number): number {
  const jan4 = Date.UTC(isoYear, 0, 4);
  return jan4 - weekdayIndex(jan4) * DAY_MS;
}

const RULES = ["iso-week-of-day", "previous-iso-week"] as const;
type WeekKeyRule = (typeof RULES)[number];

function ruleFor(
  config: Record<string, unknown>,
  kind: string,
): WeekKeyRule | { unknown: string } {
  const rules = config.weekKeyRules;
  if (rules === null || typeof rules !== "object") return "iso-week-of-day";
  const named = (rules as Record<string, unknown>)[kind];
  if (named === undefined) return "iso-week-of-day";
  return RULES.includes(named as WeekKeyRule)
    ? (named as WeekKeyRule)
    : { unknown: String(named) };
}

export class ArgonChannel implements Channel {
  readonly id = "argon";
  /**
   * A decision, not a default. The row does not leave the building, but it
   * leaves this process and lands where a person reads it as a briefing — and a
   * laptop run publishing something that looks like the real thing is exactly
   * the hazard `HELIUM_TENANT_DELIVERY` exists for. Absent would be treated as
   * external anyway; stating it keeps the decision visible.
   */
  readonly external = true;

  // Every dep is optional so the module can default-export a working INSTANCE:
  // discovery imports the default and invokes `.deliver` on it, with no chance
  // to pass constructor arguments. Tests inject all three.
  constructor(
    private readonly deps: {
      env?: NodeJS.ProcessEnv;
      fetch?: Poster;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async deliver(
    payload: DeliveryPayload,
    config: Record<string, unknown>,
  ): Promise<DeliveryOutcome> {
    const env = this.deps.env ?? process.env;
    const configured = config.baseUrl;
    const base =
      env.ARGON_BASE_URL ?? (typeof configured === "string" ? configured : "");
    if (base.trim() === "")
      return { state: "skipped", detail: "no ARGON_BASE_URL" };
    const token = env.ARGON_INGEST_TOKEN ?? "";
    // Not a degraded mode: an unauthenticated POST is a different request, and
    // one this endpoint would reject anyway.
    if (token.trim() === "")
      return { state: "skipped", detail: "no ARGON_INGEST_TOKEN" };

    const kind = payload.phase;
    if (kind === undefined || kind === "")
      return { state: "skipped", detail: "run carries no kind" };
    const kinds = config.kinds;
    if (Array.isArray(kinds) && !kinds.includes(kind))
      return { state: "skipped", detail: `kind ${kind} not in this list` };

    const data = payload.rendered?.data;
    // The tenant ships no renderer, or it produced nothing. Not an error.
    if (data === undefined)
      return { state: "skipped", detail: "run produced no document" };

    const rule = ruleFor(config, kind);
    // A misspelled rule would silently file every run under the wrong week, and
    // a wrong week is indistinguishable from a missing run to whoever reads it.
    if (typeof rule !== "string")
      return {
        state: "failed",
        detail: `unknown weekKeyRule ${rule.unknown} for kind ${kind}`,
      };
    // The tenant DID produce a document and forgot to version it. Storing it
    // unversioned makes it unreadable the first time its shape changes, which
    // is the one failure that field prevents.
    if (!Number.isInteger(data.schemaVersion))
      return {
        state: "failed",
        detail: "document has no integer schemaVersion",
      };

    const weekKey =
      rule === "previous-iso-week"
        ? previousIsoWeek(isoWeekOf(payload.day))
        : isoWeekOf(payload.day);
    const body = JSON.stringify({
      tenant: payload.tenant,
      kind,
      run_day: payload.day,
      week_key: weekKey,
      run_id: payload.runId,
      code_sha: payload.codeVersion ?? "unknown",
      schema_version: data.schemaVersion,
      outcome: typeof data.outcome === "string" ? data.outcome : "completed",
      headline: typeof data.headline === "string" ? data.headline : "",
      view: data,
      // The transcript, kept BESIDE the document and never merged into it: the
      // document is what a page renders, the transcript is the record of the run
      // that produced it, and a reader must be able to tell them apart.
      report: {
        subject: payload.subject,
        body: payload.body,
        artifacts: payload.artifacts ?? [],
      },
    });

    const url = `${base.replace(/\/+$/, "")}/api/agent-runs`;
    const post = this.deps.fetch ?? (globalThis.fetch as unknown as Poster);
    let detail = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const { status } = await post(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body,
        });
        if (status === 201) return { state: "sent", detail: "created" };
        if (status === 200)
          return { state: "sent", detail: "already stored; ingest is idempotent" };
        // A rejected body is rejected again: retrying wastes the window and
        // hides the reason behind a timeout.
        if (status >= 400 && status < 500)
          return { state: "failed", detail: `HTTP ${String(status)}` };
        detail = `HTTP ${String(status)}`;
      } catch (cause: unknown) {
        detail = cause instanceof Error ? cause.message : String(cause);
      }
      // Two retries and then the audit records it — the next scheduled run
      // posts again. A channel retrying for an hour would hold a run open past
      // the point its numbers were current.
      if (attempt < 3) await this.#sleep(BACKOFF_MS[attempt - 1]!);
    }
    return { state: "failed", detail };
  }

  #sleep(ms: number): Promise<void> {
    return (
      this.deps.sleep ?? ((wait: number) => new Promise((r) => setTimeout(r, wait)))
    )(ms);
  }
}

/** Discovery imports the default export and invokes `.deliver` on it, so the
 *  default must be an INSTANCE. Exporting the class satisfies
 *  `typeof … === "function"` on the constructor and then fails on `deliver`,
 *  and the channel is dropped as "default export is not a Channel" — which is
 *  how the mail channel shipped tested-but-never-loaded until 2026-09-02. */
export default new ArgonChannel();
