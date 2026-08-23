/**
 * Dispatch — triage lane (spec §4, §6, §8): one dsh agent turn that classifies
 * a trigger event into a {@link TriageVerdict}. `session: 'fresh'` in the job
 * contract means a NEW agent per dispatch, disposed afterwards — unlike the
 * spike's single cached agent (see the dsh-source citations in
 * `.superpowers/sdd/2026-08-23-helium-v1/task-2.3-report.md`).
 * @module dsh-plugin-helium/dispatch
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
  installModelSelection,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
// Side-effect import: augments cordis `Context` with `.agentDefaultModel`
// (dsh-agent-default-model/lib/types/index.d.ts:9-12).
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
// Side-effect imports: these packages augment cordis `Context` with `.tools` and
// `.systemPrompt` respectively (dsh-tools/lib/types/index.d.ts:24-27; dsh-system-prompt/lib/types/index.d.ts:12).
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import {
  parseVerdict,
  type JobSpec,
  type RunOutcome,
  type TriageVerdict,
} from "@helium/core";
import type { TriggerEvent } from "./sensor.js";

export const VERDICT_INSTRUCTION =
  "End your reply with exactly one JSON object " +
  '{"escalate": bool, "severity": "noise|minor|material|critical", "reason": string}';

const CORRECTION =
  "Your previous reply did not end with a parsable verdict. Reply with nothing but the " +
  "JSON object. " +
  VERDICT_INSTRUCTION;

const TRIAGE_PERSONA =
  "You are helium's triage analyst. You classify one ecosystem state change. You do not " +
  "edit files, run commands, or write anywhere. Be terse: at most five lines of reasoning, " +
  "then the verdict JSON.";

/** Three-layer context injection (spec §6): ecosystem context → job prompt → trigger payload. */
export function assembleTriagePrompt(
  contextText: string,
  job: JobSpec,
  ev: TriggerEvent,
): string {
  return [
    "## Ecosystem context",
    contextText.trim(),
    "",
    "## Job",
    job.prompt.trim(),
    "",
    "## Trigger",
    "```json",
    JSON.stringify(
      { job: ev.job, kind: ev.kind, firedAt: ev.firedAt, payload: ev.payload },
      null,
      2,
    ),
    "```",
    "",
    VERDICT_INSTRUCTION,
  ].join("\n");
}

export interface TriageOutcome {
  outcome: RunOutcome;
  verdict?: TriageVerdict;
  text?: string;
  error?: string;
}

export interface TriageLane {
  dispatch(
    job: JobSpec,
    ev: TriggerEvent,
    prompt: string,
  ): Promise<TriageOutcome>;
}

/** Structural subset of the cordis Context this runner needs, so tests can stub it. */
export type DispatchCtx = Pick<
  Context,
  "agentDefaultModel" | "agents" | "sessions" | "tools" | "get"
>;

interface TextEvent {
  seq: number;
  type: string;
  data: unknown;
}

/** Last non-empty assistant text above the watermark (spike pattern; spec §8). */
function finalText(events: readonly TextEvent[], firstSeq: number): string {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== "assistant/message") continue;
    const message = (
      event.data as { message: { content: { type: string; text?: string }[] } }
    ).message;
    const joined = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (joined !== "") text = joined;
  }
  return text;
}

export class TriageRunner implements TriageLane {
  constructor(private readonly ctx: DispatchCtx) {}

  async dispatch(
    job: JobSpec,
    ev: TriggerEvent,
    prompt: string,
  ): Promise<TriageOutcome> {
    await this.ctx.get("loader")?.await();
    const selection = this.ctx.agentDefaultModel.currentSelection();
    // job.session === 'fresh': a NEW agent per dispatch, unlike the spike's cached agent.
    // reasoningEffort is deliberately omitted: ReasoningEffortId is an open branded
    // string in dsh-llm (not a closed union), so there is no "lowest member" to pass
    // (see task-2.3-report.md Step 1) — triage reasoning stays at the dsh default.
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(`helium-${job.name}-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: {
        provider: selection.provider,
        model: job.engine.triage.model,
        maxTokens: 8_192,
      },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = {
          current: {
            provider: selection.provider,
            model: job.engine.triage.model,
          },
          assembled: undefined,
        };
        installModelSelection(agentCtx, selected);
        // restrict() throws on unknown names and on an empty filter, so deny exactly the
        // registered globals the job does not allow (dsh-tools/lib/index.js:2779-2793).
        const keep = new Set(job.tools);
        const deny = this.ctx.tools
          .schemas()
          .map((s) => s.name)
          .filter((n) => !keep.has(n));
        if (deny.length > 0) agentCtx.tools.restrict({ deny });
        agentCtx.systemPrompt.section({
          name: "helium-triage",
          order: 0,
          text: TRIAGE_PERSONA,
        });
      },
    });

    try {
      const agent = handle.agent;
      await agent.whenIdle();
      let text = await this.turn(agent, prompt);
      let verdict = parseVerdict(text);
      if (!verdict) {
        text = await this.turn(agent, CORRECTION);
        verdict = parseVerdict(text);
      }
      if (!verdict) {
        return {
          outcome: "run_failed",
          text,
          error: "parse_error: no verdict JSON after one retry",
        };
      }
      return { outcome: "run_completed", verdict, text };
    } catch (error: unknown) {
      return {
        outcome: "run_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Unconditional flush-before-dispose: turn() already flushes after every
      // successful whenIdle(), but a throw before/between turns must not skip
      // the durability checkpoint dsh's own teardown callers rely on (flush's
      // doc lists "teardown drains" as a legitimate caller —
      // dsh-session/lib/types/index.d.ts:372-382). dispose() only detaches the
      // agent/session from the in-memory live registry, never durable storage
      // (see task-2.3-report.md Step 10), so flushing again here is safe and
      // idempotent — it is what hands the persistence plugin every event
      // dispose() is about to detach from.
      await this.ctx.sessions.flush(handle.agent.session);
      await handle.dispose();
    }
  }

  private async turn(
    agent: {
      session: { seq: number; events: readonly TextEvent[] };
      followup(m: unknown): void;
      whenIdle(): Promise<void>;
    },
    text: string,
  ): Promise<string> {
    const firstSeq = agent.session.seq;
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }),
    );
    await agent.whenIdle();
    await this.ctx.sessions.flush(agent.session as never);
    return finalText(agent.session.events, firstSeq);
  }
}
