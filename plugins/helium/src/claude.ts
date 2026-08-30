/**
 * Compatibility wrapper for the frozen v1 senior lane. Exact provider-native
 * invocation now belongs to the independently installable provider plugin.
 * @module dsh-plugin-helium/claude
 */
import {
  invokeClaude,
  type ClaudeClassification,
  type ClaudeInvocation,
  type ClaudeInvocationResult,
  type ClaudeRuntimeSnapshot,
} from "@helium/provider-claude-subscription/invoke";
import { readEnvFile } from "./envfile.js";

export type {
  ClaudeClassification,
  ClaudeInvocation,
  ClaudeRuntimeSnapshot,
};
export type ClaudeResult = ClaudeInvocationResult;

/**
 * Child-only environment. Subscription OAuth is injected only into the child;
 * an ambient API key is removed because it shadows subscription auth.
 */
export function buildChildEnv(
  cfg: { claudeTokenFile: string; envFile: string; proxy: string },
  base: Record<string, string>,
): Record<string, string> {
  const token = readEnvFile(cfg.claudeTokenFile).CLAUDE_CODE_OAUTH_TOKEN;
  const env: Record<string, string> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.HTTPS_PROXY = cfg.proxy;
  env.HTTP_PROXY = cfg.proxy;
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

/** Frozen v1 name retained while execution delegates to the provider edge. */
export async function runClaude(
  input: ClaudeInvocation,
): Promise<ClaudeResult> {
  return await invokeClaude(input);
}
