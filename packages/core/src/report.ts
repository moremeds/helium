/**
 * What one run produced, as a value. It lives in core rather than in the CLI
 * for one reason: a tenant that renders its own delivery must be able to name
 * this type, and a tenant may not depend on the CLI.
 *
 * Core does not INTERPRET any of it. `text` is an opaque string here; whoever
 * wrote it is the only one who knows what it means (doctrine 2).
 * @module @helium/core/report
 */
import type { TenantSpec } from "./tenant.js";

export interface StepReport {
  task: string;
  role: string;
  mode: "model" | "tool-only" | "deterministic";
  targetId?: string;
  downgradeReason?: string;
  text: string;
  failure?: string;
  /** Gates that said no. An input refusal means no model call was made. */
  gateRefusals?: Array<{ id: string; reason: string }>;
  /**
   * What this step's tools ANSWERED, verbatim, when it called any.
   *
   * The gates already receive these; a tenant renderer did not, and so had no
   * way to check a model's claim against the data the model was looking at. A
   * settlement citing an id no tool ever returned is indistinguishable from a
   * real one until you can read the tool's own reply.
   */
  toolOutputs?: string[];
}

export interface DeliveryReport {
  channel: string;
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail?: string;
}

export interface RunReport {
  runId: string;
  tenant: string;
  mode: "model" | "tool-only";
  /** The run label this run was started with. Opaque to core; the tenant and
   *  the delivery channels are the only things that know what it means. */
  phase: string;
  /**
   * `yyyy-mm-dd`: the day this run's output is filed under, in the tenant's
   * `reportTimezone`. Resolved once at the start of the run and carried, so the
   * report file name, the delivery subject, the per-day delivery counter and
   * whatever the tenant's own renderer prints all name the same date.
   */
  day: string;
  providersLive: string[];
  providersSkipped: Array<{ id: string; reason: string }>;
  steps: StepReport[];
  outcome: "completed" | "failed";
  failure?: { class: string; detail: string };
  /** Gates that failed to LOAD. A gate that stopped loading stopped guarding. */
  gatesSkipped: Array<{ id: string; reason: string }>;
  /**
   * Set when a tenant ships a renderer and it failed to load or threw. Its own
   * field, not a row in `gatesSkipped`: a gate that stopped loading stopped
   * GUARDING, while a renderer that stopped loading only costs the reader the
   * pretty form. Folding the two together would make an email-formatting bug
   * look like a safety check went missing.
   */
  rendererSkipped?: { reason: string };
  /**
   * Set when the run did not proceed at all because the tenant's `calendar`
   * says this `day` is closed. Not a failure: the scheduler fires every day and
   * the tenant decides which of those days it has anything to say about, so a
   * closed day is a completed run that produced nothing and delivered nothing.
   * Its own field rather than `failure`, because a closed day that exits
   * nonzero would train an operator to ignore the one signal that means the
   * cron is broken.
   */
  skipped?: { reason: string };
  /** One entry per `delivery:` block in tenant.yaml. Empty when none declared. */
  delivery: DeliveryReport[];
  /** Tools this machine cannot serve: their `requiresEnv` key is unset. */
  toolsUnconfigured: string[];
  /**
   * The instant this run was told to treat as now, ISO, when it was replaying
   * a past one. Absent on an ordinary run — its clock is the wall clock and
   * saying so on every report would only teach a reader to skip the line.
   */
  asOf?: string;
  /** The run's flavour label, so two replays of one instant stay apart. */
  variant?: string;
  /**
   * How much of the tool surface could answer for `asOf`. A replay whose
   * sources are mostly live-only is not a failed run and not a normal one
   * either: the number is what stops a reader treating a thin replay as the
   * same evidence as a full one. Absent when the run is not a replay.
   */
  pitCoverage?: {
    available: number;
    total: number;
    /** Tool names with no history for `asOf`, in call-agnostic sorted order. */
    unavailable: string[];
  };
}

/** What a tenant's own renderer produces. `html` is optional; `text` is not. */
export interface RenderedReport {
  /**
   * Optional, and omitting it is a real choice rather than an oversight.
   *
   * A renderer is handed the report, not the run label, so a subject minted
   * here cannot say which of the day's runs produced it — and it OVERRIDES the
   * one the runner built, which can. A tenant whose renderer set this had every
   * run of the day arrive under one identical subject line. Leave it unset and
   * the delivery channel uses the runner's.
   */
  subject?: string;
  text: string;
  html?: string;
  /**
   * The structured document the tenant's renderer built, for a channel that
   * wants the DATA rather than the prose. Opaque: core never reads inside it,
   * never validates it, never learns a key name from it — the same rule that
   * keeps `toolOutputs` a string.
   *
   * A channel that writes to a database needs the shape, not the rendering;
   * the alternative is a channel parsing the HTML the email channel sends,
   * which makes every renderer change a silent data corruption somewhere else.
   */
  data?: Record<string, unknown>;
}

/**
 * `plugins/<tenant>/render/index.ts`, `export default`. Optional: a tenant that
 * ships none gets the generic transcript, unchanged.
 */
export type TenantRenderer = (
  report: RunReport,
  cfg: TenantSpec,
) => RenderedReport;
