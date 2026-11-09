/**
 * What a product bundle sees of helium-base.
 *
 * A bundle ships: agent presets (one per role, listing exactly its tools) and
 * a plugin row whose `apply` calls `definePipeline`. The pipeline is plain
 * code; `run.agent` is the only way it reaches a model.
 */
import type { Capability } from "./models.js";
import type { ChannelName, Doc, Outcome } from "./delivery.js";
import type { LedgerEntry } from "./store.js";

export { clampDates, currentAsOf, withAsOf } from "./asof.js";
export type { Capability } from "./models.js";
export type { ChannelName, Doc, Outcome } from "./delivery.js";
export type { LedgerEntry } from "./store.js";

export interface AgentTask {
  /** Agent preset id; the preset decides which tools the agent sees. */
  role: string;
  /** Audit label when one role runs many times, e.g. `analyst:AAPL`. */
  label?: string;
  capability: Capability;
  prompt: string;
  /** JSON Schema the agent must satisfy through `structured_output`. */
  schema: Record<string, unknown>;
  /** Model steps the agent may start (default 10). The prompt states it; the
   *  runner stops the agent and fails the task when it starts one more. */
  maxSteps?: number;
}

export interface Run {
  id: string;
  bundle: string;
  phase: string | undefined;
  /** yyyy-mm-dd; tools get it through `withAsOf`, never from the model. */
  asOf: string;
  /** Aborts at the run's timeout. */
  signal: AbortSignal;
  /** Runs one child agent; resolves to its structured output or throws. */
  agent<T = unknown>(task: AgentTask): Promise<T>;
  /** Throws if `channel` is not in the pipeline's `channels`. */
  deliver(channel: ChannelName, doc: Doc): Promise<Outcome>;
  /** Records a decision to settle on or after `due` (yyyy-mm-dd). */
  enter(key: string, due: string, payload: unknown): void;
  log(message: string): void;
}

export interface Pipeline {
  name: string;
  /** The only channels this bundle may deliver to. */
  channels: readonly ChannelName[];
  /** IANA zone that names the default as-of day. Default UTC. */
  zone?: string;
  /** Called at run start with entries due on or before as-of. */
  settle?(due: LedgerEntry[], run: Run): Promise<{ id: string; outcome: unknown }[]>;
  run(run: Run): Promise<void>;
}

// ponytail: process-global registry, keyed on globalThis so it survives the
// loader importing this module more than once.
const REGISTRY = Symbol.for("helium.pipelines");
type G = typeof globalThis & { [REGISTRY]?: Map<string, Pipeline> };

export function pipelines(): Map<string, Pipeline> {
  const g = globalThis as G;
  return (g[REGISTRY] ??= new Map());
}

export function definePipeline(p: Pipeline): Pipeline {
  if (pipelines().has(p.name)) throw new Error(`pipeline ${p.name} is defined twice`);
  pipelines().set(p.name, p);
  return p;
}
