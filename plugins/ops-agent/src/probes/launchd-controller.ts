/**
 * The host controller-enumeration probe.
 *
 * It answers one question: is anything OTHER than us currently loaded as a
 * controller for this component? Every label string lives here, in the plugin.
 * Core knows there is such a thing as a competing controller; it does not know
 * what a service manager is.
 *
 * The probe is fail-closed in every direction. A non-zero exit, a timeout,
 * truncated output, or a line it cannot parse all yield `unknown`, which
 * refuses the mutation. A controller you cannot enumerate is not a controller
 * that is absent.
 * @module dsh-plugin-ops-agent/probes/launchd-controller
 */
import type { ComponentSpec } from "@helium/core/operations/component.js";
import type { ControllerProbeOutcome } from "@helium/core/operations/mutation-owner.js";
import type { Observation } from "@helium/core/operations/observation.js";

export interface LaunchctlResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
  /** The runner hit its output bound; what was NOT read cannot be ruled out. */
  truncated: boolean;
}

export interface LaunchctlRunner {
  /** Enumerate with EXACT argv. Nothing here builds a command string. */
  list(argv: readonly string[]): Promise<LaunchctlResult>;
}

/** Read-only enumeration, fixed argv, never constructed from anything. */
const LIST_ARGV = ["list"] as const;

export interface LaunchdControllerProbeOptions {
  launchctl: LaunchctlRunner;
  /** Our own label, which is never counted as competing. */
  ownLabel?: string;
  probeId?: string;
  parserVersion?: string;
}

export interface LaunchdControllerProbe {
  readonly probeId: string;
  check(component: ComponentSpec): Promise<ControllerProbeOutcome>;
  observe(component: ComponentSpec, now: Date, ttlMs?: number): Promise<Observation>;
}

/**
 * Parse the enumeration table.
 *
 * @returns the loaded labels, or `undefined` when any line cannot be read.
 * Partial parsing is refused deliberately: a label this function skipped is
 * exactly the competing controller it exists to find.
 */
export function parseLoadedLabels(stdout: string): string[] | undefined {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const body = /^PID\tStatus\tLabel$/.test(lines[0]) ? lines.slice(1) : lines;
  const labels: string[] = [];
  for (const line of body) {
    const fields = line.split("\t");
    if (fields.length !== 3) return undefined;
    const label = fields[2].trim();
    if (label === "") return undefined;
    labels.push(label);
  }
  return labels;
}

export function launchdControllerProbe(
  options: LaunchdControllerProbeOptions,
): LaunchdControllerProbe {
  const ownLabel = options.ownLabel ?? "com.helium.opsd";
  const probeId = options.probeId ?? "host.controller-enumeration.v1";
  const parserVersion = options.parserVersion ?? "controller-enumeration/1";

  const check = async (
    component: ComponentSpec,
  ): Promise<ControllerProbeOutcome> => {
    const result = await options.launchctl.list(LIST_ARGV);

    if (result.timedOut) {
      return { result: "unknown", observedLabels: [], detail: "enumeration-timeout" };
    }
    if (result.exitCode !== 0) {
      return {
        result: "unknown",
        observedLabels: [],
        detail: `enumeration-exit-${result.exitCode}`,
      };
    }
    if (result.truncated) {
      return { result: "unknown", observedLabels: [], detail: "enumeration-truncated" };
    }

    const labels = parseLoadedLabels(result.stdout);
    if (labels === undefined) {
      return { result: "unknown", observedLabels: [], detail: "enumeration-unparseable" };
    }

    const declared = new Set(component.mutationOwner.competingLabels);
    const competing = labels.filter((l) => l !== ownLabel && declared.has(l));
    return {
      result: competing.length > 0 ? "competing" : "clear",
      observedLabels: labels,
    };
  };

  return {
    probeId,
    check,
    async observe(component, now, ttlMs = 300_000): Promise<Observation> {
      const outcome = await check(component);
      return {
        version: 1,
        id: `obs-${component.id}-controller-${now.getTime()}`,
        componentId: component.id,
        probeId,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        // `competing` is a real fault; `unknown` is absence of proof. Neither
        // is `ok`, and they are deliberately not the same state.
        state:
          outcome.result === "clear"
            ? "ok"
            : outcome.result === "competing"
              ? "failed"
              : "unknown",
        dimension: "controller",
        value: {
          controllerResult: outcome.result,
          observedLabels: outcome.observedLabels,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        },
        evidenceRefs: [`artifact://probe/${probeId}/${component.id}`],
        parserVersion,
      };
    },
  };
}
