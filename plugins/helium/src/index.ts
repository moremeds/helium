/**
 * helium — thin cordis adapter. Reads the pinned env contract into `Config`,
 * builds the two dsh-aware engine ports (triage via a dsh agent, senior via
 * the host `claude -p` binary) and the delivery port, then hands them to the
 * pure {@link HeliumRuntime} orchestrator on a single `ctx.effect` lifecycle.
 * @module dsh-plugin-helium
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Cron } from "croner";
import { buildTools, JsonlWriter, type RunOutcome } from "@helium/core";
import { buildChildEnv, runClaude, type ClaudeResult } from "./claude.js";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { Delivery, smtpFromEnv } from "./delivery.js";
import { TriageRunner, type SeniorLane } from "./dispatch.js";
import { readEnvFile } from "./envfile.js";
import { HeliumRuntime } from "./runtime.js";
import { registerEcosystemTools } from "./toolkit.js";

export const name = "helium";
export const inject = ["agentDefaultModel", "agents", "sessions", "tools"];
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
export function seniorOutcome(result: ClaudeResult): {
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
 * expects. `mcpConfigPath` is the file `apply()` writes once at startup
 * (spec §4) so the child reaches the ecosystem tools over MCP stdio.
 *
 * Each attempt runs in its OWN empty directory below
 * `<stateRoot>/workspaces/<job>/`, never `process.cwd()`: the senior child is
 * the least-trusted thing this daemon starts, and handing it the daemon's
 * working directory hands it the whole checkout. The directory is removed once
 * the child has reached quiescence (`runClaude()` resolves only after the
 * process group has closed).
 */
function buildSeniorLane(
  cfg: Config,
  mcpConfigPath: string,
  workspacesDir: string,
): SeniorLane {
  return {
    async dispatch(job, _ev, prompt) {
      const env = buildChildEnv(cfg, { PATH: process.env.PATH ?? "" });
      const workspace = join(workspacesDir, job.name, randomUUID());
      mkdirSync(workspace, { recursive: true });
      try {
        return seniorOutcome(
          await runClaude({
            prompt,
            cwd: workspace,
            maxTurns: job.maxTurns.senior,
            timeoutMs: job.timeoutMs,
            allowedTools: job.tools.map((t) => `mcp__helium__${t}`),
            mcpConfigPath,
            env,
          }),
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Writes the MCP stdio config the senior lane's `claude -p --mcp-config`
 * child reads (spec §4): one server, `helium`, pointed at `config.mcpBin`
 * with the ecosystem toolkit's env contract. Written once at startup to
 * `<stateRoot>/mcp.json` — a stable, writable path that survives a
 * symlink-swapped release deploy (task-2.7-report.md; task-3.3-brief.md).
 */
function writeMcpConfig(config: Config): string {
  const path = join(config.stateRoot, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          helium: {
            command: config.mcpBin,
            args: [],
            env: {
              HELIUM_TOOLS:
                "argon_api,apex_api,livewire_sql,thesis_read,thesis_write",
              HELIUM_ALLOW_MUTATIONS: "0",
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

  const mcpConfigPath = writeMcpConfig(cfg);
  const runtime = new HeliumRuntime({
    config: cfg,
    engines: {
      triage: new TriageRunner(ctx),
      senior: buildSeniorLane(cfg, mcpConfigPath, paths.workspaces),
    },
    delivery: {
      deliver: (job, ev, result) => delivery.deliver(job, ev, result),
      budgetExhausted: (job, ev, info) =>
        delivery.budgetExhausted(job, ev, info),
      heartbeat: (row) => delivery.heartbeat(row),
    },
  });
  ctx.effect(() => {
    runtime.start();
    return () => {
      runtime.stop();
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
