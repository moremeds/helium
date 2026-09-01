/**
 * Child-process environment for the provider edge. Exact provider-native
 * invocation belongs to the independently installable provider plugin; this
 * module owns only the environment that child is given.
 * @module dsh-plugin-helium/claude
 */
import { readEnvFile } from "./envfile.js";

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
