import type { CoverageDimension, CoverageState } from "./events.js";
import type { ShepherdProjection } from "./reducer.js";

export interface CoverageManifest {
  scopeId: string;
  workUnitIds: string[];
  dimensions: CoverageDimension[];
}

export interface CoverageDimensionReport {
  numerator: number;
  denominator: number;
  states: Partial<Record<CoverageState | "missing", number>>;
}

export interface CoverageReport {
  scopeId: string;
  dimensions: Partial<Record<CoverageDimension, CoverageDimensionReport>>;
}

export class CoverageLedger {
  constructor(private readonly projection: ShepherdProjection) {}

  summarize(manifest: CoverageManifest): CoverageReport {
    assertUnique(manifest.workUnitIds, "work unit");
    assertUnique(manifest.dimensions, "dimension");
    for (const workUnitId of manifest.workUnitIds) {
      if (this.projection.workUnits[workUnitId] === undefined) {
        throw new Error(`unknown work unit in coverage manifest: ${workUnitId}`);
      }
    }

    const dimensions: CoverageReport["dimensions"] = {};
    for (const dimension of manifest.dimensions) {
      const states: CoverageDimensionReport["states"] = {};
      let numerator = 0;
      for (const workUnitId of manifest.workUnitIds) {
        const recorded = this.projection.workUnits[workUnitId]?.coverage[dimension];
        const state = recorded?.state ?? "missing";
        states[state] = (states[state] ?? 0) + 1;
        if (state === "verified") numerator += 1;
      }
      dimensions[dimension] = {
        numerator,
        denominator: manifest.workUnitIds.length,
        states,
      };
    }
    return { scopeId: manifest.scopeId, dimensions };
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`duplicate ${label} in coverage manifest`);
  }
}
