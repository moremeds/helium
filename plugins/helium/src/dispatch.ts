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
  meetsThreshold,
  parseVerdict,
  type JobSpec,
  type RunLedger,
  type RunOutcome,
  type SensorState,
  type StateStore,
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

/**
 * Dispatch — orchestrator (spec §8): the only place that turns a trigger
 * event into LLM work. Owns per-job single-flight with latest-wins
 * coalescing (queue depth 1), the global senior semaphore, rolling budget
 * windows, the two-phase run ledger, and per-dispatch wall-clock timeouts.
 */

/** Slot-limited holder queue: `limit` concurrent holders, FIFO beyond that. */
export class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];
  constructor(limit: number) {
    this.#free = limit;
  }
  async acquire(): Promise<() => void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    return () => this.#release();
  }
  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/** Drop stamps older than the rolling window; order is preserved. */
export function pruneFires(
  stamps: string[],
  windowMs: number,
  now: number,
): string[] {
  return stamps.filter((s) => now - Date.parse(s) < windowMs);
}

const TRIAGE_WINDOW_MS = 3_600_000;
const SENIOR_WINDOW_MS = 86_400_000;

export interface BudgetCheck {
  allowed: boolean;
  count: number;
  cap: number;
}

/**
 * Rolling-window budget check for one tier. Prunes `state`'s fire stamps for
 * that tier in place as a side effect — callers persist the pruned state via
 * {@link StateStore.saveSensor} whether or not the check allows the dispatch.
 */
export function budgetCheck(
  state: SensorState,
  job: JobSpec,
  tier: "triage" | "senior",
  now: number,
): BudgetCheck {
  const isTriage = tier === "triage";
  const windowMs = isTriage ? TRIAGE_WINDOW_MS : SENIOR_WINDOW_MS;
  const cap = isTriage
    ? job.budget.maxTriagePerHour
    : job.budget.maxSeniorPerDay;
  const kept = pruneFires(
    isTriage ? state.triageFires : state.seniorFires,
    windowMs,
    now,
  );
  if (isTriage) state.triageFires = kept;
  else state.seniorFires = kept;
  return { allowed: kept.length < cap, count: kept.length, cap };
}

/** Race a lane against the job wall clock. The lane is left to settle; only the wait ends. */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SeniorLane {
  dispatch(
    job: JobSpec,
    ev: TriggerEvent,
    prompt: string,
  ): Promise<{ outcome: RunOutcome; analysis?: string; error?: string }>;
}

export interface ThesisReader {
  read(job: string): string | null;
}

/** Four-layer context injection: ecosystem context → standing thesis → job prompt → triage verdict + trigger payload. */
export function assembleSeniorPrompt(
  contextText: string,
  job: JobSpec,
  ev: TriggerEvent,
  verdict: TriageVerdict,
  thesis: string | null,
): string {
  const parts = ["## Ecosystem context", contextText.trim(), ""];
  if (thesis) parts.push("## Standing thesis", thesis.trim(), "");
  parts.push(
    "## Job",
    job.prompt.trim(),
    "",
    "## Triage verdict",
    "```json",
    JSON.stringify(verdict, null, 2),
    "```",
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
    "Write the analysis for the operator. If the standing thesis changed, rewrite it through " +
      "the thesis_write tool — never edit the thesis file directly.",
  );
  return parts.join("\n");
}

export interface DispatchResult {
  runId: string;
  tier: "triage" | "senior";
  outcome: RunOutcome;
  verdict?: TriageVerdict;
  analysis?: string;
  error?: string;
}

interface Queued {
  job: JobSpec;
  ev: TriggerEvent;
}

export class Dispatcher {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Queued>(); // depth 1: latest wins (spec §8)
  readonly #seniorSlots: Semaphore;

  constructor(
    private readonly opts: {
      store: StateStore;
      ledger: RunLedger;
      contextText: string;
      triage: TriageLane;
      senior: SeniorLane;
      thesis?: ThesisReader;
      onResult: (
        job: JobSpec,
        ev: TriggerEvent,
        result: DispatchResult,
      ) => void | Promise<void>;
      onSuppressed: (
        job: JobSpec,
        ev: TriggerEvent,
        info: BudgetCheck & { tier: string },
      ) => void | Promise<void>;
      maxConcurrentSenior?: number;
      now?: () => Date;
    },
  ) {
    this.#seniorSlots = new Semaphore(opts.maxConcurrentSenior ?? 2);
  }

  /** Start `job` immediately if it has no run in flight, else queue it (replacing any already-queued follow-up). */
  enqueue(job: JobSpec, ev: TriggerEvent): void {
    if (this.#inFlight.has(job.name)) {
      this.#pending.set(job.name, { job, ev });
      return;
    }
    this.#start(job, ev);
  }

