/**
 * The generic observation contract: one probe's reading of one component along
 * one dimension, at a time, with an expiry and the version of the parser that
 * produced it.
 *
 * `state` is a CLOSED four-value enum, and that is deliberate. The audited
 * incidents carried vendor vocabulary -- `recovery_exhausted` from a watchdog
 * log, `healthy` from a status surface -- and admitting those as states would
 * let a probe report something no policy code handles. Raw tool vocabulary
 * lives in `value` and `evidenceRefs`, where nothing branches on it.
 *
 * `parserVersion` is required because probe output is untrusted text whose
 * meaning changes when the parser changes. Without it, a reparse of old
 * evidence is indistinguishable from a fresh reading -- which is precisely the
 * failure mode behind the audited parser-drift case, where a status surface
 * reported coverage far older than the source logs actually implied.
 * @module @helium/core/operations/observation
 */
import { z } from "zod";
import { OpsIdSchema } from "./component.js";

export const OBSERVATION_STATES = ["ok", "degraded", "failed", "unknown"] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** ISO-8601 UTC, validated by shape AND by parseability. */
export const IsoTimestampSchema = z
  .string()
  .refine(
    (v) => ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)),
    "expected an ISO-8601 UTC timestamp, e.g. 2026-08-25T00:00:00.000Z",
  );

export const ObservationSchema = z
  .strictObject({
    version: z.literal(1),
    id: OpsIdSchema,
    componentId: OpsIdSchema,
    probeId: OpsIdSchema,
    /** Optional exact work scope; keeps concurrent bounded repairs disjoint. */
    scopeId: z.string().min(1).max(256).refine((value) => !value.includes("|"), {
      message: "observation scope must not contain the incident-key delimiter",
    }).optional(),
    observedAt: IsoTimestampSchema,
    /**
     * When this reading stops counting as current. An expired observation is
     * `unknown`, never its last known good value -- staleness read as health
     * is what the audited parser-drift case actually was.
     */
    expiresAt: IsoTimestampSchema,
    state: z.enum(OBSERVATION_STATES),
    dimension: z.string().min(1).max(64),
    /** Raw tool payload. Carried as evidence; never branched on by core. */
    value: z.record(z.string(), z.unknown()).optional(),
    evidenceRefs: z.array(z.string().min(1).max(512)),
    parserVersion: z.string().min(1).max(64),
  })
  .refine((o) => Date.parse(o.expiresAt) > Date.parse(o.observedAt), {
    message: "expiresAt must be strictly after observedAt",
    path: ["expiresAt"],
  });
export type Observation = z.infer<typeof ObservationSchema>;

/** Whether a reading still counts as current at `now`. */
export function isFresh(observation: Observation, now: Date): boolean {
  return Date.parse(observation.expiresAt) > now.getTime();
}

/**
 * The state a reading carries at `now`. An expired reading degrades to
 * `unknown` rather than keeping its last value: fail-closed, because the
 * alternative is an incident that never opens.
 */
export function effectiveState(
  observation: Observation,
  now: Date,
): ObservationState {
  return isFresh(observation, now) ? observation.state : "unknown";
}
