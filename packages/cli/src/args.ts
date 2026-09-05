/**
 * The `helium run` flag parser, in its own module for one reason: `cli.ts` runs
 * `main()` at import time, so nothing in it can be imported by a test. The
 * parse is where `--as-of` turns into the run's clock, and a clock that is off
 * by a flag is exactly the defect a test has to be able to see.
 * @module @helium/cli/args
 */

/** What `helium run` was asked for. Core-neutral: a label, an instant, a name. */
export interface RunArgs {
  phase: string;
  /** Point-in-time replay instant. Absent means "now", the normal run. */
  asOf?: Date;
  /** Names the run's flavour so two replays of one instant stay apart. */
  variant: string;
}

export function parseRunArgs(rest: string[]): RunArgs | { error: string } {
  let phase = "premarket";
  let variant = "live";
  let asOf: Date | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    const needsValue = (): string | undefined =>
      value === undefined || value.startsWith("--")
        ? `${String(flag)} needs a value`
        : undefined;
    if (flag === "--phase") {
      const bad = needsValue();
      if (bad !== undefined)
        return { error: "--phase needs a value, e.g. --phase premarket" };
      phase = value!;
      i += 1;
      continue;
    }
    if (flag === "--as-of") {
      const bad = needsValue();
      if (bad !== undefined)
        return {
          error:
            "--as-of needs an ISO instant, e.g. --as-of 2026-09-02T12:45:00Z",
        };
      const at = new Date(value!);
      // A Date that failed to parse is `Invalid Date`, and it propagates
      // silently: every downstream `toISOString()` throws somewhere far from
      // the typo. Refusing here is the only place the message can still name
      // the argument the operator wrote.
      if (Number.isNaN(at.getTime()))
        return { error: `--as-of is not a parseable instant: ${value!}` };
      asOf = at;
      i += 1;
      continue;
    }
    if (flag === "--variant") {
      const bad = needsValue();
      if (bad !== undefined)
        return { error: "--variant needs a value, e.g. --variant smoke" };
      variant = value!;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${String(flag)}` };
  }
  return { phase, variant, ...(asOf === undefined ? {} : { asOf }) };
}
