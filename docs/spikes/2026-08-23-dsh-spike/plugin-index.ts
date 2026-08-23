/**
 * health-sensor — poll an HTTP health endpoint on a timer, and on any change
 * to the watched subset dispatch a DeepSeek agent turn and record its answer.
 * @module dsh-plugin-health-sensor
 */
import { createHash, randomUUID } from "node:crypto";
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

export const name = "health-sensor";
export const inject = ["agentDefaultModel", "agents", "sessions"];

export interface Config {
  url: string;
  intervalMs: number;
  outFile: string;
  fields: string[];
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
  let previous: string | undefined;
  let previousHash: string | undefined;
  let agent: Agent | undefined;
  let busy = false;

  async function ensureAgent(): Promise<Agent> {
    if (agent) return agent;
    await ctx.get("loader")?.await();
    const selection = ctx.agentDefaultModel.currentSelection();
    const created = await ctx.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = {
          current: selection,
          assembled: undefined,
        };
        installModelSelection(agentCtx, selected);
      },
    });
    await created.agent.whenIdle();
    agent = created.agent;
    return agent;
  }

  async function tick(): Promise<void> {
    if (busy) return;
    const response = await fetch(config.url);
    const body = (await response.json()) as Record<string, unknown>;
    const watched = JSON.stringify(
      Object.fromEntries(config.fields.map((f) => [f, body[f]])),
    );
    const hash = createHash("sha256")
      .update(watched)
      .digest("hex")
      .slice(0, 12);
    if (hash === previousHash) return;
    const trigger = previousHash === undefined ? "first-observation" : "change";
    busy = true;
    const startedAt = Date.now();
    try {
      const target = await ensureAgent();
      const firstSeq = target.session.seq;
      target.followup(
        createUserMessage({
          content: [
            {
              type: "text",
              text:
                `Previous health JSON: ${previous ?? "(none — this is the first observation)"}\n` +
                `Current health JSON: ${watched}\n` +
                "Summarize what changed and whether it looks operationally concerning, in 5 lines. " +
                "Answer from the JSON alone; do not use any tools.",
            },
          ],
          source: { kind: "user" },
        }),
      );
      await target.whenIdle();
      await ctx.sessions.flush(target.session);
      appendFileSync(
        config.outFile,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          trigger,
          hash,
          latencyMs: Date.now() - startedAt,
          sessionId: String(target.id),
          finalText: finalText(target.session.events, firstSeq),
        })}\n`,
      );
      previous = watched;
      previousHash = hash;
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => {
    const run = (): void => {
      void tick().catch((error: unknown) => {
        console.error("health-sensor:", error);
      });
    };
    const timer = setInterval(run, config.intervalMs);
    run();
    return () => {
      clearInterval(timer);
    };
  }, "health-sensor.poll()");
}
