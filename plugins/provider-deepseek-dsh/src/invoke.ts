import type { DeepSeekEffort } from "./catalog.js";

export interface DeepSeekBoundaryInput {
  prompt: string;
  workspace: string;
  allowedTools: string[];
  signal: AbortSignal;
  agentOptions: {
    provider: "deepseek-official";
    model: string;
    reasoningEffort: DeepSeekEffort;
    maxTokens: number;
  };
}

export interface DeepSeekBoundaryResult {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
  providerMetadata: Record<string, unknown>;
}

export interface DeepSeekDshBoundary {
  run(input: DeepSeekBoundaryInput): Promise<DeepSeekBoundaryResult>;
}

export interface DeepSeekRuntimeSnapshot {
  requestedModel: string;
  requestedEffort: DeepSeekEffort;
  effectiveEffort: DeepSeekEffort;
  providerReportedEffort?: string;
  providerMetadata: Record<string, unknown>;
}

export async function invokeDeepSeek(input: {
  model: string;
  effort: DeepSeekEffort;
  prompt: string;
  workspace: string;
  allowedTools: string[];
  maxTokens: number;
  signal: AbortSignal;
  boundary: DeepSeekDshBoundary;
}): Promise<DeepSeekBoundaryResult & { runtimeSnapshot: DeepSeekRuntimeSnapshot }> {
  const result = await input.boundary.run({
    prompt: input.prompt,
    workspace: input.workspace,
    allowedTools: [...input.allowedTools],
    signal: input.signal,
    agentOptions: {
      provider: "deepseek-official",
      model: input.model,
      reasoningEffort: input.effort,
      maxTokens: input.maxTokens,
    },
  });
  const reported = result.providerMetadata.reasoningEffort;
  return {
    ...result,
    runtimeSnapshot: {
      requestedModel: input.model,
      requestedEffort: input.effort,
      effectiveEffort: input.effort,
      ...(typeof reported === "string" ? { providerReportedEffort: reported } : {}),
      providerMetadata: result.providerMetadata,
    },
  };
}
