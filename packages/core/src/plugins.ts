/**
 * The plugin interfaces core defines and never implements (design §3).
 *
 * Glob discovery, no registry. Everything dsh already exposes -- the tool
 * contract, session storage, subagent spawning, approval -- is deliberately
 * absent: it is not ours to redefine.
 * @module @helium/core/plugins
 */
import type { ExecutionTargetId } from "./capabilities.js";
import type { LogEvent } from "./fold.js";
import type { RenderedReport } from "./report.js";
import type { WorkOrder } from "./work.js";

/** What a role asks of a model, with no vendor or model name in it. */
export interface AgentRequest {
  role: string;
  requires: string[];
  /** Projected tokens for this step, used for cheapest-capable selection. */
  projectedInputTokens?: number;
  projectedOutputTokens?: number;
}

/**
 * What a provider hands back: which of ITS models it will use, expressed in
 * whatever the runtime underneath needs. Core never parses `options`.
 */
export interface ModelSelection {
  targetId: ExecutionTargetId;
  model: string;
  effort?: string;
  options?: Record<string, unknown>;
}

export interface ProviderModel {
  id: string;
  caps: string[];
  /** USD per token, not per million. Ignored when `unmetered`. */
  usdIn: number;
  usdOut: number;
  maxContextTokens?: number;
  /**
   * The pool this model draws from. Models sharing a domain exhaust TOGETHER:
   * a 429 on one takes the whole domain out of the catalog for the run, so the
   * router stops offering siblings that are already spent. A model on its own
   * domain survives its neighbours' exhaustion, which is the only reason to
   * care — otherwise this would be decoration.
   */
  quotaDomain?: string;
  /**
   * A flat-rate route: a subscription bills a month, not a token. Such a
   * target is registered with NO price, so the router ranks it last rather
   * than treating it as measured-zero and preferring it over every metered
   * model. Its token columns are still real — unmetered is not free.
   */
  unmetered?: boolean;
}

/**
 * A step that did not run. Thrown by `Provider.run` so the runner can tell a
 * spent quota from a broken route WITHOUT parsing a message: the first takes
 * the whole quota domain out of the catalog and re-routes, the second does not.
 */
export class ProviderRunFailure extends Error {
  constructor(
    readonly failureClass: string,
    message: string,
    readonly quotaDomain?: string,
  ) {
    super(message);
    this.name = "ProviderRunFailure";
  }
}

/** One executed step, in the only shape the audit fold reads. */
export interface ModelRun {
  text: string;
  structured?: unknown;
  /** Append-only session log; `foldSessionLog` turns it into spans. */
  events: LogEvent[];
}

/**
 * `plugins/provider-<id>/provider.ts`, `export default`.
 *
 * A dead provider is SKIPPED, not fatal: `probe()` returning false removes its
 * models from the catalog for this run and is recorded as the reason.
 */
export interface Provider {
  id: string;
  capabilities: string[];
  models: ProviderModel[];
  /**
   * Tokens this provider spends before our prompt is counted — its own system
   * preamble or identity block. MEASURED against the wire, never estimated
   * (design §3.1): the router adds it to every candidate's projection, so a
   * model with a cheap per-token rate and a fat preamble loses to a dearer one
   * without. Zero is a legitimate value and must still be stated.
   */
  overheadTokens: number;
  probe(): Promise<boolean>;
  /** Why a failed probe said no. Recorded as the skip reason; never a secret. */
  probeReason?(): string;
  select(request: AgentRequest): ModelSelection;
  /**
   * Execute one routed step. A provider that can route but not yet execute
   * omits this and is skipped at discovery with that reason — better than
   * being selectable and then failing every step it wins.
   */
  run?(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<ModelRun>;
}

export interface GateCtx {
  runId: string;
  role: string;
  /** Remaining budget at the moment the gate runs. */
  remainingUsd?: number;
  /**
   * Everything the tools in this run returned, as raw strings, in order. Core
   * does not read inside them: it is the tenant's gate that decides what "the
   * output must be supported by what a tool said" means for its own domain.
   */
  toolOutputs?: string[];
}

/**
 * `plugins/<name>/gates/<id>.ts`, `export default`. An input gate is its own audited
 * step and runs BEFORE the model call it guards, so a refusal costs a gate row
 * rather than a model call.
 */
export interface Gate {
  id: string;
  /** Role names this gate applies to; `["*"]` for all. */
  appliesTo: string[];
  phase: "input" | "output";
  check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }>;
}

export interface DeliveryPayload {
  tenant: string;
  runId: string;
  subject: string;
  body: string;
  /**
   * `yyyy-mm-dd`: the calendar day this run's output is filed under, in the
   * tenant's `reportTimezone`. The runner computes it ONCE per run and every
   * channel copies it — a channel that reads its own clock instead would name
   * a file for one day while the counter beside it charged another, which is
   * exactly the drift this field removes. Required, so a new channel cannot
   * quietly reintroduce a second date.
   */
  day: string;
  /** Absolute paths of files the channel may attach or reference. */
  artifacts?: string[];
  /**
   * What the tenant's own renderer produced, when it ships one. `subject`/
   * `body` above stay the generic transcript -- that is the durable record and
   * it keeps every piece of run metadata -- so a channel that wants the
   * readable form opts in, and one that wants the record does nothing.
   */
  rendered?: RenderedReport;
  /** The run label. A channel may name its artifact after it; core does not
   *  interpret it. */
  phase?: string;
}

export interface DeliveryOutcome {
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail?: string;
}

/** `plugins/delivery-<id>/channel.ts`, `export default` — an INSTANCE. */
export interface Channel {
  id: string;
  /**
   * Whether delivering sends the report OFF this machine.
   *
   * The `HELIUM_TENANT_DELIVERY` brake exists for exactly one hazard: a run
   * that mails a stranger. A channel that writes a local file carries no such
   * hazard, and holding it behind the same brake would mean an operator has to
   * arm egress to read their own report. Absent is treated as EXTERNAL, so a
   * channel that has not thought about the question stays braked.
   */
  external?: boolean;
  deliver(
    payload: DeliveryPayload,
    config: Record<string, unknown>,
  ): Promise<DeliveryOutcome>;
}

/**
 * How the runner reaches whatever actually executes a work order. The provider
 * plugin owns the runtime; core owns only this call shape.
 */
export interface RoleRunner {
  run(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<{ text: string; structured?: unknown }>;
}
