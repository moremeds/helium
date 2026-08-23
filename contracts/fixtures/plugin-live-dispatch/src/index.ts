/**
 * Live contract fixture: one real agent turn through the exact seam helium
 * depends on — ctx.agents.create → followup → whenIdle → session-event
 * watermark capture. Copied from the 2026-08-23 dsh spike plugin.
 * @module dsh-plugin-helium-live-dispatch
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";

export const name = "helium-live-dispatch";
export const inject = ["agentDefaultModel", "agents", "sessions"];

export interface Config {
  outFile: string;
}

/** Last non-empty assistant text in the durable interval we own. */
function finalText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== "assistant/message") continue;
    const joined = event.data.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (joined !== "") text = joined;
  }
  return text;
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      await ctx.get("loader")?.await();
      const selection = ctx.agentDefaultModel.currentSelection();
      const created = await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: (agentCtx) => {
          const selected: ModelSelectionRef = {
            current: selection,
            assembled: undefined,
          };
          installModelSelection(agentCtx, selected);
        },
      });
      const agent: Agent = created.agent;
      await agent.whenIdle();
      if (cancelled) return;
      const firstSeq = agent.session.seq;
      const startedAt = Date.now();
      agent.followup(
        createUserMessage({
          content: [
            {
              type: "text",
              text: "Reply with exactly the word HELIUM_CONTRACT_OK and nothing else. Do not use any tools.",
            },
          ],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      appendFileSync(
        config.outFile,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          sessionId: String(agent.id),
          finalText: finalText(agent.session.events, firstSeq),
        })}\n`,
      );
    })().catch((error: unknown) => {
      console.error("helium-live-dispatch:", error);
    });
    return () => {
      cancelled = true;
    };
  }, "helium-live-dispatch.run()");
}
