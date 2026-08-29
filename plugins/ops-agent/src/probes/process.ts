/**
 * Generic process-liveness probe.
 *
 * It answers only "is this process running", and that is deliberately a
 * LIVENESS check: a running process is not a working one, which is why a
 * mutating SOP cannot be certified on liveness postconditions alone.
 *
 * Read-only by construction. The runner is injected and given exact argv;
 * there is no code path here that signals, starts or stops anything.
 * @module dsh-plugin-ops-agent/probes/process
 */
import type { Observation, ObservationState } from "@helium/core";

export interface CommandResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

export interface CommandRunner {
  /** Run with EXACT argv. Nothing here builds a command string. */
  run(argv: readonly string[], timeoutMs: number): Promise<CommandResult>;
}

export interface ProcessProbeOptions {
  componentId: string;
  probeId?: string;
  /** Exact argv that lists the process. */
  argv: readonly string[];
  /** The process must appear in the output for the probe to report `ok`. */
  match: string;
  timeoutMs?: number;
}

export function classifyProcess(
  result: CommandResult,
  match: string,
): ObservationState {
  // A probe that could not run has NOT proven the process absent.
  if (result.timedOut) return "unknown";
  if (result.exitCode !== 0) return "unknown";
  return result.stdout.includes(match) ? "ok" : "failed";
}

export function processProbe(options: ProcessProbeOptions) {
  const probeId = options.probeId ?? `${options.componentId}.process-liveness.v1`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    probeId,
    argv: options.argv,
    timeoutMs,
    async observe(runner: CommandRunner, now: Date, ttlMs = 300_000): Promise<Observation> {
      const result = await runner.run(options.argv, timeoutMs);
      return {
        version: 1,
        id: `obs-${options.componentId}-process-${now.getTime()}`,
        componentId: options.componentId,
        probeId,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        state: classifyProcess(result, options.match),
        dimension: "readiness",
        value: { matched: result.stdout.includes(options.match), timedOut: result.timedOut },
        evidenceRefs: [`artifact://probe/${probeId}`],
        parserVersion: "process-liveness/1",
      };
    },
  };
}
