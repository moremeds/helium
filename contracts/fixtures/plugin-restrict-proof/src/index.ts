/**
 * Runtime proof (task-2.3-report.md's flagged coverage gap, closed by
 * task-2.7's carry-in 1): registers two global tools, then exercises the
 * exact same restrict-by-deny sequence TriageRunner.dispatch() uses
 * (plugins/helium/src/dispatch.ts) inside a real dsh agent's `setup()` --
 * `ctx.tools.schemas()` (global view) minus the job's allow-list computes
 * `deny`, `agentCtx.tools.restrict({ deny })` applies it, and
 * `agentCtx.tools.schemas(scopeOf(agentCtx))` (the agent's OWN scoped view)
 * proves the denial actually took effect, before writing the before/after
 * tool-name lists to `outFile` and disposing the agent -- no `turn()` or
 * `followup()` is ever called, so this never invokes a model and needs no
 * API key.
 *
 * dsh-scope API cited against the installed @deepseek-ai/dsh-scope
 * 0.1.1-rc.2 package: `scopeOf(ctx: Context): ScopeKey | undefined`
 * (lib/types/index.d.ts) reads the nearest scope tag a context carries --
 * `ToolRuntime.restrict()`/`.schemas()` use the identical `scopeOf(this.ctx)`
 * internally (dsh-tools/lib/index.js:2780, confirmed by reading the
 * installed package directly).
 * @module dsh-plugin-helium-restrict-proof
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  installModelSelection,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-tools";
import { scopeOf } from "@deepseek-ai/dsh-scope";

export const name = "helium-restrict-proof";
export const inject = ["agentDefaultModel", "agents", "sessions", "tools"];

export interface Config {
  outFile: string;
}

/** Registers a no-op stub tool under one of the two probe names. */
function stubTool(toolName: string) {
  return defineTool({
    name: toolName,
    description: `restrict-proof stub tool: ${toolName}`,
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async () => "ok",
  });
}

/** Mirrors TriageRunner's job.tools allow-list -- keep this one, deny the other. */
const KEPT_TOOL = "probe_kept";
const DENIED_TOOL = "probe_denied";

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(stubTool(KEPT_TOOL));
  ctx.tools.register(stubTool(DENIED_TOOL));

  ctx.effect(() => {
    void (async (): Promise<void> => {
      await ctx.get("loader")?.await();
      const globalBefore = ctx.tools
        .schemas()
        .map((s) => s.name)
        .sort();
      const selection = ctx.agentDefaultModel.currentSelection();
      const handle = await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          const selectedRef: ModelSelectionRef = {
            current: selection,
            assembled: undefined,
          };
          installModelSelection(agentCtx, selectedRef);

          // Identical to TriageRunner.dispatch()'s deny computation
          // (plugins/helium/src/dispatch.ts): keep exactly the job's
          // allow-listed tools, deny every other registered global.
          const keep = new Set([KEPT_TOOL]);
          const deny = ctx.tools
            .schemas()
            .map((s) => s.name)
            .filter((n) => !keep.has(n));
          if (deny.length > 0) agentCtx.tools.restrict({ deny });

          const scope = scopeOf(agentCtx);
          const visibleAfterRestrict = agentCtx.tools
            .schemas(scope)
            .map((s) => s.name)
            .sort();
          writeFileSync(
            config.outFile,
            JSON.stringify({ globalBefore, visibleAfterRestrict }),
          );
        },
      });
      await handle.dispose();
    })().catch((error: unknown) => {
      writeFileSync(
        `${config.outFile}.error`,
        String((error as Error)?.stack ?? error),
      );
    });
    return () => {};
  }, "helium-restrict-proof.run()");
}
