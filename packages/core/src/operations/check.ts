/**
 * Executable checks: the only thing a precondition, a postcondition, or a
 * pre-action baseline sample may reference.
 *
 * A check is DATA -- a registered read-only probe, structured arguments, and a
 * comparison expressed as an operator and a value. There is no expression
 * language, no check-authoring framework, and no dynamic evaluation, and that
 * is the whole mechanism rather than a first version of one. An expression
 * string is a command surface; a comparison operator is not.
 *
 * Two rules do the safety work:
 *
 *   - A check that cannot run yields `unknown`, never `pass`. Treating
 *     unavailable as passing is how a postcondition set certifies a repair
 *     that never happened.
 *   - A `CheckRef` must resolve at registration. The pre-action baseline has
 *     to RUN every postcondition before the side effect, so a postcondition
 *     cannot be an unresolved reference (review OPS-6).
 * @module @helium/core/operations/check
 */
import { z } from "zod";
import { OpsIdSchema } from "./component.js";

export const CHECK_KINDS = ["liveness", "business"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_OPERATORS = ["eq", "neq", "gte", "lte", "contains"] as const;
export type CheckOperator = (typeof CHECK_OPERATORS)[number];

export const CHECK_RESULTS = ["pass", "fail", "unknown"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

const ScalarSchema = z.union([z.string().max(512), z.number(), z.boolean()]);

export const CheckDefinitionSchema = z.strictObject({
  id: OpsIdSchema,
  /**
   * `liveness` proves something is running; `business` proves it does its job.
   * A mutating SOP whose postconditions are all `liveness` is not certifiable
   * -- "the process came back" is exactly the evidence the audited integrity
   * failure would have passed while staying broken.
   */
  kind: z.enum(CHECK_KINDS),
  probe: z.strictObject({
    probeId: OpsIdSchema,
    args: z.record(z.string().max(64), ScalarSchema),
  }),
  /** How to read the probe result. Data, never an expression string. */
  expect: z.strictObject({
    dimension: z.string().min(1).max(64),
    operator: z.enum(CHECK_OPERATORS),
    value: ScalarSchema,
  }),
  /** Result when the probe cannot run or answer. Closed to one value. */
  onUnavailable: z.literal("unknown"),
  timeoutMs: z.number().int().positive().max(600_000),
  owner: z.string().min(1).max(200),
});
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

/** What running a check's probe produced. */
export interface ProbeReading {
  available: boolean;
  dimension?: string;
  value?: string | number | boolean;
}

/**
 * Compare one probe reading against one check's expectation.
 *
 * Returns `unknown` -- never `pass` and never `fail` -- whenever the reading
 * cannot be compared at all: the probe did not run, it answered a different
 * dimension, or its value type does not match the operator. Guessing in any of
 * those cases manufactures evidence.
 */
export function evaluateCheck(
  check: CheckDefinition,
  reading: ProbeReading,
): CheckResult {
  if (!reading.available) return check.onUnavailable;
  if (reading.dimension !== check.expect.dimension) return "unknown";
  const actual = reading.value;
  const expected = check.expect.value;
  if (actual === undefined) return "unknown";

  switch (check.expect.operator) {
    case "eq":
      return actual === expected ? "pass" : "fail";
    case "neq":
      return actual !== expected ? "pass" : "fail";
    case "gte":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number") {
        return "unknown";
      }
      const ok = check.expect.operator === "gte" ? actual >= expected : actual <= expected;
      return ok ? "pass" : "fail";
    }
    case "contains": {
      if (typeof actual !== "string" || typeof expected !== "string") {
        return "unknown";
      }
      return actual.includes(expected) ? "pass" : "fail";
    }
  }
}

export class CheckRegistry {
  readonly #byId: Map<string, CheckDefinition>;

  private constructor(byId: Map<string, CheckDefinition>) {
    this.#byId = byId;
  }

  /**
   * @param checks - the declared checks, typically loaded from `ops/checks/`.
   * @param registeredProbeIds - every read-only probe the host has registered.
   * @throws on a duplicate id, an invalid definition, or a probe that is not
   * registered. A check naming an unknown probe fails registration rather than
   * loading with a dangling reference.
   */
  static load(
    checks: unknown[],
    registeredProbeIds: readonly string[],
  ): CheckRegistry {
    const probes = new Set(registeredProbeIds);
    const byId = new Map<string, CheckDefinition>();
    for (const raw of checks) {
      const check = CheckDefinitionSchema.parse(raw);
      if (byId.has(check.id)) {
        throw new Error(`duplicate check id: ${check.id}`);
      }
      if (!probes.has(check.probe.probeId)) {
        throw new Error(
          `check ${check.id} names unregistered probe: ${check.probe.probeId}`,
        );
      }
      byId.set(check.id, check);
    }
    return new CheckRegistry(byId);
  }

  get(id: string): CheckDefinition | undefined {
    return this.#byId.get(id);
  }

  ids(): string[] {
    return [...this.#byId.keys()].sort();
  }

  /** @throws naming every reference that does not resolve. */
  resolveAll(refs: readonly string[]): CheckDefinition[] {
    const missing = refs.filter((ref) => !this.#byId.has(ref));
    if (missing.length > 0) {
      throw new Error(`unknown check reference: ${missing.join(", ")}`);
    }
    return refs.map((ref) => this.#byId.get(ref) as CheckDefinition);
  }
}
