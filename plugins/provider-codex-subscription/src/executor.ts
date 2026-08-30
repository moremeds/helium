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
import { codexSubscriptionCatalog } from "./catalog.js";
import {
  invokeCodex,
  type CodexInvocationResult,
} from "./invoke.js";

type CodexInvoker = typeof invokeCodex;

class CodexExecutor implements Executor {
  readonly isolationClass = "process" as const;
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    readonly targetId: ExecutionTargetId,
    private readonly native: ProviderNativeVariant,
    private readonly invoke: CodexInvoker,
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
    const result: CodexInvocationResult = await this.invoke({
      model: this.native.model,
      effort: this.native.effort as never,
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      cwd: context.workspace,
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
      sandbox:
        work.constraints.mutations === "permitted"
          ? "workspace-write"
          : "read-only",
      env: context.env,
      allowedTools: context.allowedTools,
      mcpConfigPath: context.mcpConfigPath,
      signal,
    });
    const failureClass =
      result.classification === "quota-exhausted"
        ? "quota-exhausted"
        : result.classification === "timeout"
          ? "timeout"
          : result.classification === "cancelled"
            ? "cancelled"
            : "provider-error";
    return {
      workId: work.id,
      outcome: result.ok ? "completed" : "failed",
      ...(result.ok
        ? { structured: result.text }
        : {
            failure: {
              class: failureClass,
              ...(result.retryAfter === undefined
                ? {}
                : { retryAfter: result.retryAfter }),
            },
          }),
      artifacts: [],
      usage: {
        ...result.runtimeSnapshot.usage,
        ms: Date.now() - started,
      },
      executionSnapshot: {
        targetId: this.targetId,
        providerId: "codex-subscription",
        model: this.native.model,
        effort: this.native.effort,
        providerVersion: codexSubscriptionCatalog.catalogVersion,
        isolationClass: this.isolationClass,
        recordedAt: new Date().toISOString(),
      },
      runtimeMetadata: { provider: result.runtimeSnapshot },
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#active]);
  }
}

export function createCodexExecutor(input: {
  targetId: ExecutionTargetId;
  native: ProviderNativeVariant;
  invoke?: CodexInvoker;
}): Executor {
  return new CodexExecutor(
    input.targetId,
    input.native,
    input.invoke ?? invokeCodex,
  );
}

export function registerCertifiedCodexTargets(input: {
  certification: EntitlementCertification;
  capabilityCatalog: Parameters<typeof registerCertifiedTargets>[0]["capabilityCatalog"];
  executorRegistry: ExecutorRegistryPort;
  conformanceFor(targetId: ExecutionTargetId): ConformanceRecord;
  targetProfile: ProviderTargetProfile;
  invoke?: CodexInvoker;
}): RegisteredProviderTargets {
  return registerCertifiedTargets({
    pluginNamespace: "@helium/provider-codex-subscription@0.0.0",
    catalog: codexSubscriptionCatalog,
    certification: input.certification,
    isolationClass: "process",
    targetProfile: input.targetProfile,
    capabilityCatalog: input.capabilityCatalog,
    executorRegistry: input.executorRegistry,
    conformanceFor: input.conformanceFor,
    createExecutor: (targetId, native) =>
      createCodexExecutor({ targetId, native, invoke: input.invoke }),
  });
}
