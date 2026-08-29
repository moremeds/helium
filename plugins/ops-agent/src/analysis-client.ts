/** Circuit-broken optional analysis: durable unavailability, never control-plane coupling. */
import { randomUUID } from "node:crypto";
import type { OperationsEvent } from "@helium/core";
import type { OpsAnalysisClient } from "./bin/opsd.js";
import type { OperationsStorePort } from "./controller.js";

export class DurableOpsAnalysisClient<T> implements OpsAnalysisClient<T> {
  #failures = 0;
  #retryAtMs = 0;
  #status: "available" | "unavailable" | undefined;

  constructor(
    private readonly options: {
      analysisId: string;
      delegate: OpsAnalysisClient<T>;
      store: OperationsStorePort;
      now: () => Date;
      nextId?: (prefix: string) => string;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
    },
  ) {
    const latest = options.store.state().analysis
      .filter((entry) => entry.analysisId === options.analysisId)
      .at(-1);
    if (latest === undefined) return;
    this.#status = latest.status;
    this.#failures = latest.consecutiveFailures;
    if (latest.status === "unavailable" && latest.retryAt !== undefined) {
      const retryAt = Date.parse(latest.retryAt);
      this.#retryAtMs = Number.isFinite(retryAt) ? retryAt : 0;
    }
  }

  async publish(snapshot: T): Promise<void> {
    const now = this.options.now();
    if (now.getTime() < this.#retryAtMs) return;
    try {
      await this.options.delegate.publish(snapshot);
      const changed = this.#status !== "available";
      this.#failures = 0;
      this.#retryAtMs = 0;
      this.#status = "available";
      if (changed) this.#append("available");
    } catch (error) {
      this.#failures += 1;
      const base = this.options.baseBackoffMs ?? 60_000;
      const max = this.options.maxBackoffMs ?? 3_600_000;
      const delay = Math.min(max, base * (2 ** Math.min(this.#failures - 1, 20)));
      this.#retryAtMs = now.getTime() + delay;
      this.#status = "unavailable";
      this.#append(
        "unavailable",
        error instanceof Error ? error.message : "analysis provider unavailable",
      );
    }
  }

  #append(status: "available" | "unavailable", reason?: string): OperationsEvent {
    return this.options.store.append({
      v: 1,
      id: this.options.nextId?.("evt-analysis-status") ??
        `evt-analysis-status-${randomUUID()}`,
      at: this.options.now().toISOString(),
      type: "analysis-status-recorded",
      analysisId: this.options.analysisId,
      status,
      consecutiveFailures: this.#failures,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 1000) }),
      ...(status === "unavailable"
        ? { retryAt: new Date(this.#retryAtMs).toISOString() }
        : {}),
    });
  }
}
