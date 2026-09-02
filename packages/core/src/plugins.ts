/**
 * The plugin interfaces core defines and never implements (design §3).
 *
 * Glob discovery, no registry. Everything dsh already exposes -- the tool
 * contract, session storage, subagent spawning, approval -- is deliberately
 * absent: it is not ours to redefine.
 * @module @helium/core/plugins
 */
import type { ExecutionTargetId } from "./capabilities.js";
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
  /** USD per token, not per million. */
  usdIn: number;
  usdOut: number;
  maxContextTokens?: number;
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
  probe(): Promise<boolean>;
  /** Why a failed probe said no. Recorded as the skip reason; never a secret. */
  probeReason?(): string;
  select(request: AgentRequest): ModelSelection;
}

export interface GateCtx {
  runId: string;
  role: string;
  /** Remaining budget at the moment the gate runs. */
  remainingUsd?: number;
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
  /** Absolute paths of files the channel may attach or reference. */
  artifacts?: string[];
}

export interface DeliveryOutcome {
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail?: string;
}

/** `plugins/delivery-<id>/channel.ts`, `export default`. */
export interface Channel {
  id: string;
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
