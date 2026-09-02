import { describe, expect, it } from "vitest";
import { loadOperatorEnv } from "@helium/core";
import {
  CLAUDE_OVERHEAD_TOKENS,
} from "@helium/provider-claude-subscription/provider";
import { invokeClaude } from "@helium/provider-claude-subscription/invoke";
import {
  CODEX_OVERHEAD_TOKENS,
} from "@helium/provider-codex-subscription/provider";
import { invokeCodex } from "@helium/provider-codex-subscription/invoke";

/**
 * Design §3.1 rule 3: `overheadTokens` is MEASURED by a live test, never
 * declared by hand. This is that test.
 *
 * Method: send the shortest prompt that exists. Whatever the vendor bills above
 * that one token is its own preamble — for Anthropic the mandatory Claude Code
 * identity block, for OpenAI the Responses instructions. A declared number that
 * has drifted from the wire is a routing decision made on stale data, which is
 * exactly what this catches.
 *
 * Opt-in: it spends real subscription quota, so normal CI never runs it.
 *   HELIUM_EVAL_LIVE=1 pnpm vitest run --project contracts provider-overhead
 */
const LIVE = process.env.HELIUM_EVAL_LIVE === "1";
const PROMPT = ".";
/** One prompt token, plus room for a vendor to adjust its preamble slightly. */
const TOLERANCE = 4;

describe.skipIf(!LIVE)("declared provider overhead matches the wire", () => {
  it("claude-subscription", async () => {
    loadOperatorEnv();
    const result = await invokeClaude({
      model: "claude-haiku-4-5-20251001",
      prompt: PROMPT,
      timeoutMs: 60_000,
      env: process.env as Record<string, string>,
    });
    expect(result.ok, JSON.stringify(result.classification)).toBe(true);
    const billed = (result.runtimeSnapshot.modelUsage as { input_tokens?: number })
      .input_tokens;
    expect(billed).toBeDefined();
    expect(Math.abs(billed! - CLAUDE_OVERHEAD_TOKENS)).toBeLessThanOrEqual(TOLERANCE);
  }, 90_000);

  it("codex-subscription", async () => {
    loadOperatorEnv();
    const result = await invokeCodex({
      model: "gpt-5.6-sol",
      effort: "low",
      prompt: PROMPT,
      timeoutMs: 60_000,
      env: process.env as Record<string, string>,
    });
    expect(result.ok, JSON.stringify(result.classification)).toBe(true);
    const billed = result.runtimeSnapshot.usage.inputTokens;
    expect(billed).toBeDefined();
    expect(Math.abs(billed! - CODEX_OVERHEAD_TOKENS)).toBeLessThanOrEqual(TOLERANCE);
  }, 90_000);
});
