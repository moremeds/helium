import {
  type AgentResult,
  type ConformanceRecord,
  type ExecutionContext,
  type ExecutionTargetId,
  type Executor,
  type WorkOrder,
} from "@helium/core";
import {
  registerCertifiedTargets,
  type EntitlementCertification,
  type ExecutorRegistryPort,
  type ProviderNativeVariant,
  type ProviderTargetProfile,
  type RegisteredProviderTargets,
} from "@helium/provider-sdk/registration";
import { deepseekDshCatalog, type DeepSeekEffort } from "./catalog.js";
import { invokeDeepSeek, type DeepSeekDshBoundary } from "./invoke.js";

class DeepSeekExecutor implements Executor {
  readonly isolationClass = "in-process" as const;
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    readonly targetId: ExecutionTargetId,
    private readonly native: ProviderNativeVariant,
    private readonly boundary: DeepSeekDshBoundary,
  ) {}

  async run(
    work: WorkOrder,
    signal: AbortSignal,
    context: ExecutionContext,
  ): Promise<AgentResult> {
    const pending = this.#run(work, signal, context);
    this.#active.add(pending);
    try {
      return await pending;
    } finally {
      this.#active.delete(pending);
    }
  }

  async #run(
    work: WorkOrder,
    signal: AbortSignal,
    context: ExecutionContext,
  ): Promise<AgentResult> {
    const started = Date.now();
    try {
      const result = await invokeDeepSeek({
        model: this.native.model,
        effort: this.native.effort as DeepSeekEffort,
        prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
        workspace: context.workspace,
        allowedTools: context.allowedTools,
        maxTokens: 8_192,
        signal,
        boundary: this.boundary,
      });
      return {
        workId: work.id,
        outcome: "completed",
        structured: result.text,
        artifacts: [],
        usage: { ...result.usage, ms: Date.now() - started },
        executionSnapshot: {
          targetId: this.targetId,
          providerId: "deepseek-dsh",
          model: this.native.model,
          effort: this.native.effort,
          providerVersion: deepseekDshCatalog.catalogVersion,
          isolationClass: this.isolationClass,
          recordedAt: new Date().toISOString(),
        },
        runtimeMetadata: { provider: result.runtimeSnapshot },
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        workId: work.id,
        outcome: "failed",
        failure: {
          class:
            code === "QUOTA" || code === "RATE_LIMIT"
              ? "quota-exhausted"
              : signal.aborted
                ? "cancelled"
                : "provider-error",
          safeDetail: error instanceof Error ? error.message : String(error),
        },
        artifacts: [],
        usage: { ms: Date.now() - started },
        executionSnapshot: {
          targetId: this.targetId,
          providerId: "deepseek-dsh",
          model: this.native.model,
          effort: this.native.effort,
          providerVersion: deepseekDshCatalog.catalogVersion,
          isolationClass: this.isolationClass,
          recordedAt: new Date().toISOString(),
        },
        runtimeMetadata: {},
      };
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#active]);
  }
}

export function registerCertifiedDeepSeekTargets(input: {
  certification: EntitlementCertification;
  capabilityCatalog: Parameters<typeof registerCertifiedTargets>[0]["capabilityCatalog"];
  executorRegistry: ExecutorRegistryPort;
  conformanceFor(targetId: ExecutionTargetId): ConformanceRecord;
  targetProfile: ProviderTargetProfile;
  boundary: DeepSeekDshBoundary;
}): RegisteredProviderTargets {
  return registerCertifiedTargets({
    pluginNamespace: "@helium/provider-deepseek-dsh@0.0.0",
    catalog: deepseekDshCatalog,
    certification: input.certification,
    isolationClass: "in-process",
    targetProfile: input.targetProfile,
    capabilityCatalog: input.capabilityCatalog,
    executorRegistry: input.executorRegistry,
    conformanceFor: input.conformanceFor,
    createExecutor: (targetId, native) =>
      new DeepSeekExecutor(targetId, native, input.boundary),
  });
}
