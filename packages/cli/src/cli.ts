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
  readLedger,
} from "@helium/core";
import { parseRunArgs } from "./args.js";
import { discoverProviders, pluginsDir, tenantsDir } from "./discovery.js";
import { applyProxy } from "./proxy.js";
import { registerProviders, runTenant, type RunReport } from "./runner.js";
import {
  parseScoreboardArgs,
  renderScoreboard,
  summarise,
} from "./scoreboard.js";

function stateRoot(env: NodeJS.ProcessEnv): string {
  return env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state");
}

function printRun(report: RunReport): void {
  console.log(
    `run ${report.runId}  tenant ${report.tenant}  mode ${report.mode}`,
  );
  if (report.asOf !== undefined) {
    console.log(`as-of: ${report.asOf}  variant: ${report.variant ?? "live"}`);
  }
  if (report.pitCoverage !== undefined) {
    const { available, total, unavailable, served } = report.pitCoverage;
    console.log(
      `pit coverage: ${String(available)}/${String(total)}` +
        (served === undefined || served.length === 0
          ? ""
          : ` (from recordings: ${served.join(", ")})`) +
        (unavailable.length === 0
          ? ""
          : ` (unavailable: ${unavailable.join(", ")})`),
    );
  }
  if (report.providersLive.length > 0) {
    console.log(`providers live: ${report.providersLive.join(", ")}`);
  }
  for (const skip of report.providersSkipped) {
    console.log(`provider skipped: ${skip.id} — ${skip.reason}`);
  }
  for (const skip of report.gatesSkipped) {
    console.log(`gate failed to load: ${skip.id} — ${skip.reason}`);
  }
  for (const gap of report.toolsUnconfigured) {
    console.log(`tool unconfigured: ${gap}`);
  }
  if (report.mode === "tool-only") {
    console.log(
      "no live provider: no model call was made, so no token counts exist for this run.",
    );
  }
  console.log("");
  for (const step of report.steps) {
    console.log(
      `── ${step.task} (${step.role}${step.targetId === undefined ? "" : `, ${step.targetId}`})`,
    );
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
    report.skipped !== undefined
      ? `outcome: skipped — ${report.skipped.reason}`
      : report.outcome === "completed"
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
  // First line, before the table: which build produced these rows. More than
  // one sha means a deploy landed mid-run.
  console.log(`code: ${store.codeVersions(runId).join(", ")}`);
  const header = [
    "role",
    "provider",
    "model",
    "tool",
    "spans",
    "tin",
    "tout",
    "cache",
    "usd",
    "sec",
  ];
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
  console.log(
    `total ${totals.usd.toFixed(6)} USD over ${totals.tokens} tokens`,
  );
  const measured = store.metrics(runId);
  if (measured.length > 0) {
    console.log("");
    for (const row of measured)
      console.log(
        `${row.name}: ${row.value === null ? "n/a" : String(row.value)}`,
      );
  }
  return 0;
}

/** `helium scoreboard <tenant> [--since] [--deployment] [--variant]`. */
export function printScoreboard(
  store: AuditStore,
  root: string,
  argv: string[],
): number {
  const parsed = parseScoreboardArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.tenant === undefined) {
    console.error(
      "usage: helium scoreboard <tenant> [--since <ISO>] [--deployment production|backtest|test|all] [--variant <label>]",
    );
    return 2;
  }
  const records = readLedger(
    root,
    parsed.tenant,
    parsed.since === undefined ? {} : { since: parsed.since },
  );
  const board = summarise(records, {
    deployment: parsed.deployment,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
  });
  // Cost is JOINED, never recomputed: the audit table is the one place that
  // knows what a run cost, and a second arithmetic here would eventually
  // disagree with `helium audit`.
  const runsByVariant = new Map<string, Set<string>>();
  for (const commitment of records.commitments) {
    const set = runsByVariant.get(commitment.variant) ?? new Set<string>();
    set.add(commitment.runId);
    runsByVariant.set(commitment.variant, set);
  }
  const costByVariant: Record<string, number> = {};
  for (const [variant, runIds] of runsByVariant) {
    let usd = 0;
    for (const runId of runIds)
      for (const row of store.runCost(runId)) usd += row.usd;
    costByVariant[variant] = usd;
  }
  for (const line of renderScoreboard(board, costByVariant)) console.log(line);
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

  if (command === "scoreboard") {
    const store = AuditStore.open(env);
    try {
      return printScoreboard(store, stateRoot(env), argv.slice(1));
    } finally {
      store.close();
    }
  }

  if (command === "run") {
    if (argument === undefined) {
      console.error(
        "usage: helium run <tenant> [--phase <phase>] [--as-of <ISO instant>] [--variant <label>] [--replay-from <runId>]",
      );
      return 2;
    }
    const parsed = parseRunArgs(argv.slice(2));
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    const { phase, asOf, variant, replayFrom } = parsed;
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
        phase,
        variant,
        // `--as-of` IS the run's clock, not a second timestamp beside it: the
        // step preamble, the report day and the file name all read `now()`, so
        // moving that one seam moves the whole run to the replayed instant.
        ...(asOf === undefined
          ? {}
          : { asOf, now: (): Date => new Date(asOf.getTime()) }),
        ...(replayFrom === undefined ? {} : { replayFrom }),
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
      "  helium run <tenant> [--phase <phase>] [--as-of <ISO instant>] [--variant <label>] [--replay-from <runId>]",
      "      run one tenant's team once. --as-of replays a past instant: it becomes",
      "      the run's clock, and every tool that has no history for it says so",
      "      instead of answering with today. --variant labels the run (default live).",
      "      --replay-from serves a live-only tool's recorded response from an",
      "      earlier run instead of refusing it. Recordings live under",
      "      <stateRoot>/runs/<runId>/tool-io and are pruned after 30 days.",
      "  helium audit <run-id>   per-step cost and token rows for a run",
      "  helium scoreboard <tenant> [--since <ISO>] [--deployment production|backtest|test|all] [--variant <label>]",
      "      what the outcome ledger says: mean and observed range per score key,",
      "      grouped by variant, pending counted separately. Production only unless told otherwise.",
      "",
      `audit db: ${auditDbPath(env)} (override with HELIUM_AUDIT_DB)`,
      `tenants:  ${tenantsDir(env)} (override with HELIUM_TENANTS_DIR)`,
      `plugins:  ${pluginsDir(env)} (override with HELIUM_PLUGINS_DIR)`,
    ].join("\n"),
  );
  return command === undefined ? 2 : 2;
}

process.exitCode = await main(process.argv.slice(2));
