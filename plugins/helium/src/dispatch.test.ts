import { describe, expect, it } from "vitest";
import type { JobSpec } from "@helium/core";
import { TriageRunner, assembleTriagePrompt } from "./dispatch.js";
import type { TriggerEvent } from "./sensor.js";

const job = {
  name: "macro-watch",
  enabled: true,
  triggers: [],
  engine: {
    triage: { engine: "deepseek", model: "deepseek-v4-flash" },
    senior: { engine: "claude-max" },
  },
  escalateWhen: "material",
  session: "fresh",
  memory: "thesis-file",
  tools: ["argon_api"],
  allowMutations: false,
  maxTurns: { triage: 2, senior: 8 },
  timeoutMs: 600_000,
  budget: { maxTriagePerHour: 30, maxSeniorPerDay: 12 },
  delivery: { jsonl: true },
  prompt: "Judge whether the macro state change matters.",
} as unknown as JobSpec;

const ev: TriggerEvent = {
  job: "macro-watch",
  kind: "state-change",
  firedAt: "2026-08-23T12:00:00.000Z",
  dedupKey: "macro-watch:u:abc",
  payload: { previous: { s: "a" }, current: { s: "b" } },
};

/** Minimal fake matching the dsh Agent surface the runner touches. */
function fakeCtx(replies: string[]) {
  const created: unknown[] = [];
  let disposed = 0;
  const events: { seq: number; type: string; data: unknown }[] = [];
  const agent = {
    session: {
      get seq() {
        return events.length;
      },
      get events() {
        return events;
      },
    },
    followup(): void {
      const text = replies.shift() ?? "";
      events.push({
        seq: events.length,
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text }] } },
      });
    },
    whenIdle: async (): Promise<void> => {},
  };
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      }),
    },
    agents: {
      create: async (options: unknown) => {
        created.push(options);
        return {
          agent,
          dispose: async (): Promise<void> => {
            disposed += 1;
          },
        };
      },
    },
    sessions: { flush: async (): Promise<boolean> => true },
    tools: {
      schemas: () => [
        { name: "argon_api" },
        { name: "bash" },
        { name: "edit" },
      ],
    },
    get: () => ({ await: async (): Promise<void> => {} }),
  };
  return { ctx, created, agent, disposed: () => disposed };
}

describe("assembleTriagePrompt", () => {
  it("layers ecosystem context, the job prompt, the payload and the verdict instruction", () => {
    const prompt = assembleTriagePrompt("ECOSYSTEM CONTEXT BODY", job, ev);
    expect(prompt.indexOf("ECOSYSTEM CONTEXT BODY")).toBeLessThan(
      prompt.indexOf("Judge whether the macro state change matters."),
    );
    expect(
      prompt.indexOf("Judge whether the macro state change matters."),
    ).toBeLessThan(prompt.indexOf('"current"'));
    expect(prompt.trimEnd().endsWith('"reason": string}')).toBe(true);
  });
});

describe("TriageRunner", () => {
  it("creates a fresh session per dispatch, restricts tools and disposes the handle", async () => {
    const h = fakeCtx([
      '{"escalate": true, "severity": "material", "reason": "flip"}',
    ]);
    const runner = new TriageRunner(h.ctx as never);
    const first = await runner.dispatch(job, ev, "p1");
    const second = await runner.dispatch(job, ev, "p2");

    expect(first.outcome).toBe("run_completed");
    expect(h.created).toHaveLength(2);
    const a = h.created[0] as {
      sessionId: string;
      agentOptions: { model: string };
    };
    const b = h.created[1] as { sessionId: string };
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.agentOptions.model).toBe("deepseek-v4-flash");
    expect(h.disposed()).toBe(2);
    expect(second.outcome).toBe("run_failed"); // no reply left in the fake
  });

  it("returns the parsed verdict from the last assistant message", async () => {
    const h = fakeCtx([
      'prose\n{"escalate": true, "severity": "critical", "reason": "cut"}',
    ]);
    const result = await new TriageRunner(h.ctx as never).dispatch(
      job,
      ev,
      "p",
    );
    expect(result.verdict).toEqual({
      escalate: true,
      severity: "critical",
      reason: "cut",
    });
  });

  it("retries once with a corrective followup when the verdict does not parse", async () => {
    const h = fakeCtx([
      "no json here",
      '{"escalate": false, "severity": "noise", "reason": "ok"}',
    ]);
    const result = await new TriageRunner(h.ctx as never).dispatch(
      job,
      ev,
      "p",
    );
    expect(result.outcome).toBe("run_completed");
    expect(result.verdict?.severity).toBe("noise");
  });

  it("fails with a parse_error detail when the retry also fails", async () => {
    const h = fakeCtx(["nope", "still nope"]);
    const result = await new TriageRunner(h.ctx as never).dispatch(
      job,
      ev,
      "p",
    );
    expect(result.outcome).toBe("run_failed");
    expect(result.error).toContain("parse_error");
    expect(result.text).toBe("still nope");
  });
});
