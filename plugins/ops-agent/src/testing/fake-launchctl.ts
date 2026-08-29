/**
 * The only implementation of {@link LaunchctlRunner} used anywhere in the
 * tests.
 *
 * No test in this program may invoke the real service-manager binary or load,
 * unload or start a real job -- including the contract suites. Enumeration is
 * read-only, but the failure modes that matter here (non-zero exit, timeout,
 * truncated output, unparseable output) cannot be produced on demand from a
 * real host, and a probe whose refusal paths are never exercised is a probe
 * whose refusal paths do not work.
 * @module dsh-plugin-ops-agent/testing/fake-launchctl
 */
import type { LaunchctlResult, LaunchctlRunner } from "../probes/launchd-controller.js";

export interface FakeLaunchctlScript {
  exitCode?: number;
  stdout?: string;
  timedOut?: boolean;
  truncated?: boolean;
}

/**
 * @param script - either the loaded labels to report, or an explicit failure.
 */
export function fakeLaunchctl(
  script: string[] | FakeLaunchctlScript,
): LaunchctlRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const result: LaunchctlResult = Array.isArray(script)
    ? {
        exitCode: 0,
        // The real enumeration prints a PID/Status/Label table with a header.
        stdout: ["PID\tStatus\tLabel", ...script.map((l) => `-\t0\t${l}`)].join("\n"),
        timedOut: false,
        truncated: false,
      }
    : {
        exitCode: script.exitCode ?? 0,
        stdout: script.stdout ?? "",
        timedOut: script.timedOut ?? false,
        truncated: script.truncated ?? false,
      };

  return {
    calls,
    async list(argv: readonly string[]): Promise<LaunchctlResult> {
      calls.push([...argv]);
      return result;
    },
  };
}

/** A runner whose result changes between calls, for re-check-at-spawn tests. */
export function sequencedLaunchctl(
  scripts: (string[] | FakeLaunchctlScript)[],
): LaunchctlRunner & { calls: string[][] } {
  const runners = scripts.map((s) => fakeLaunchctl(s));
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    async list(argv: readonly string[]): Promise<LaunchctlResult> {
      calls.push([...argv]);
      const runner = runners[Math.min(index, runners.length - 1)];
      index += 1;
      return await runner.list(argv);
    },
  };
}
