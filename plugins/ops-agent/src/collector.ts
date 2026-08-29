/**
 * Bounded, read-only operations observation collection.
 *
 * The collector deliberately receives its sink. It never opens an operations
 * store, event log, or any other writer of its own: the future `helium-opsd`
 * process owns the one authoritative writer and injects its append surface.
 * Probes own their exact argv and timeout and receive only the read-only
 * `CommandRunner` seam.
 * @module dsh-plugin-ops-agent/collector
 */
import { ObservationSchema, type Observation } from "@helium/core";
import type { CommandRunner } from "./probes/process.js";

export interface ObservationProbe {
  readonly probeId: string;
  observe(
    runner: CommandRunner,
    now: Date,
  ): Promise<Observation | readonly Observation[]>;
}

export interface ObservationSink {
  append(observation: Observation): Promise<void>;
}

export interface CollectorFailure {
  probeId: string;
  reason: string;
}

export interface CollectionResult {
  observations: Observation[];
  failures: CollectorFailure[];
}

export interface CollectorOptions {
  probes: readonly ObservationProbe[];
  runner: CommandRunner;
  sink: ObservationSink;
  now: () => Date;
  maxProbes?: number;
}

const DEFAULT_MAX_PROBES = 500;

export class Collector {
  readonly #probes: readonly ObservationProbe[];

  constructor(private readonly options: CollectorOptions) {
    const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
    if (!Number.isInteger(maxProbes) || maxProbes <= 0) {
      throw new Error("collector probe limit must be a positive integer");
    }
    if (options.probes.length > maxProbes) {
      throw new Error(
        `collector probe limit exceeded: ${options.probes.length} > ${maxProbes}`,
      );
    }
    this.#probes = [...options.probes];
  }

  async collectOnce(): Promise<CollectionResult> {
    const observations: Observation[] = [];
    const failures: CollectorFailure[] = [];
    const now = this.options.now();

    for (const probe of this.#probes) {
      let rows: Observation[];
      try {
        const output = await probe.observe(this.options.runner, now);
        const candidates = Array.isArray(output) ? output : [output];
        rows = candidates.map((candidate) => normalize(candidate, now));
      } catch (error) {
        failures.push({
          probeId: probe.probeId,
          reason: error instanceof Error ? error.message : "probe failed",
        });
        continue;
      }

      // Sink failures are intentionally not swallowed. Losing the
      // authoritative append is a collector failure, not a bad probe sample.
      for (const row of rows) {
        await this.options.sink.append(row);
        observations.push(row);
      }
    }

    return { observations, failures };
  }
}

function normalize(candidate: Observation, now: Date): Observation {
  const observation = ObservationSchema.parse(candidate);
  if (Date.parse(observation.expiresAt) > now.getTime()) return observation;
  return {
    ...observation,
    state: "unknown",
    value: { ...observation.value, stale: true },
  };
}
