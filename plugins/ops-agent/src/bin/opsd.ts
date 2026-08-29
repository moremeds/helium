#!/usr/bin/env node
/**
 * Standalone deterministic operations daemon composition.
 *
 * DSH and model providers are deliberately absent from this module. An
 * optional analysis client receives completed tick snapshots after the
 * authoritative deterministic path has finished; its failure is reported and
 * cannot fail collection, correlation, policy, execution, or verification.
 */
import { Collector, type ObservationProbe } from "../collector.js";
import {
  OpsController,
  type ControllerTickResult,
  type OpsControllerOptions,
} from "../controller.js";
import type { OpsControlServer } from "../ipc.js";
import type { CommandRunner } from "../probes/process.js";

export interface OpsDaemonController<T> {
  tick(signal?: AbortSignal): Promise<T>;
}

export interface OpsDaemonControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OpsAnalysisClient<T = ControllerTickResult> {
  publish(snapshot: T): Promise<void>;
}

export interface OpsDaemonOptions<T> {
  controller: OpsDaemonController<T>;
  control: OpsDaemonControl;
  analysis?: OpsAnalysisClient<T>;
  intervalMs: number;
  onError?: (error: Error) => void;
}

/** Owns the daemon lifecycle and serializes deterministic ticks. */
export class OpsDaemon<T = ControllerTickResult> {
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<T> | undefined;
  #abort: AbortController | undefined;
  #started = false;

  constructor(private readonly options: OpsDaemonOptions<T>) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("opsd interval must be a positive integer");
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("opsd already started");
    this.#started = true;
    this.#abort = new AbortController();
    try {
      await this.options.control.start();
      await this.tickOnce();
      this.#timer = setInterval(() => {
        void this.tickOnce().catch((error: unknown) => this.#report(error));
      }, this.options.intervalMs);
      this.#timer.unref();
    } catch (error) {
      this.#started = false;
      this.#abort.abort();
      this.#abort = undefined;
      await this.options.control.stop().catch((stopError: unknown) => {
        this.#report(stopError);
      });
      throw error;
    }
  }

  async tickOnce(): Promise<T> {
    if (!this.#started || this.#abort === undefined) {
      throw new Error("opsd is not started");
    }
    if (this.#inFlight !== undefined) return await this.#inFlight;

    const run = this.options.controller.tick(this.#abort.signal).then(
      async (snapshot) => {
        if (this.options.analysis !== undefined) {
          await this.options.analysis.publish(snapshot).catch((error: unknown) => {
            this.#report(error);
          });
        }
        return snapshot;
      },
    );
    this.#inFlight = run;
    try {
      return await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
    await this.#inFlight?.catch((error: unknown) => this.#report(error));
    this.#inFlight = undefined;
    await this.options.control.stop();
  }

  #report(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error("unknown opsd failure"),
    );
  }
}

export interface StandaloneOpsDaemonOptions
  extends Omit<OpsControllerOptions, "collect"> {
  probes: readonly ObservationProbe[];
  runner: CommandRunner;
  control: OpsControlServer;
  analysis?: OpsAnalysisClient;
  intervalMs: number;
  onError?: (error: Error) => void;
}

/**
 * The production composition boundary: one controller owns one collector and
 * one control server. Every concrete probe and executor is injected; no DSH or
 * provider package participates in this graph.
 */
export function createStandaloneOpsDaemon(
  options: StandaloneOpsDaemonOptions,
): OpsDaemon {
  const {
    probes,
    runner,
    control,
    analysis,
    intervalMs,
    onError,
    ...controllerOptions
  } = options;
  const controller = new OpsController({
    ...controllerOptions,
    collect: async (sink) =>
      await new Collector({
        probes,
        runner,
        sink,
        now: controllerOptions.now,
      }).collectOnce(),
  });
  return new OpsDaemon({
    controller,
    control,
    ...(analysis === undefined ? {} : { analysis }),
    intervalMs,
    ...(onError === undefined ? {} : { onError }),
  });
}
