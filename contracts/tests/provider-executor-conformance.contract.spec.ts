/**
 * The two process-backed provider executors run the same Phase 0 boundary
 * harness as every other process executor. Both CLIs are non-live fixtures on
 * the narrowed PATH; no provider account or quota is touched.
 */
import { ExecutionTargetId } from "@helium/core";
import { createClaudeExecutor } from "../../plugins/provider-claude-subscription/src/executor.js";
import { createCodexExecutor } from "../../plugins/provider-codex-subscription/src/executor.js";
import { asBoundarySubject } from "../../plugins/helium/src/executor-registry.js";
import { runExecutionBoundaryConformance } from "../harness/execution-boundary.js";

const codex = createCodexExecutor({
  targetId: ExecutionTargetId("contract-codex-sol-high"),
  native: {
    targetRef: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    effort: "high",
    quotaDomain: "codex-subscription-session",
    nativeKey: "gpt-5.6-sol|effort=high",
  },
});

const claude = createClaudeExecutor({
  targetId: ExecutionTargetId("contract-claude-sonnet-high"),
  native: {
    targetRef: "claude-sonnet-5",
    model: "claude-sonnet-5",
    effort: "high",
    quotaDomain: "claude-subscription-session",
    nativeKey: "claude-sonnet-5|effort=high",
  },
});

runExecutionBoundaryConformance(
  asBoundarySubject(codex, "provider-codex-subscription", "codex-cli"),
);
runExecutionBoundaryConformance(
  asBoundarySubject(claude, "provider-claude-subscription", "claude-cli"),
);
