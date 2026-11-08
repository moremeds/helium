/**
 * Point-in-time is enforced by the framework, not by a prompt.
 *
 * The run's as-of date is set once by the runner. A tool wrapped with
 * `withAsOf` receives it as an argument the model never supplies, and every
 * date-looking string the model DID pass is clamped to it — a model asking for
 * tomorrow's bars in a replay gets the as-of day's instead.
 */
const DATE = /^(\d{4}-\d{2}-\d{2})/;

// On globalThis, not a module variable: tool modules loaded for a child agent
// must see the runner's value even if the loader imports this file twice.
const KEY = Symbol.for("helium.asOf");
type G = typeof globalThis & { [KEY]?: string };

/** Runner-only. One run per process, so one as-of per process. */
export function setAsOf(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`as-of must be yyyy-mm-dd, got ${day}`);
  (globalThis as G)[KEY] = day;
}

export function currentAsOf(): string {
  const day = (globalThis as G)[KEY];
  if (day === undefined) throw new Error("no run in progress: as-of is unset");
  return day;
}

/** Every string whose leading yyyy-mm-dd is after `asOf` becomes `asOf`.
 *  Walks arrays and plain objects; leaves everything else alone. */
export function clampDates<T>(value: T, asOf: string): T {
  if (typeof value === "string") {
    const m = DATE.exec(value);
    return (m !== null && m[1]! > asOf ? asOf : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => clampDates(v, asOf)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clampDates(v, asOf)]),
    ) as T;
  }
  return value;
}

/** Wrap a tool's `execute`: clamp the model's arguments, inject the as-of. */
export function withAsOf<A, R, X>(
  execute: (args: A, asOf: string, exec: X) => Promise<R>,
): (args: A, exec: X) => Promise<R> {
  return (args, exec) => {
    const asOf = currentAsOf();
    return execute(clampDates(args, asOf), asOf, exec);
  };
}
