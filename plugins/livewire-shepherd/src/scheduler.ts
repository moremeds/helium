import type { ShepherdProjection, WorkUnitProjection } from "./reducer.js";

export interface ProviderAvailability {
  domains: Record<string, { state: "available" | "unavailable" | "quota-exhausted" }>;
}

export interface ResourcePressure {
  level: "normal" | "high";
}

export interface ShepherdDecision {
  workUnitId: string;
  disposition: "lease" | "wait" | "fanout" | "repair" | "verify";
  reason?: string;
  wakeAt?: string;
}

export class ShepherdScheduler {
  decide(
    projection: ShepherdProjection,
    availability: ProviderAvailability,
    pressure: ResourcePressure,
    now: Date,
  ): ShepherdDecision[] {
    return Object.values(projection.workUnits)
      .sort((left, right) =>
        priorityFor(left) - priorityFor(right)
        || left.discoveredAt.localeCompare(right.discoveredAt)
        || left.unit.workUnitId.localeCompare(right.unit.workUnitId))
      .map((unit) => this.#decideUnit(unit, availability, pressure, now));
  }

  #decideUnit(
    unit: WorkUnitProjection,
    availability: ProviderAvailability,
    pressure: ResourcePressure,
    now: Date,
  ): ShepherdDecision {
    const workUnitId = unit.unit.workUnitId;
    if (unit.activeLease !== undefined) {
      return { workUnitId, disposition: "wait", reason: "active-lease" };
    }
    if (unit.state === "AWAITING_USER") {
      return wait(unit, "awaiting-user");
    }
    if (unit.state === "AWAITING_PROVIDER") {
      const domain = unit.retry?.domain ?? providerFor(unit);
      if (availability.domains[domain]?.state === "available") {
        return { workUnitId, disposition: "lease" };
      }
      if (unit.retry?.trigger === "time" && Date.parse(unit.retry.wakeAt) <= now.getTime()) {
        return { workUnitId, disposition: "lease" };
      }
      return wait(unit, "awaiting-provider");
    }
    if (unit.state === "ADJUDICATING") {
      return pressure.level === "high"
        ? wait(unit, "resource-pressure")
        : { workUnitId, disposition: "fanout" };
    }
    if (unit.state === "VERIFYING") {
      return { workUnitId, disposition: "verify" };
    }
    if (unit.state === "REPAIR_READY") {
      return { workUnitId, disposition: "repair" };
    }
    if (["DISCOVERED", "EVIDENCE_PENDING", "RETRY_SCHEDULED"].includes(unit.state)) {
      if (unit.retry !== undefined && unit.retry.trigger === "time" &&
          Date.parse(unit.retry.wakeAt) > now.getTime()) {
        return wait(unit, "retry-not-due");
      }
      return { workUnitId, disposition: "lease" };
    }
    return wait(unit, `state-${unit.state.toLowerCase()}`);
  }
}

function priorityFor(unit: WorkUnitProjection): number {
  if (unit.state === "VERIFYING") return 0;
  if (unit.state === "REPAIR_READY") return 1;
  if (["DISCOVERED", "EVIDENCE_PENDING", "RETRY_SCHEDULED"].includes(unit.state)) return 2;
  if (unit.state === "ADJUDICATING") return 3;
  return 4;
}

function wait(unit: WorkUnitProjection, reason: string): ShepherdDecision {
  return {
    workUnitId: unit.unit.workUnitId,
    disposition: "wait",
    reason,
    ...(unit.retry?.wakeAt === undefined ? {} : { wakeAt: unit.retry.wakeAt }),
  };
}

function providerFor(unit: WorkUnitProjection): string {
  return unit.unit.scope.kind === "market-partition"
    ? unit.unit.scope.provider
    : "research";
}
