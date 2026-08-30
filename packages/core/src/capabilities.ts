/**
 * The opaque execution-target registry.
 *
 * A target is an ID, a flat set of capability tags, a declared isolation
 * class, the hard constraints it supports, and a dynamic availability state.
 * It is deliberately NOT a provider or a model: the whole point of the seam is
 * that capability requirements go in and an opaque `ExecutionTargetId` comes
 * out, so scoring can be added later without touching the work-order contract.
 *
 * SCOPE (thin selector v1). This ships the seam, not the scoring machinery.
 * The 31-leaf capability ontology, per-capability scores, confidence
 * intervals, evaluation suite/version and `sampleCount` are deferred v2
 * pending real usage data -- a session-capped subscription cannot produce an
 * `n` that makes a confidence interval mean anything, and the number would
 * launder a guess. The schema is strict so that such a field arriving early
 * fails loud instead of sitting unused, where a later reader would mistake it
 * for a measurement.
 *
 * `isolationClass` here is a CLAIM the catalog records. The
 * execution-boundary conformance suite is what proves it, and the executor
 * registry (Task 10) is what refuses to register a target whose claim has no
 * passing conformance record -- so by the time a profile reaches this catalog
 * its class has been demonstrated.
 * @module @helium/core/capabilities
 */
import { z } from "zod";
import { ISOLATION_CLASSES, type IsolationClass } from "./work.js";

/** An opaque handle. Core never parses it and never infers a provider from it. */
export type ExecutionTargetId = string & {
  readonly __brand: "ExecutionTargetId";
};

export function ExecutionTargetId(raw: string): ExecutionTargetId {
  if (raw.trim() === "") throw new Error("execution target id must not be empty");
  return raw as ExecutionTargetId;
}

export const AVAILABILITY_STATES = [
  "available",
  "quota-exhausted",
  "unavailable",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const AvailabilitySchema = z.strictObject({
  state: z.enum(AVAILABILITY_STATES),
  /** Opaque provider hint; only meaningful for `quota-exhausted`. */
  retryAfter: z.string().min(1).optional(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

export const TargetProfileSchema = z.strictObject({
  targetId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  isolationClass: z.enum(ISOLATION_CLASSES),
  operations: z.strictObject({
    maxLatencyMs: z.number().int().positive().optional(),
    maxContextTokens: z.number().int().positive().optional(),
  }),
  supports: z.strictObject({
    structuredOutput: z.boolean(),
    toolIsolation: z.boolean(),
    mutations: z.boolean(),
  }),
});

export interface TargetProfile {
  targetId: ExecutionTargetId;
  capabilities: string[];
  isolationClass: IsolationClass;
  operations: { maxLatencyMs?: number; maxContextTokens?: number };
  supports: {
    structuredOutput: boolean;
    toolIsolation: boolean;
    mutations: boolean;
  };
}

/** One target as the pure selector sees it: profile plus resolved availability. */
export interface TargetSnapshot extends TargetProfile {
  available: boolean;
  availability: Availability;
}

export interface CatalogSnapshot {
  targets: TargetSnapshot[];
  /** Advances on every mutation, so a decision can name the catalog it saw. */
  catalogVersion: string;
}

const AVAILABLE: Availability = { state: "available" };

export class CapabilityCatalog {
  readonly #profiles = new Map<string, TargetProfile>();
  readonly #availability = new Map<string, Availability>();
  #version = 0;

  /**
   * Register a target profile.
   *
   * @returns an effect-scoped disposer that removes the registration, so a
   * plugin's `ctx.effect` teardown leaves no ghost target behind.
   * @throws on a duplicate target, a duplicate capability tag, an empty tag
   * set, an unknown isolation class, or any deferred v2 / provider field.
   */
  register(profile: TargetProfile): () => void {
    const parsed = TargetProfileSchema.parse(profile);
    if (this.#profiles.has(parsed.targetId)) {
      throw new Error(`duplicate target: ${parsed.targetId}`);
    }
    const unique = new Set(parsed.capabilities);
    if (unique.size !== parsed.capabilities.length) {
      throw new Error(`duplicate capability tag on target ${parsed.targetId}`);
    }
    this.#profiles.set(parsed.targetId, profile);
    this.#version += 1;
    return () => {
      this.#profiles.delete(parsed.targetId);
      this.#availability.delete(parsed.targetId);
      this.#version += 1;
    };
  }

  get(targetId: ExecutionTargetId): TargetProfile | undefined {
    return this.#profiles.get(targetId);
  }

  list(): TargetProfile[] {
    return [...this.#profiles.values()];
  }

  /** Availability is dynamic and deliberately separate from the profile. */
  setAvailability(targetId: ExecutionTargetId, availability: Availability): void {
    if (!this.#profiles.has(targetId)) {
      throw new Error(`unknown target: ${targetId}`);
    }
    this.#availability.set(targetId, AvailabilitySchema.parse(availability));
    this.#version += 1;
  }

  /**
   * Whether a target can be given work now. Provider reset hints are opaque:
   * only an explicit provider-owned availability publication can restore it.
   */
  available(targetId: ExecutionTargetId, _now: Date): boolean {
    const state = this.#availability.get(targetId) ?? AVAILABLE;
    return state.state === "available";
  }

  /**
   * A frozen value, not a live view: the selector is pure, so it must be
   * handed the catalog it decided on rather than one that can change under it.
   */
  snapshot(now: Date): CatalogSnapshot {
    const version = `catalog-${this.#version}`;
    return {
      catalogVersion: version,
      targets: this.list().map((profile) => ({
        ...profile,
        availability: this.#availability.get(profile.targetId) ?? AVAILABLE,
        available: this.available(profile.targetId, now),
      })),
    };
  }
}
