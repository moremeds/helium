/**
 * helium — thin cordis adapter. Reads the pinned env contract into `Config`,
 * builds the two dsh-aware engine ports (triage via a dsh agent, senior via
 * the host `claude -p` binary) and the delivery port, then hands them to the
 * pure {@link HeliumRuntime} orchestrator on a single `ctx.effect` lifecycle.
 * @module dsh-plugin-helium
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Cron } from "croner";
import { JsonlWriter, type RunOutcome } from "@helium/core";
import { buildTools, type JobSpec } from "@helium/v1-compat";
import type { ClaudeResult } from "./claude.js";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { TriageRunner, type SeniorLane } from "./dispatch.js";
import { readEnvFile } from "./envfile.js";
import { HeliumRuntime } from "./runtime.js";
import { ProviderRuntime } from "./provider-runtime.js";
import { registerEcosystemTools } from "./toolkit.js";

export const name = "helium";
export const inject = [
  "agentDefaultModel",
  "agents",
  "sessions",
  "sessionPersistence",
  "subagents",
  "tools",
];
export { type Config } from "./config.js";

/**
 * Runs a synchronous step and swallows (logs) any throw instead of letting it
 * escape. Used to guard cron callbacks: croner@10.0.1 has no `catch` option
 * for a sync `Cron(...)` callback, so an unguarded throw (e.g. a transient FS
 * failure from `jsonl.prune()`) becomes an unhandled rejection that kills the
 * whole daemon.
 */
export function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e: unknown) {
    console.error(`${label}:`, e);
  }
}

/**
 * Translates one `runClaude()` result into the `SeniorLane` outcome shape
 * {@link HeliumRuntime}'s `Dispatcher` expects. `quota-exhausted` is reported
 * under its own label with the provider's opaque reset hint attached — never
 * as a plain `error` — because it is dynamic provider-availability state, not
 * a capability change and not a budget: the target is simply unavailable until
 * `retryAfter`.
 */
export function seniorOutcome(
  result: Pick<ClaudeResult, "ok" | "text" | "classification" | "retryAfter">,
): {
  outcome: RunOutcome;
  analysis?: string;
  error?: string;
} {
  if (result.ok) return { outcome: "run_completed", analysis: result.text };
  if (result.classification === "timeout") {
    return {
      outcome: "timed_out",
      error: "senior lane exceeded its wall clock",
    };
  }
  if (result.classification === "quota-exhausted") {
    const until = result.retryAfter ? ` (retry after ${result.retryAfter})` : "";
    return {
      outcome: "run_failed",
      error: `quota-exhausted${until}${result.text ? `: ${result.text}` : ""}`,
    };
  }
  return {
    outcome: "run_failed",
    error: `${result.classification ?? "error"}${result.text ? `: ${result.text}` : ""}`,
  };
}

/**
 * Senior lane: spawns the host `claude -p` binary and translates its result
 * into the `SeniorLane` outcome shape {@link HeliumRuntime}'s `Dispatcher`
 * expects. The MCP stdio config the child reads (spec §4) is written per
 * attempt, into that attempt's workspace, from the job's own declared tool
 * contract — see {@link writeMcpConfig}.
 *
 * Each attempt runs in its OWN empty directory below
 * `<stateRoot>/workspaces/<job>/`, never `process.cwd()`: the senior child is
 * the least-trusted thing this daemon starts, and handing it the daemon's
 * working directory hands it the whole checkout. The directory is removed once
 * the child has reached quiescence (`runClaude()` resolves only after the
 * process group has closed).
 */
/**
 * Writes the MCP stdio config for ONE senior attempt, into that attempt's own
 * workspace, derived from the job's declared contract.
 *
 * Previously this was written once at startup to `<stateRoot>/mcp.json` with a
 * hardcoded five-name `HELIUM_TOOLS` string. That made the tool contract a
 * constant rather than a property of the tenant: a job could declare any tool
 * list it liked and the child still received the same fixed set, so a
 * misspelled capability in a job's YAML could never produce a bad
 * `HELIUM_TOOLS` and never trip the job-load validator. Deriving it from
 * `job.tools` — the same list already used to build the `mcp__helium__*`
 * allow-list — is what makes that validator reachable.
 *
 * `HELIUM_ALLOW_MUTATIONS` likewise follows the job rather than a literal `0`.
 * Job load currently refuses `allowMutations: true` outright, so it is always
 * `"0"` today; writing it truthfully means the flag is never a no-op that
 * merely looks like a granted permission.
 *
 * Per-attempt rather than per-daemon because the file now varies by job, and
 * the attempt workspace is already created and removed around the child.
 */