  /** Resolve once every in-flight and queued run for every job has settled. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0 || this.#pending.size > 0) {
      await Promise.all([...this.#inFlight.values()]);
    }
  }

  #start(job: JobSpec, ev: TriggerEvent): void {
    const run = this.#run(job, ev).finally(() => {
      this.#inFlight.delete(job.name);
      const next = this.#pending.get(job.name);
      if (next) {
        this.#pending.delete(job.name);
        this.#start(next.job, next.ev);
      }
    });
    this.#inFlight.set(job.name, run);
  }

  #now(): number {
    return (this.opts.now ?? (() => new Date()))().getTime();
  }

  #spend(job: string, tier: "triage" | "senior"): void {
    const state = this.opts.store.loadSensor(job);
    const stamp = new Date(this.#now()).toISOString();
    if (tier === "triage") state.triageFires.push(stamp);
    else state.seniorFires.push(stamp);
    this.opts.store.saveSensor(job, state);
  }

  async #run(job: JobSpec, ev: TriggerEvent): Promise<void> {
    // Controller addendum (Task 2.3 ruling): v1 has exactly one in-process
    // triage engine. A job whose config drifted away from it fails loudly
    // instead of silently paying for a dispatch the runtime cannot honor —
    // and it never touches the budget, since no lane actually ran.
    if (job.engine.triage.engine !== "deepseek") {
      const runId = this.opts.ledger.start(job.name, "triage");
      const error = `unsupported triage engine ${JSON.stringify(job.engine.triage.engine)} (v1 supports only "deepseek")`;
      this.opts.ledger.finish(runId, job.name, "triage", "run_failed", {
        error,
      });
      await this.opts.onResult(job, ev, {
        runId,
        tier: "triage",
        outcome: "run_failed",
        error,
      });
      return;
    }

    const state = this.opts.store.loadSensor(job.name);
    const triageBudget = budgetCheck(state, job, "triage", this.#now());
    this.opts.store.saveSensor(job.name, state);
    if (!triageBudget.allowed) {
      await this.opts.onSuppressed(job, ev, {
        ...triageBudget,
        tier: "triage",
      });
      return;
    }

    this.#spend(job.name, "triage");
    const triageId = this.opts.ledger.start(job.name, "triage");
    const prompt = assembleTriagePrompt(this.opts.contextText, job, ev);
    const triage = await withTimeout(
      this.opts.triage.dispatch(job, ev, prompt),
      job.timeoutMs,
      () => ({
        outcome: "timed_out" as const,
        error: "triage exceeded job timeout",
      }),
    );
    this.opts.ledger.finish(triageId, job.name, "triage", triage.outcome, {
      severity: triage.verdict?.severity,
      error: triage.error,
    });
    await this.opts.onResult(job, ev, {
      runId: triageId,
      tier: "triage",
      outcome: triage.outcome,
      verdict: triage.verdict,
      error: triage.error,
    });

    const verdict = triage.verdict;
    if (triage.outcome !== "run_completed" || !verdict) return;
    if (!meetsThreshold(verdict, job.escalateWhen)) return;

    const seniorState = this.opts.store.loadSensor(job.name);
    const seniorBudget = budgetCheck(seniorState, job, "senior", this.#now());
    this.opts.store.saveSensor(job.name, seniorState);
    if (!seniorBudget.allowed) {
      await this.opts.onSuppressed(job, ev, {
        ...seniorBudget,
        tier: "senior",
      });
      return;
    }

    const release = await this.#seniorSlots.acquire();
    try {
      this.#spend(job.name, "senior");
      const seniorId = this.opts.ledger.start(job.name, "senior");
      const thesis =
        job.memory === "thesis-file"
          ? (this.opts.thesis?.read(job.name) ?? null)
          : null;
      const seniorPrompt = assembleSeniorPrompt(
        this.opts.contextText,
        job,
        ev,
        verdict,
        thesis,
      );
      const senior = await withTimeout(
        this.opts.senior.dispatch(job, ev, seniorPrompt),
        job.timeoutMs,
        () => ({
          outcome: "timed_out" as const,
          error: "senior exceeded job timeout",
        }),
      );
      this.opts.ledger.finish(seniorId, job.name, "senior", senior.outcome, {
        error: senior.error,
      });
      await this.opts.onResult(job, ev, {
        runId: seniorId,
        tier: "senior",
        outcome: senior.outcome,
        verdict,
        analysis: senior.analysis,
        error: senior.error,
      });
    } finally {
      release();
    }
  }
}
