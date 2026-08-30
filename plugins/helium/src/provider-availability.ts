import { createHash } from "node:crypto";
import {
  AvailabilitySchema,
  type Availability,
  type CapabilityCatalog,
  type ExecutionTargetId,
} from "@helium/core";

export interface ProviderAvailabilitySnapshot {
  version: string;
  domains: Array<{
    quotaDomain: string;
    targets: string[];
    availability: Availability;
  }>;
}

export class ProviderAvailability {
  readonly #domains = new Map<string, ExecutionTargetId[]>();
  readonly #states = new Map<string, Availability>();

  constructor(private readonly capabilities: CapabilityCatalog) {}

  registerDomain(quotaDomain: string, targets: ExecutionTargetId[]): () => void {
    if (quotaDomain.trim() === "") throw new Error("quota domain must not be empty");
    if (this.#domains.has(quotaDomain)) {
      throw new Error(`duplicate quota domain: ${quotaDomain}`);
    }
    const unique = new Set(targets.map(String));
    if (unique.size !== targets.length || targets.length === 0) {
      throw new Error(`quota domain ${quotaDomain} needs unique targets`);
    }
    for (const target of targets) {
      if (this.capabilities.get(target) === undefined) {
        throw new Error(`quota domain names unknown target: ${target}`);
      }
    }
    this.#domains.set(quotaDomain, [...targets]);
    this.#states.set(quotaDomain, { state: "available" });
    return () => {
      this.#domains.delete(quotaDomain);
      this.#states.delete(quotaDomain);
    };
  }

  publish(
    quotaDomain: string,
    input: Availability,
  ): { changed: boolean; snapshot: ProviderAvailabilitySnapshot } {
    const targets = this.#domains.get(quotaDomain);
    if (targets === undefined) throw new Error(`unknown quota domain: ${quotaDomain}`);
    const availability = AvailabilitySchema.parse(input);
    const previous = this.#states.get(quotaDomain);
    if (JSON.stringify(previous) === JSON.stringify(availability)) {
      return { changed: false, snapshot: this.snapshot() };
    }
    for (const target of targets) {
      if (this.capabilities.get(target) === undefined) {
        throw new Error(`quota domain target was disposed: ${target}`);
      }
    }
    for (const target of targets) {
      this.capabilities.setAvailability(target, availability);
    }
    this.#states.set(quotaDomain, availability);
    return { changed: true, snapshot: this.snapshot() };
  }

  snapshot(): ProviderAvailabilitySnapshot {
    const domains = [...this.#domains]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([quotaDomain, targets]) => ({
        quotaDomain,
        targets: targets.map(String).sort(),
        availability: this.#states.get(quotaDomain) ?? { state: "available" as const },
      }));
    const version = createHash("sha256")
      .update(JSON.stringify(domains))
      .digest("hex");
    return { version: `availability-${version}`, domains };
  }
}