export function writeMcpConfig(config: Config, job: JobSpec, dir: string): string {
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          helium: {
            command: config.mcpBin,
            args: [],
            env: {
              HELIUM_TOOLS: job.tools.join(","),
              HELIUM_ALLOW_MUTATIONS: job.allowMutations ? "1" : "0",
              HELIUM_ARGON_BASE: config.argonBase,
              HELIUM_APEX_BASE: config.apexBase,
              ...(config.livewireDb
                ? { HELIUM_LIVEWIRE_DB: config.livewireDb }
                : {}),
              HELIUM_STATE_ROOT: config.stateRoot,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

export function apply(ctx: Context, raw: Config): void {
  const cfg = ConfigSchema.parse(raw);
  const paths = statePaths(cfg);
  const jsonl = new JsonlWriter(paths.jsonl);
  const delivery = new Delivery({
    jsonl,
    jsonlDir: paths.jsonl,
    reportsDir: paths.reports,
    emailTo: cfg.emailTo,
    smtp: smtpFromEnv(readEnvFile(cfg.envFile)),
  });

  // Global in-process registration for dsh agents / the interactive Web UI:
  // read-only by design (spec §6), regardless of any job's allowMutations. A
  // job that enables mutations gets those tools only through the senior
  // lane's MCP server (HELIUM_ALLOW_MUTATIONS=1), keeping the audit boundary
  // on the child process instead of on every interactive session.
  const tools = buildTools({
    argonBase: cfg.argonBase,
    apexBase: cfg.apexBase,
    livewireDb: cfg.livewireDb,
    stateRoot: cfg.stateRoot,
  });
  registerEcosystemTools(
    ctx,
    tools.filter((t) => !t.mutating),
  );

  const providers = new ProviderRuntime(ctx, {
    stateRoot: paths.state,
    workspacesDir: paths.workspaces,
    claudeTokenFile: cfg.claudeTokenFile,
    envFile: cfg.envFile,
    proxy: cfg.proxy,
  });

  const runtime = new HeliumRuntime({
    config: cfg,
    engines: {
      triage: new TriageRunner(ctx),
      senior: providers.seniorLane((job, dir) => writeMcpConfig(cfg, job, dir)),
    },
    delivery: {
      deliver: (job, ev, result) => delivery.deliver(job, ev, result),
      budgetExhausted: (job, ev, info) =>
        delivery.budgetExhausted(job, ev, info),
      heartbeat: (row) => delivery.heartbeat(row),
      reconcileDeliveries: () => delivery.reconcileDeliveries(),
    },
  });
  ctx.effect(async () => {
    await ctx.get("loader")?.await();
    await providers.start();
    runtime.start();
    return async () => {
      runtime.stop();
      await providers.dispose();
    };
  }, "helium.runtime()");

  // Daily synthesis (spec §8/§11): the floor, not the product. Also prunes
  // the JSONL trail to the 90-day retention window (controller-pinned
  // addition — kept alongside the synthesis send itself, not a separate cron).
  const synthesis = new Cron(
    "5 17 * * *",
    { timezone: "America/New_York", protect: true },
    () => {
      // Guarded independently of the dailySynthesis catch below (see
      // runGuarded's doc comment for why this needs its own guard).
      runGuarded("helium.prune", () => {
        jsonl.prune(90);
      });
      void delivery.dailySynthesis().catch((e: unknown) => {
        console.error("helium.synthesis:", e);
      });
    },
  );
  ctx.effect(
    () => () => {
      synthesis.stop();
    },
    "helium.delivery.synthesis()",
  );
}
