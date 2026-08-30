import { randomUUID } from "node:crypto";
import type { HashedArtifactRef, ShepherdWorkUnit } from "./work-unit.js";
import type { ShepherdCoordinator } from "./coordinator.js";
import type { ShepherdScheduler } from "./scheduler.js";
import type { ShepherdStore } from "./store.js";

export interface LivewireProbeOutcome {
  outcome: "completed" | "no-op" | "temporary-unavailable" | "unsafe" | "failed";
  stateHint: "VERIFIED" | "AWAITING_PROVIDER" | "AWAITING_USER" | "QUARANTINED" | "UNRESOLVED";
  evidence?: HashedArtifactRef[];
}

export interface LivewireProbePort {
  probe(input: {
    executorId: string;
    operationId: string;
    workUnit: ShepherdWorkUnit;
    argv: string[];
    signal: AbortSignal;
  }): Promise<LivewireProbeOutcome>;
}

export interface ShepherdCycleResult {
  cycleId: string;
  considered: number;
  decided: number;
  mutationHandoffs: string[];
  failures: Array<{ workUnitId: string; error: string }>;
}

export interface ShepherdDaemonOptions {
  store: ShepherdStore;
  coordinator: ShepherdCoordinator;
  scheduler: ShepherdScheduler;
  scanner: { scan(signal: AbortSignal): Promise<ShepherdWorkUnit[]> };
  bridge: LivewireProbePort;
  executorId: string;
  providerRetryMs: number;
  attemptLeaseMs?: number;
  intervalMs?: number;
  now?: () => Date;
  id?: () => string;
  argvFor?: (workUnit: ShepherdWorkUnit) => string[];
  analysis?: { publish(result: ShepherdCycleResult): Promise<void> };
  onError?: (error: Error) => void;
}

export class ShepherdDaemon {
  #inFlight: Promise<ShepherdCycleResult> | undefined;
  #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #analysisRetryAt = 0;

  constructor(private readonly options: ShepherdDaemonOptions) {
    if (options.intervalMs !== undefined &&
        (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0)) {
      throw new Error("shepherdd interval must be a positive integer");
    }
    if (options.attemptLeaseMs !== undefined &&
        (!Number.isInteger(options.attemptLeaseMs) || options.attemptLeaseMs <= 0)) {
      throw new Error("Shepherd attempt lease must be a positive integer");
    }
  }

  async tickOnce(): Promise<ShepherdCycleResult> {
    if (this.#inFlight !== undefined) return await this.#inFlight;
    const run = this.#runCycle();
    this.#inFlight = run;
    try {
      return await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }

  async start(): Promise<void> {
    if (this.#timer !== undefined) throw new Error("shepherdd already started");
    this.#abort = new AbortController();
    await this.tickOnce();
    const intervalMs = this.options.intervalMs;
    if (intervalMs === undefined) {
      throw new Error("shepherdd interval must be a positive integer");
    }
    this.#timer = setInterval(() => {
      void this.tickOnce().catch((error: unknown) => this.#report(error));
    }, intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    await this.#inFlight?.catch((error: unknown) => this.#report(error));
  }

  async #runCycle(): Promise<ShepherdCycleResult> {
    const signal = this.#abort.signal;
    const reconciled = this.options.coordinator.reconcileExpired();
    const discovered = await this.options.scanner.scan(signal);
    for (const unit of discovered) this.options.coordinator.discover(unit);

    const projection = this.options.store.load();
    const domains: Record<string, { state: "available" | "unavailable" }> = {};
    for (const unit of Object.values(projection.workUnits)) {
      if (unit.unit.scope.kind === "market-partition") {
        domains[unit.unit.scope.provider] = { state: "available" };
      }
      if (unit.state === "AWAITING_PROVIDER" && unit.retry?.domain !== undefined) {
        domains[unit.retry.domain] = { state: "unavailable" };
      }
    }
    const decisions = this.options.scheduler.decide(
      projection,
      { domains },
      { level: "normal" },
      this.#now(),
    );
    const mutationHandoffs = reconciled.mutationRecovery.map((attempt) => attempt.workUnitId);
    const failures: ShepherdCycleResult["failures"] = [];
    for (const decision of decisions) {
      if (decision.disposition === "repair") {
        mutationHandoffs.push(decision.workUnitId);
        continue;
      }
      if (decision.disposition !== "lease") continue;
      const leased = this.options.coordinator.lease(
        decision.workUnitId,
        new Date(this.#now().getTime() + (this.options.attemptLeaseMs ?? 60_000)).toISOString(),
      );
      if (!leased.acquired) continue;
      this.options.coordinator.recordIntent(leased.lease, "probe");
      const current = this.options.store.load().workUnits[decision.workUnitId]!;
      const unit = current.unit;
      let outcome: LivewireProbeOutcome;
      try {
        outcome = await this.options.bridge.probe({
          executorId: this.options.executorId,
          operationId: leased.lease.attemptId,
          workUnit: unit,
          argv: this.options.argvFor?.(unit) ?? [],
          signal,
        });
      } catch (error) {
        failures.push({
          workUnitId: unit.workUnitId,
          error: error instanceof Error ? error.message : "unknown bridge failure",
        });
        this.options.coordinator.recordOutcome(leased.lease, {
          outcome: "failed",
          nextState: "UNRESOLVED",
        });
        continue;
      }
      this.#recordOutcome(leased.lease, unit, current.state, outcome);
    }
    const result: ShepherdCycleResult = {
      cycleId: this.options.id?.() ?? randomUUID(),
      considered: Object.keys(projection.workUnits).length,
      decided: decisions.filter((decision) => decision.disposition !== "wait").length,
      mutationHandoffs,
      failures,
    };
    this.options.coordinator.recordCycle(result.cycleId, result.considered, result.decided);
    if (this.options.analysis !== undefined && this.#now().getTime() >= this.#analysisRetryAt) {
      await this.options.analysis.publish(result).catch((error: unknown) => {
        this.#analysisRetryAt = this.#now().getTime() + this.options.providerRetryMs;
        this.#report(error);
      });
    }
    return result;
  }

  #recordOutcome(
    lease: Parameters<ShepherdCoordinator["recordOutcome"]>[0],
    unit: ShepherdWorkUnit,
    currentState: string,
    outcome: LivewireProbeOutcome,
  ): void {
    if (outcome.outcome === "temporary-unavailable") {
      if (outcome.stateHint === "AWAITING_USER") {
        this.options.coordinator.recordOutcome(lease, { outcome: "awaiting-user", evidence: outcome.evidence });
        return;
      }
      const domain = unit.scope.kind === "market-partition" ? unit.scope.provider : "livewire-research";
      this.options.coordinator.recordOutcome(lease, {
        outcome: "temporary-unavailable",
        availabilityDomain: domain,
        retryAt: new Date(this.#now().getTime() + this.options.providerRetryMs).toISOString(),
        evidence: outcome.evidence,
      });
      return;
    }
    if (outcome.outcome === "completed" || outcome.outcome === "no-op") {
      this.options.coordinator.recordOutcome(lease, {
        outcome: outcome.outcome,
        nextState: currentState === "EVIDENCE_PENDING" ? "ADJUDICATING" : "EVIDENCE_PENDING",
        evidence: outcome.evidence,
      });
      return;
    }
    this.options.coordinator.recordOutcome(lease, {
      outcome: "failed",
      nextState: outcome.outcome === "unsafe" || outcome.stateHint === "QUARANTINED"
        ? "QUARANTINED"
        : "UNRESOLVED",
      evidence: outcome.evidence,
    });
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error("unknown shepherdd failure"));
  }
}
