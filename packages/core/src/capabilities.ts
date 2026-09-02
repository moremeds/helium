/**
 * Capability tags and the opaque execution-target registry.
 *
 * A target is an ID, a flat set of capability tags, the hard constraints it
 * supports, its per-token price, and a dynamic availability state. It is
 * deliberately NOT a vendor or a model: capability requirements go in and an
 * opaque `ExecutionTargetId` comes out, so the router can rank without ever
 * learning who runs the work.
 *
 * v2 note: the v1 `isolationClass` field is gone from the profile. A target's
 * blast radius is now WHERE it runs (the sandbox kind, `sandbox.ts`), not a
 * class the catalog certifies. The executor still declares and proves one at
 * the process boundary; the catalog no longer re-states it.
 * @module @helium/core/capabilities
 */
import { z } from "zod";

/**
 * The closed capability set. Extend by editing this array, never by naming a
 * vendor. A role writes `requires: [code.edit, tool.use]`; the router
 * intersects that with the live catalog.
 */
export const CAPABILITY_TAGS = [
  "reason.deep",
  "reason.fast",
  "code.edit",
  "code.review",
  "tool.use",
  "long.context",
  "cheap.bulk",
  "structured.output",
] as const;
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

/** An opaque handle. Core never parses it and never infers a vendor from it. */
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
  /** Opaque vendor hint; only meaningful for `quota-exhausted`. */
  retryAfter: z.string().min(1).optional(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/**
 * Per-token USD, as the owning plugin declares it. Absent means the target is
 * not metered (a flat-rate subscription); the router treats an unpriced target
 * as free to rank last, never as measured-zero.
 */
export const PriceSchema = z.strictObject({
  usdIn: z.number().nonnegative(),
  usdOut: z.number().nonnegative(),
});
export type Price = z.infer<typeof PriceSchema>;

export const TargetProfileSchema = z.strictObject({
  targetId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  price: PriceSchema.optional(),
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
  price?: Price;
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
}

const AVAILABLE: Availability = { state: "available" };

export class CapabilityCatalog {
  readonly #profiles = new Map<string, TargetProfile>();
  readonly #availability = new Map<string, Availability>();

  /**
   * Register a target profile.
   *
   * @returns a disposer that removes the registration, so a plugin's teardown
   * leaves no ghost target behind.
   * @throws on a duplicate target, a duplicate capability tag, an empty tag
   * set, or any unknown field.
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
    return () => {
      this.#profiles.delete(parsed.targetId);
      this.#availability.delete(parsed.targetId);
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
  }

  /**
   * Whether a target can be given work now. Vendor reset hints are opaque:
   * only an explicit availability publication can restore it.
   */
  available(targetId: ExecutionTargetId): boolean {
    const state = this.#availability.get(targetId) ?? AVAILABLE;
    return state.state === "available";
  }

  /**
   * A frozen value, not a live view: the selector is pure, so it must be
   * handed the catalog it decided on rather than one that can change under it.
   */
  snapshot(): CatalogSnapshot {
    return {
      targets: this.list().map((profile) => ({
        ...profile,
        availability: this.#availability.get(profile.targetId) ?? AVAILABLE,
        available: this.available(profile.targetId),
      })),
    };
  }
}
