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
    // This is the v1 `Executor` seam, which nothing in v2 routes through: the
    // runner discovers `provider.ts`, and the tool loop lives there. It is
    // reached only by its own test. Refusing here rather than growing a second
    // loop keeps one implementation of the tool protocol, not two that drift.
    if (context.allowedTools.length > 0) {
      return this.#failed(
        work,
        started,
        `codex-subscription: the legacy executor seam has no tool loop (provider.ts does); ${String(context.allowedTools.length)} tool(s) requested`,
      );
    }
    const result: CodexInvocationResult = await this.invoke({
      model: this.native.model,
      effort: this.native.effort as never,
      prompt: work.inputs.prompt ?? JSON.stringify(work.inputs.artifacts),
      timeoutMs: work.constraints.maxLatencyMs ?? 300_000,
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

  #failed(work: WorkOrder, started: number, reason: string): AgentResult {
    return {
      workId: work.id,
      outcome: "failed",
      failure: { class: "provider-error" },
      artifacts: [],
      usage: { ms: Date.now() - started },
      executionSnapshot: {
        targetId: this.targetId,
        providerId: "codex-subscription",
        model: this.native.model,
        effort: this.native.effort,
        providerVersion: codexSubscriptionCatalog.catalogVersion,
        isolationClass: this.isolationClass,
        recordedAt: new Date().toISOString(),
      },
      runtimeMetadata: {
        provider: { requestedModel: this.native.model, usage: {}, events: [], reason },
      },
    } as AgentResult;
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
    targetProfile: input.targetProfile,
    capabilityCatalog: input.capabilityCatalog,
    executorRegistry: input.executorRegistry,
    conformanceFor: input.conformanceFor,
    createExecutor: (targetId, native) =>
      createCodexExecutor({ targetId, native, invoke: input.invoke }),
  });
}
