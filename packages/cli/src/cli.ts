#!/usr/bin/env node
/**
 * `helium` — two subcommands and no framework.
 *
 *   helium run <tenant>   run one tenant's team once, print the result,
 *                         write audit rows, print the run id
 *   helium audit <run-id> the design §5 query over those rows
 *
 * Iteration speed is the point (doctrine 1/5): one command, no daemon, no
 * deploy, no approval. Anything it cannot do without credentials it SAYS,
 * rather than producing a number that looks like accounting.
 * @module @helium/cli/cli
 */
import { resolve } from "node:path";
import {
  AuditStore,
  CapabilityCatalog,
  loadTenants,
  auditDbPath,
  loadOperatorEnv,
} from "@helium/core";
import { discoverProviders, pluginsDir, tenantsDir } from "./discovery.js";
import { applyProxy } from "./proxy.js";
import { registerProviders, runTenant, type RunReport } from "./runner.js";

function stateRoot(env: NodeJS.ProcessEnv): string {
  return env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state");
}

function printRun(report: RunReport): void {
  console.log(`run ${report.runId}  tenant ${report.tenant}  mode ${report.mode}`);
  if (report.providersLive.length > 0) {
    console.log(`providers live: ${report.providersLive.join(", ")}`);
  }
  for (const skip of report.providersSkipped) {
    console.log(`provider skipped: ${skip.id} — ${skip.reason}`);
  }
  for (const skip of report.gatesSkipped) {
    console.log(`gate failed to load: ${skip.id} — ${skip.reason}`);
  }
  if (report.mode === "tool-only") {
    console.log(
      "no live provider: no model call was made, so no token counts exist for this run.",
    );
  }
  console.log("");
  for (const step of report.steps) {
    console.log(`── ${step.task} (${step.role}${step.targetId === undefined ? "" : `, ${step.targetId}`})`);
    if (step.downgradeReason !== undefined) {
      console.log(`   downgrade: ${step.downgradeReason}`);
    }
    for (const refusal of step.gateRefusals ?? []) {
      console.log(`   gate ${refusal.id} refused: ${refusal.reason}`);
    }
    if (step.text !== "") {
      for (const line of step.text.split("\n")) console.log(`   ${line}`);
    }
  }
  console.log("");
  console.log(
    report.outcome === "completed"
      ? `outcome: completed (${report.steps.length} steps)`
      : `outcome: FAILED ${report.failure?.class} — ${report.failure?.detail}`,
  );
  for (const sent of report.delivery) {
    console.log(
      `delivery ${sent.channel}: ${sent.state}${sent.detail === undefined ? "" : ` — ${sent.detail}`}`,
    );
  }
  console.log(`audit: helium audit ${report.runId}`);
}

function printAudit(store: AuditStore, runId: string): number {
  const rows = store.runCost(runId);
  if (rows.length === 0) {
    console.log(`no audit rows for run ${runId}`);
    return 1;
  }
  const header = ["role", "provider", "model", "tool", "spans", "tin", "tout", "cache", "usd", "sec"];
  const body = rows.map((row) => [
    row.role,
    row.provider,
    row.model,
    row.toolName ?? "-",
    String(row.spans),
    String(row.inputTokens),
    String(row.outputTokens),
    String(row.cacheReadTokens),
    row.usd.toFixed(6),
    row.seconds.toFixed(3),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]!.length)),
  );
  const render = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");
  console.log(render(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const line of body) console.log(render(line));
  const totals = rows.reduce(
    (acc, row) => ({
      usd: acc.usd + row.usd,
      tokens: acc.tokens + row.inputTokens + row.outputTokens,
    }),
    { usd: 0, tokens: 0 },
  );
  console.log("");
  console.log(`total ${totals.usd.toFixed(6)} USD over ${totals.tokens} tokens`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, argument] = argv;
  // Before anything reads a credential or a proxy. Ambient values still win,
  // so a one-off `HELIUM_PROXY=... helium run` overrides the file.
  loadOperatorEnv();
  const env = process.env;
  // Before the first fetch, so no provider probe goes out unproxied.
  applyProxy(env);

  if (command === "audit") {
    if (argument === undefined) {
      console.error("usage: helium audit <run-id>");
      return 2;
    }
    const store = AuditStore.open(env);
    try {
      return printAudit(store, argument);
    } finally {
      store.close();
    }
  }

  if (command === "run") {
    if (argument === undefined) {
      console.error("usage: helium run <tenant>");
      return 2;
    }
    const tenantsRoot = tenantsDir(env);
    const pluginsRoot = pluginsDir(env);
    const { tenants, skipped } = loadTenants(tenantsRoot);
    for (const skip of skipped) {
      console.error(`tenant skipped: ${skip.tenant} — ${skip.reason}`);
    }
    const tenant = tenants.find((entry) => entry.spec.tenant === argument);
    if (tenant === undefined) {
      console.error(
        `no tenant named ${argument} under ${tenantsRoot}; found: ${tenants.map((t) => t.spec.tenant).join(", ") || "(none)"}`,
      );
      return 1;
    }
    if (!tenant.spec.enabled) {
      console.error(`tenant ${argument} is disabled in its tenant.yaml`);
      return 1;
    }

    const providers = await discoverProviders(pluginsRoot);
    const catalog = new CapabilityCatalog();
    registerProviders(catalog, providers.live);

    const store = AuditStore.open(env);
    try {
      const report = await runTenant({
        tenant,
        audit: store,
        pluginsDir: pluginsRoot,
        stateRoot: stateRoot(env),
        env,
        providers: providers.live,
        providersSkipped: providers.skipped,
        catalog,
      });
      printRun(report);
      return report.outcome === "completed" ? 0 : 1;
    } finally {
      store.close();
    }
  }

  console.error(
    [
      "usage:",
      "  helium run <tenant>     run one tenant's team once",
      "  helium audit <run-id>   per-step cost and token rows for a run",
      "",
      `audit db: ${auditDbPath(env)} (override with HELIUM_AUDIT_DB)`,
      `tenants:  ${tenantsDir(env)} (override with HELIUM_TENANTS_DIR)`,
      `plugins:  ${pluginsDir(env)} (override with HELIUM_PLUGINS_DIR)`,
    ].join("\n"),
  );
  return command === undefined ? 2 : 2;
}

process.exitCode = await main(process.argv.slice(2));
