/**
 * The markdown delivery channel: the run's report, written to a file on the
 * machine that produced it.
 *
 * Why this exists next to `delivery-email`. Email is the channel that carries
 * a report OFF the machine, and everything expensive about it — SMTP
 * credentials, a per-day cap, retry with backoff, an operator brake — is the
 * cost of that one property. A daily report the operator reads on the same
 * laptop needs none of it: no credential, no recipient to get wrong, no
 * half-sent state. So this channel declares `external = false` and the runner
 * lets it write without `HELIUM_TENANT_DELIVERY=1`. The brake guards egress,
 * and a local file is not egress.
 *
 * It is deliberately not a renderer. The body arrives fully formed from the
 * runner (`deliveryBody`), and a second place that decides what a report says
 * is a second place for it to disagree with the audit table.
 * @module dsh-plugin-delivery-markdown/channel
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Channel, DeliveryOutcome, DeliveryPayload } from "@helium/core";

/** `<dir>/<tenant>-<yyyy-mm-dd>-<phase>.md`.
 *
 *  The PHASE is in the name, not the run id. Five scheduled runs a day need
 *  five stable names a later run can find by name (that is what the tenant's
 *  own report-reading tool does), and a second run of the SAME phase is a
 *  correction of that report — overwriting is the intent, not a collision.
 *  The run id lives in the file's header line and in the audit table, which is
 *  where a reader chasing a surprising number goes anyway. A run with no phase
 *  falls back to the run id, so a tenant that never sets one is unchanged. */
function reportPath(dir: string, payload: DeliveryPayload, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const tail = payload.phase ?? payload.runId;
  return join(dir, `${payload.tenant}-${day}-${tail}.md`);
}

export class MarkdownChannel implements Channel {
  readonly id = "markdown";
  /** Stays on this machine, so the egress brake does not apply. */
  readonly external = false;

  constructor(private readonly deps: { now?: () => Date; stateRoot?: string } = {}) {}

  async deliver(
    payload: DeliveryPayload,
    config: Record<string, unknown>,
  ): Promise<DeliveryOutcome> {
    const configured = config.dir;
    if (configured !== undefined && typeof configured !== "string") {
      return { state: "failed", detail: "markdown channel `dir` must be a string" };
    }
    const root =
      this.deps.stateRoot ??
      process.env.HELIUM_STATE_ROOT ??
      resolve(process.cwd(), ".helium-state");
    const dir =
      configured === undefined
        ? join(root, "reports")
        : isAbsolute(configured)
          ? configured
          : resolve(root, configured);
    const path = reportPath(dir, payload, (this.deps.now ?? (() => new Date()))());
    const lines = [
      `# ${payload.subject}`,
      "",
      `- run: \`${payload.runId}\``,
      `- tenant: \`${payload.tenant}\``,
      `- audit: \`helium audit ${payload.runId}\``,
      "",
      payload.body,
    ];
    for (const artifact of payload.artifacts ?? []) lines.push("", `Artifact: \`${artifact}\``);
    lines.push("");
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lines.join("\n"), "utf8");
    } catch (error: unknown) {
      return { state: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    return { state: "sent", detail: path };
  }
}

/** Discovery imports the default export and calls `.deliver` on it, so the
 *  default must be an INSTANCE — a class would pass `typeof … === "function"`
 *  on the constructor and fail on `deliver`. */
export default new MarkdownChannel();
