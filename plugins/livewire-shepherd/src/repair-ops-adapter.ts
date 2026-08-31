/** Bridge durable REPAIR_READY work into scoped Ops incidents and exact actions. */
import { createHash } from "node:crypto";
import type { Incident } from "@helium/core/operations/incident.js";
import type { CheckDefinition } from "@helium/core/operations/check.js";
import type { Observation } from "@helium/core/operations/observation.js";
import type { SopDefinition } from "@helium/core/operations/sop.js";
import type { CommandRunner, ObservationProbe } from "dsh-plugin-ops-agent";
import type { ShepherdProjection, WorkUnitProjection } from "./reducer.js";
import type { ShepherdPreparedRepair } from "./repair-controller.js";

export interface ShepherdRepairOpsAdapterOptions {
  store: { load(): ShepherdProjection };
  preparer: { prepare(projection: WorkUnitProjection): ShepherdPreparedRepair };
  componentId: string;
  sopId: string;
  ttlMs: number;
  probeId?: string;
}

export class ShepherdRepairOpsAdapter implements ObservationProbe {
  readonly probeId: string;

  constructor(private readonly options: ShepherdRepairOpsAdapterOptions) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Shepherd Ops observation TTL must be a positive integer");
    }
    this.probeId = options.probeId ?? "livewire.repair-ready.v1";
  }

  async observe(_runner: CommandRunner, now: Date): Promise<Observation[]> {
    const ready = Object.values(this.options.store.load().workUnits)
      .filter((projection) => projection.state === "REPAIR_READY")
      .sort((a, b) => a.unit.workUnitId.localeCompare(b.unit.workUnitId));
    return ready.map((projection) => this.#observeProjection(projection, now));
  }

  prepareAction(
    sop: SopDefinition,
    incident: Incident,
    signedVerificationPolicy: { postconditions: CheckDefinition[]; graceMs: number },
  ): ShepherdPreparedRepair {
    if (sop.id !== this.options.sopId) {
      throw new Error(`Shepherd Ops adapter refuses unregistered SOP: ${sop.id}`);
    }
    if (incident.scopeId === undefined) {
      throw new Error("Shepherd Ops incident is missing its exact repair scope");
    }
    const projection = Object.values(this.options.store.load().workUnits).find(
      (candidate) => repairScopeId(candidate) === incident.scopeId,
    );
    if (projection === undefined || projection.state !== "REPAIR_READY") {
      throw new Error(`Shepherd Ops repair scope is no longer ready: ${incident.scopeId}`);
    }
    const prepared = this.options.preparer.prepare(projection);
    if (prepared.scopeId !== incident.scopeId) {
      throw new Error("Shepherd Ops preparer returned a different repair scope");
    }
    if (sop.postconditions.length !== 1 || signedVerificationPolicy.postconditions.length !== 1) {
      throw new Error("Shepherd repair SOP requires exactly one manifest-bound postcondition");
    }
    const signedCheck = signedVerificationPolicy.postconditions[0]!;
    if (signedCheck.id !== sop.postconditions[0] ||
        signedCheck.probe.probeId !== "livewire.repair-postcondition.v1") {
      throw new Error("Shepherd repair postcondition differs from the signed check template");
    }
    const expectedRevision = projection.revision;
    const expectedScopeId = incident.scopeId;
    return {
      ...prepared,
      preSpawn: () => {
        const current = this.options.store.load().workUnits[projection.unit.workUnitId];
        if (current === undefined || current.state !== "REPAIR_READY" ||
            current.revision !== expectedRevision || repairScopeId(current) !== expectedScopeId) {
          throw new Error(`Shepherd Ops repair scope advanced before spawn: ${expectedScopeId}`);
        }
        prepared.preSpawn();
      },
      verificationPolicy: {
        postconditions: [{
          ...signedCheck,
          probe: {
            ...signedCheck.probe,
            args: { manifest: prepared.manifest.path },
          },
        }],
        graceMs: signedVerificationPolicy.graceMs,
      },
    };
  }

  #observeProjection(projection: WorkUnitProjection, now: Date): Observation {
    const scopeId = repairScopeId(projection);
    let state: Observation["state"] = "failed";
    let evidenceRefs: string[];
    let value: Record<string, unknown>;
    try {
      const prepared = this.options.preparer.prepare(projection);
      if (prepared.scopeId !== scopeId) {
        throw new Error("preparer returned a different repair scope");
      }
      evidenceRefs = prepared.inputArtifacts.map((artifact) => artifact.ref).sort();
      value = {
        preparation: "ready",
        workUnitId: projection.unit.workUnitId,
        revision: projection.revision,
      };
    } catch (error) {
      state = "unknown";
      evidenceRefs = Object.values(projection.evidence).map((evidence) => evidence.ref).sort();
      value = {
        preparation: "refused",
        reason: error instanceof Error ? error.message : "unknown preparation failure",
        workUnitId: projection.unit.workUnitId,
        revision: projection.revision,
      };
    }
    const observedAt = now.toISOString();
    const idInput = `${scopeId}\u0000${projection.revision}\u0000${observedAt}\u0000${state}`;
    return {
      version: 1,
      id: `obs-livewire-repair-${createHash("sha256").update(idInput).digest("hex").slice(0, 32)}`,
      componentId: this.options.componentId,
      probeId: this.probeId,
      scopeId,
      observedAt,
      expiresAt: new Date(now.getTime() + this.options.ttlMs).toISOString(),
      state,
      dimension: "integrity",
      value,
      evidenceRefs,
      parserVersion: "livewire-repair-ready/1",
    };
  }
}

export function repairScopeId(projection: WorkUnitProjection): string {
  return `${projection.unit.workUnitId}:${projection.unit.scopeHash}`;
}
