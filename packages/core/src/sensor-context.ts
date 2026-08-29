/**
 * The context a sensor is handed. Type-only: it declares the sensor context,
 * not any sensor.
 *
 * This type is the static half of design §5.5's edge rule -- no sensor can
 * bypass the controller to call a provider -- and of acceptance criterion 15.
 * A sensor normalizes an observation and appends it. It does not dispatch, it
 * does not hold an executor, a registry handle, a lease, a run, or a provider
 * adapter, and when it cannot observe, its state stays `unknown` rather than
 * becoming a model call.
 *
 * Adding any of those members here must break `pnpm typecheck`, not merely one
 * suite: `contracts/tests/topology-structure.contract.spec.ts` asserts their
 * absence as a compile-time exclusion over `keyof SensorContext`.
 * @module @helium/core/sensor-context
 */

/** What a sensor may not conclude when it cannot observe. Never a model call. */
export type SensorState<T> = { known: true; value: T } | { known: false };

export interface SensorContext<TEvent = unknown, TObservation = unknown> {
  /** The event or observation being normalized. */
  readonly event: TEvent;
  /** How stale an observation may be before the sensor must report unknown. */
  readonly freshnessMs: number;
  readonly now: () => Date;
  /** Append-only sink. The sensor writes; it never dispatches. */
  readonly append: (observation: TObservation) => void;
}
