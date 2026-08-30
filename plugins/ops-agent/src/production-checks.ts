/** Fresh executable checks backed by the real read-only production probes. */
import {
  ObservationSchema,
  effectiveState,
  evaluateCheck,
  type CheckDefinition,
  type Observation,
  type PostconditionSample,
  type ProbeReading,
} from "@helium/core";
import type { ObservationProbe } from "./collector.js";
import type { CommandRunner } from "./probes/process.js";
import {
  createConfiguredHostProbes,
  createUnpacedProductionObservationProbes,
  ProductionObservationTargetsSchema,
  type ProductionObservationRuntime,
  type ProductionObservationTargets,
} from "./production-observations.js";

export interface CheckObservationSource {
  readonly probe: ObservationProbe;
  readonly outputProbeIds: readonly string[];
}

type Projection = (observation: Observation) => ProbeReading;

const projections: Readonly<Record<string, Projection>> = {
  "colima.container-inventory.v1": (observation) => {
    const missing = arrayValue(observation.value?.missing);
    return {
      available: missing !== undefined,
      dimension: "expected-set",
      value: missing === undefined ? undefined : missing.length === 0,
    };
  },
  "colima.guest-runtime.v1": (observation) => ({
    available: booleanValue(observation.value?.ready) !== undefined,
    dimension: "readiness",
    value: booleanValue(observation.value?.ready),
  }),
  "colima.vm-state.v1": (observation) => ({
    available: stringValue(observation.value?.vmState) !== undefined,
    dimension: "readiness",
    value: stringValue(observation.value?.vmState) === "running",
  }),
  "host.volume.data-lake.v1": (observation) => ({
    available: booleanValue(objectValue(observation.value?.identity)?.ok) !== undefined,
    dimension: "mount-identity",
    value: booleanValue(objectValue(observation.value?.identity)?.ok),
  }),
  "livewire.status-parser.v1": (observation) => {
    const found = booleanValue(observation.value?.found);
    const coverage = numberValue(observation.value?.intradayCoverage);
    return {
      available: found !== undefined,
      dimension: "source-available",
      value: found,
      ...(coverage === undefined ? {} : { coverage }),
    } as ProbeReading;
  },
  "livewire.parquet-integrity.v1": (observation) => ({
    available: booleanValue(observation.value?.valid) !== undefined,
    dimension: "integrity",
    value: booleanValue(observation.value?.valid),
  }),
  "livewire.coverage-freshness.v1": (observation) => ({
    available: true,
    dimension: "target-freshness",
    value: observation.state === "ok",
  }),
};

/**
 * Executes each underlying snapshot once per sample batch, then applies only
 * compiled projections. YAML can select a registered probe and comparison;
 * it cannot select object fields or provide an expression.
 */
export class ProductionCheckRuntime {
  readonly #sourceByProbeId = new Map<string, CheckObservationSource>();

  constructor(sources: readonly CheckObservationSource[]) {
    for (const source of sources) {
      for (const probeId of source.outputProbeIds) {
        if (projections[probeId] === undefined) {
          throw new Error(`runtime check probe has no compiled projection: ${probeId}`);
        }
        if (this.#sourceByProbeId.has(probeId)) {
          throw new Error(`duplicate runtime check probe: ${probeId}`);
        }
        this.#sourceByProbeId.set(probeId, source);
      }
    }
  }

  probeIds(): string[] {
    return [...this.#sourceByProbeId.keys()].sort();
  }

  async sample(
    checks: readonly CheckDefinition[],
    _phase: "baseline" | "postcondition",
    runner: CommandRunner,
    now: Date,
  ): Promise<PostconditionSample[]> {
    const neededSources = new Set<CheckObservationSource>();
    for (const check of checks) {
      const source = this.#sourceByProbeId.get(check.probe.probeId);
      if (source === undefined) {
        throw new Error(`check names unregistered runtime probe: ${check.probe.probeId}`);
      }
      neededSources.add(source);
    }

    const observations = new Map<string, Observation>();
    for (const source of neededSources) {
      const declaredOutputs = new Set(source.outputProbeIds);
      const output = await source.probe.observe(runner, now);
      const candidates = Array.isArray(output) ? output : [output];
      for (const candidate of candidates) {
        const parsed = ObservationSchema.parse(candidate);
        if (!declaredOutputs.has(parsed.probeId)) continue;
        if (observations.has(parsed.probeId)) {
          throw new Error(`fresh check source emitted duplicate observation: ${parsed.probeId}`);
        }
        observations.set(parsed.probeId, parsed);
      }
    }

    return checks.map((check) => {
      const observation = observations.get(check.probe.probeId);
      if (observation === undefined) {
        throw new Error(`fresh check source did not emit: ${check.probe.probeId}`);
      }
      if (observation.evidenceRefs.length === 0) {
        throw new Error(`fresh check observation has no evidence: ${check.probe.probeId}`);
      }
      const projection = projections[check.probe.probeId];
      if (projection === undefined) {
        throw new Error(`fresh check projection disappeared: ${check.probe.probeId}`);
      }
      const reading = effectiveState(observation, now) === "unknown"
        ? { available: false }
        : projectForExpectation(projection(observation), check);
      return {
        checkId: check.id,
        state: evaluateCheck(check, reading),
        observedAt: observation.observedAt,
        evidenceRefs: [...observation.evidenceRefs],
      };
    });
  }
}

export function createProductionCheckRuntime(
  input: ProductionObservationTargets,
  runtime: ProductionObservationRuntime,
): ProductionCheckRuntime {
  const targets = ProductionObservationTargetsSchema.parse(input);
  const hostVolumes = createConfiguredHostProbes(targets)
    .find((probe) => probe.probeId === "host.volumes.v1");
  const snapshots = createUnpacedProductionObservationProbes(targets, runtime);
  const livewire = snapshots.find((probe) => probe.probeId === "livewire.production-snapshot.v1");
  const colima = snapshots.find((probe) => probe.probeId === "colima.production-snapshot.v1");
  if (hostVolumes === undefined || livewire === undefined || colima === undefined) {
    throw new Error("production check runtime is missing a required snapshot probe");
  }
  return new ProductionCheckRuntime([
    {
      probe: hostVolumes,
      outputProbeIds: ["host.volume.data-lake.v1"],
    },
    {
      probe: livewire,
      outputProbeIds: [
        "livewire.status-parser.v1",
        "livewire.parquet-integrity.v1",
        "livewire.coverage-freshness.v1",
      ],
    },
    {
      probe: colima,
      outputProbeIds: [
        "colima.container-inventory.v1",
        "colima.guest-runtime.v1",
        "colima.vm-state.v1",
      ],
    },
  ]);
}

function projectForExpectation(reading: ProbeReading, check: CheckDefinition): ProbeReading {
  if (check.probe.probeId === "livewire.status-parser.v1" && check.expect.dimension === "coverage") {
    const coverage = (reading as ProbeReading & { coverage?: number }).coverage;
    return coverage === undefined
      ? { available: false }
      : { available: true, dimension: "coverage", value: coverage };
  }
  return reading;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
