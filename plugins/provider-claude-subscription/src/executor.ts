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
import { claudeSubscriptionCatalog } from "./catalog.js";
import { invokeClaude, type ClaudeInvocationResult } from "./invoke.js";

type ClaudeInvoker = typeof invokeClaude;

class ClaudeExecutor implements Executor {
  readonly isolationClass = "process" as const;
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    readonly targetId: ExecutionTargetId,
    private readonly native: ProviderNativeVariant,
    private readonly invoke: ClaudeInvoker,
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
    const result: ClaudeInvocationResult = await this.invoke({
      model: this.native.model,
      ...(this.native.effort === undefined
        ? {}
        : { effort: this.native.effort as never }),
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      cwd: context.workspace,
      maxTurns: 16,
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
      allowedTools: context.allowedTools,
      mcpConfigPath: context.mcpConfigPath,
      env: context.env,
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
      usage: { ms: Date.now() - started },
      executionSnapshot: {
        targetId: this.targetId,
        providerId: "claude-subscription",
        model: this.native.model,
        effort: this.native.effort,
        providerVersion: claudeSubscriptionCatalog.catalogVersion,
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

export function registerCertifiedClaudeTargets(input: {
  certification: EntitlementCertification;
  capabilityCatalog: Parameters<typeof registerCertifiedTargets>[0]["capabilityCatalog"];
  executorRegistry: ExecutorRegistryPort;
  conformanceFor(targetId: ExecutionTargetId): ConformanceRecord;
  targetProfile: ProviderTargetProfile;
  invoke?: ClaudeInvoker;
}): RegisteredProviderTargets {
  return registerCertifiedTargets({
    pluginNamespace: "@helium/provider-claude-subscription@0.0.0",
    catalog: claudeSubscriptionCatalog,
    certification: input.certification,
    isolationClass: "process",
    targetProfile: input.targetProfile,
    capabilityCatalog: input.capabilityCatalog,
    executorRegistry: input.executorRegistry,
    conformanceFor: input.conformanceFor,
    createExecutor: (targetId, native) =>
      new ClaudeExecutor(targetId, native, input.invoke ?? invokeClaude),
  });
}
