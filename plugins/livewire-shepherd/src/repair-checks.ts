/** Fresh, manifest-scoped read-only postcondition sampling for repaired Livewire data. */
import type { CheckDefinition } from "@helium/core/operations/check.js";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import {
  type CommandRunner,
  type ScriptRegistry,
} from "dsh-plugin-ops-agent";

const PROBE_ID = "livewire.repair-postcondition.v1";

export interface LivewireRepairCheckSamplerOptions {
  registry: ScriptRegistry;
  executorId: string;
}

export class LivewireRepairCheckSampler {
  constructor(private readonly options: LivewireRepairCheckSamplerOptions) {}

  async sample(
    checks: readonly CheckDefinition[],
    _phase: "baseline" | "postcondition",
    runner: CommandRunner,
    now: Date,
  ): Promise<PostconditionSample[] | undefined> {
    const scoped = checks.filter((check) => check.probe.probeId === PROBE_ID);
    if (scoped.length === 0) return undefined;
    if (scoped.length !== checks.length) {
      throw new Error("Livewire repair checks cannot mix scoped and unscoped postconditions");
    }
    const script = this.options.registry.get(this.options.executorId);
    if (script === undefined) throw new Error("Livewire repair postcondition executor is not registered");
    const identity = this.options.registry.verifyIdentity(script);
    if (!identity.ok) throw new Error(`Livewire repair postcondition executor identity failed: ${identity.reason}`);

    const samples: PostconditionSample[] = [];
    for (const check of scoped) {
      const manifest = exactManifestArg(check);
      const argv = ["--manifest", manifest];
      this.options.registry.validateArgv(script, argv);
      const result = await runner.run(
        [script.path, ...argv],
        Math.min(script.timeoutMs, check.timeoutMs),
      );
      if (result.evidenceRef.length === 0) {
        throw new Error("Livewire repair postcondition command returned no raw evidence reference");
      }
      samples.push({
        checkId: check.id,
        state: classify(result.stdout, result.exitCode, result.timedOut),
        observedAt: now.toISOString(),
        evidenceRefs: [result.evidenceRef],
      });
    }
    return samples;
  }
}

function exactManifestArg(check: CheckDefinition): string {
  const args = check.probe.args;
  const keys = Object.keys(args);
  const manifest = args.manifest;
  const expected = check.kind === "business" &&
    keys.length === 1 && keys[0] === "manifest" && typeof manifest === "string" &&
    check.expect.dimension === "repair" && check.expect.operator === "eq" &&
    check.expect.value === true && check.onUnavailable === "unknown";
  if (!expected) throw new Error("Livewire repair postcondition definition is not the exact compiled contract");
  return manifest;
}

function classify(
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): PostconditionSample["state"] {
  if (timedOut) return "unknown";
  const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (line === undefined) return "unknown";
  let state: unknown;
  try {
    const parsed = JSON.parse(line) as unknown;
    state = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).state
      : undefined;
  } catch {
    return "unknown";
  }
  if (exitCode === 0 && state === "VERIFIED") return "pass";
  if (state === "NOT_VERIFIED" || state === "FAILED" || exitCode !== 0) return "fail";
  return "unknown";
}
