#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeCodex } from "../../plugins/provider-codex-subscription/lib/invoke.js";

const workspace = mkdtempSync(join(tmpdir(), "helium-codex-preflight-"));
try {
  const result = await invokeCodex({
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: 'Return exactly one JSON object and nothing else: {"status":"HELIUM_PROVIDER_AVAILABLE"}',
    cwd: workspace,
    timeoutMs: 120_000,
    sandbox: "read-only",
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.CODEX_HOME === undefined ? {} : { CODEX_HOME: process.env.CODEX_HOME }),
    },
    allowedTools: [],
  });
  if (!result.ok) {
    throw new Error(`Codex preflight failed: ${result.classification ?? "unknown"}`);
  }
  const parsed = JSON.parse(result.text ?? "");
  if (parsed.status !== "HELIUM_PROVIDER_AVAILABLE") {
    throw new Error("Codex preflight returned the wrong response");
  }
  process.stdout.write(`${JSON.stringify({
    status: parsed.status,
    requestedModel: result.runtimeSnapshot.requestedModel,
    requestedEffort: result.runtimeSnapshot.requestedEffort,
    effectiveEffort: result.runtimeSnapshot.effectiveEffort,
    usage: result.runtimeSnapshot.usage,
  })}\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
