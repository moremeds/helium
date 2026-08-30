#!/usr/bin/env node
const [{ invokeCodex }] = await Promise.all([
  import("../../plugins/provider-codex-subscription/lib/invoke.js"),
]);

await invokeCodex({
  model: "gpt-5.6-sol",
  effort: "high",
  prompt: "controller crash probe",
  cwd: process.env.HELIUM_PROVIDER_WORKSPACE,
  timeoutMs: 300_000,
  sandbox: "read-only",
  env: {
    PATH: process.env.HELIUM_PROVIDER_PATH,
    HELIUM_PROVIDER_READY: process.env.HELIUM_PROVIDER_READY,
  },
  allowedTools: [],
});
