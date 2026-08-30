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
  readonly dsh: {
    providerName: string;
    agentOptions: Record<string, unknown>;
    persona: string;
  };

  constructor(
    readonly targetId: ExecutionTargetId,
    private readonly native: ProviderNativeVariant,
    private readonly boundary: DeepSeekDshBoundary,
    subagentProviderName: string,
  ) {
    this.dsh = {
      providerName: subagentProviderName,
      agentOptions: {
        provider: "deepseek-official",
        model: native.model,
        reasoningEffort: native.effort,
        maxTokens: 8_192,
      },
      persona:
        "Complete only the assigned work order. Obey the tool allow-list and return the requested structured output without scheduling other work.",
    };
  }

  fromSubagentResult(
    work: WorkOrder,
    result: {
      output: Array<{ type: string; text?: string; [key: string]: unknown }>;
      structured?: unknown;
      diagnostic?: string;
      stopReason: string;
      effectiveReasoningEffort?: string;
      providerFailure?: {
        code: string;
        status?: number;
        retryAfterMs?: number;
      };
    },
    elapsedMs: number,
  ): AgentResult {
    if (
      result.stopReason === "completed" &&
      result.effectiveReasoningEffort === this.native.effort
    ) {
      const text = result.output
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      return {
        workId: work.id,
        outcome: "completed",
        structured: result.structured ?? text,
        artifacts: [],
        usage: { ms: elapsedMs },
        executionSnapshot: this.#snapshot(),
        runtimeMetadata: {
          stopReason: result.stopReason,
          provider: {
            requestedEffort: this.native.effort,
            effectiveEffort: result.effectiveReasoningEffort,
          },
        },
      };
    }
    if (result.stopReason === "completed") {
      return {
        workId: work.id,
        outcome: "failed",
        failure: {
          class: "provider-error",
          safeDetail: `DeepSeek effective effort mismatch: requested ${String(this.native.effort)}, observed ${String(result.effectiveReasoningEffort)}`,
        },
        artifacts: [],
        usage: { ms: elapsedMs },
        executionSnapshot: this.#snapshot(),
        runtimeMetadata: { stopReason: result.stopReason },
      };
    }
    const quota =
      result.providerFailure?.status === 429 ||
      result.providerFailure?.code === "RATE_LIMIT" ||
      result.providerFailure?.code === "QUOTA_EXCEEDED";
    const failureClass =
      quota
        ? "quota-exhausted"
        : result.stopReason === "aborted"
          ? "cancelled"
          : "provider-error";
    return {
      workId: work.id,
      outcome: "failed",
      failure: {
        class: failureClass,
        ...(result.diagnostic === undefined
          ? {}
          : { safeDetail: result.diagnostic }),
        ...(failureClass === "quota-exhausted" && result.providerFailure?.retryAfterMs !== undefined
          ? { retryAfter: `provider-ms:${result.providerFailure.retryAfterMs}` }
          : {}),
      },
      artifacts: [],
      usage: { ms: elapsedMs },
      executionSnapshot: this.#snapshot(),
      runtimeMetadata: { stopReason: result.stopReason },
    };
  }

  failureResult(
    work: WorkOrder,
    failureClass: "tool-boundary-violation" | "provider-error" | "cancelled",
    detail: string,
  ): AgentResult {
    return {
      workId: work.id,
      outcome: "failed",
      failure: { class: failureClass, safeDetail: detail },
      artifacts: [],
      usage: { ms: 0 },
      executionSnapshot: this.#snapshot(),
      runtimeMetadata: {},
    };
  }

  #snapshot(): AgentResult["executionSnapshot"] {
    return {
      targetId: this.targetId,
      providerId: "deepseek-dsh",
      model: this.native.model,
      effort: this.native.effort,
      providerVersion: deepseekDshCatalog.catalogVersion,
      isolationClass: this.isolationClass,
      recordedAt: new Date().toISOString(),
    };
  }

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
        executionSnapshot: this.#snapshot(),
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
        executionSnapshot: this.#snapshot(),
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
  subagentProviderName: string;
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
      new DeepSeekExecutor(
        targetId,
        native,
        input.boundary,
        input.subagentProviderName,
      ),
  });
}
