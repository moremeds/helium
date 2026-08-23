import { createHash } from "node:crypto";
import {
  nowIso,
  type StateStore,
  type Trigger,
  type TriggerStateChange,
} from "@helium/core";

export interface TriggerEvent {
  job: string;
  kind: Trigger["kind"];
  firedAt: string;
  dedupKey: string;
  payload: Record<string, unknown>;
}

/**
 * Resolve each dot-path against `body`. A path that does not resolve yields `null`
 * (never `undefined`) so JSON.stringify keeps the key and the hash stays stable.
 */
export function extractFields(
  body: unknown,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    let cursor: unknown = body;
    for (const segment of path.split(".")) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    out[path] = cursor === undefined ? null : cursor;
  }
  return out;
}

/** sha256 over the key-sorted JSON projection, truncated to 12 hex chars. */
export function hashFields(x: Record<string, unknown>): string {
  const sorted = Object.keys(x)
    .sort()
    .map((k) => [k, x[k]] as const);
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 12);
}

export type PollState =
  | "baseline"
  | "unchanged"
  | "changed"
  | "deduped"
  | "unknown"
  | "skipped";
export interface PollStatus {
  job: string;
  url: string;
  state: PollState;
  hash?: string;
  error?: string;
}

const FETCH_TIMEOUT_MS = 5_000;

export class StateChangePoller {
  readonly #job: string;
  readonly #trigger: TriggerStateChange;
  readonly #store: StateStore;
  readonly #onTrigger: (ev: TriggerEvent) => void | Promise<void>;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #inFlight = false;

  constructor(opts: {
    job: string;
    trigger: TriggerStateChange;
    store: StateStore;
    onTrigger: (ev: TriggerEvent) => void | Promise<void>;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.#job = opts.job;
    this.#trigger = opts.trigger;
    this.#store = opts.store;
    this.#onTrigger = opts.onTrigger;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * One poll cycle. A tick already in flight makes this call a no-op that
   * reports `skipped` immediately — an overlapping tick against the same
   * StateStore would otherwise race dedup/baseline writes (plan-mandated
   * guard; mirrors the spike's `busy` flag).
   */
  async tick(): Promise<PollStatus> {
    if (this.#inFlight) {
      return { job: this.#job, url: this.#trigger.url, state: "skipped" };
    }
    this.#inFlight = true;
    try {
      return await this.#doTick();
    } finally {
      this.#inFlight = false;
    }
  }

  async #doTick(): Promise<PollStatus> {
    const url = this.#trigger.url;
    let fields: Record<string, unknown>;
    try {
      const res = await this.#fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // A timeout or an error status is not proof of death (spec §4): report unknown.
        return {
          job: this.#job,
          url,
          state: "unknown",
          error: `HTTP ${res.status}`,
        };
      }
      fields = extractFields(await res.json(), this.#trigger.fields);
    } catch (error: unknown) {
      return {
        job: this.#job,
        url,
        state: "unknown",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const hash = hashFields(fields);
    const now = this.#now();
    const state = this.#store.loadSensor(this.#job);

    for (const [key, expiry] of Object.entries(state.dedup)) {
      if (Date.parse(expiry) <= now.getTime()) delete state.dedup[key];
    }

    if (!state.baseline) {
      state.baseline = { hash, fields };
      this.#store.saveSensor(this.#job, state);
      return { job: this.#job, url, state: "baseline", hash };
    }
    if (state.baseline.hash === hash) {
      this.#store.saveSensor(this.#job, state);
      return { job: this.#job, url, state: "unchanged", hash };
    }

    const previous = state.baseline.fields;
    const dedupKey = `${this.#job}:${url}:${hash}`;
    const suppressed = state.dedup[dedupKey] !== undefined;
    state.baseline = { hash, fields };
    if (!suppressed) {
      state.dedup[dedupKey] = new Date(
        now.getTime() + this.#trigger.dedupTtlMs,
      ).toISOString();
    }
    // Persist BEFORE dispatching: a crash mid-dispatch must not re-fire the same change on
    // restart (spec §13 AC#2 — no duplicate alerts on recovery).
    this.#store.saveSensor(this.#job, state);
    if (suppressed) return { job: this.#job, url, state: "deduped", hash };

    await this.#onTrigger({
      job: this.#job,
      kind: "state-change",
      firedAt: nowIso(),
      dedupKey,
      payload: { url, previous, current: fields },
    });
    return { job: this.#job, url, state: "changed", hash };
  }
}
