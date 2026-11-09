/**
 * The `helium` app: `dsh --profile helium <command>`.
 *
 *   run <pipeline> [--phase P] [--as-of yyyy-mm-dd] [--timeout SECONDS]
 *   audit <run-id>
 *
 * One run per process. The runner creates a driver agent that is never
 * prompted (it only parents the child agents, and its cwd is the sandbox's
 * writable root), settles due ledger entries, runs the pipeline under a
 * whole-run timeout, and writes one span row per model step as DSH appends
 * it (`session/event`), so a crash still leaves the tokens it spent on record.
 * The same event stream counts each child's steps: a child that starts more
 * than its task's `maxSteps` is stopped and its task fails.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setAsOf } from "./asof.js";
import { deliver, type ChannelName, type Doc } from "./delivery.js";
import { pipelines, type AgentTask, type Run } from "./index.js";
import { DEFAULT_MODELS, costUsd, type Capability, type ModelChoice } from "./models.js";
import { auditRows, openEntries, openStore, stateRoot } from "./store.js";

export const name = "helium-runner";
export const inject = ["agents", "subagents"];

interface Config {
  /** Per-deployment override of capability -> model (tests use the fake LLM). */
  models?: Partial<Record<Capability, ModelChoice>>;
}

const log = (m: string) => process.stderr.write(`[helium] ${m}\n`);

// ponytail: DSH ships types for ctx, but the runner touches five members;
// typing them loosely keeps cordis out of the compile.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any;

export function apply(ctx: Ctx, config: Config = {}): void {
  const exit = ctx.get("appExit") as (code: number) => void;
  main(ctx, config).then(exit, (e: unknown) => {
    log(`FAIL ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    exit(1);
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function codeVersion(): string {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    return readFileSync(`${root}RELEASE`, "utf8").trim();
  } catch {
    try {
      return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  }
}

async function main(ctx: Ctx, config: Config): Promise<number> {
  await ctx.get("loader")?.await();
  const args = (ctx.get("cmdlineArgs").get() as string[]) ?? [];
  const [command, target] = args;
  const db = openStore();

  if (command === "audit" && target) {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(target) as Record<string, unknown> | undefined;
    if (run === undefined) return log(`no run ${target}`), 1;
    process.stdout.write(`code: ${run.code}\nrun: ${run.id} ${run.bundle}/${run.phase ?? "-"} as-of ${run.as_of} ${run.status}\n`);
    console.table(auditRows(db, target));
    return 0;
  }
  if (command !== "run" || !target) {
    log("usage: run <pipeline> [--phase P] [--as-of yyyy-mm-dd] [--timeout SECONDS] | audit <run-id>");
    return 2;
  }
  const pipeline = pipelines().get(target);
  if (pipeline === undefined) {
    log(`no pipeline ${target}; installed: ${[...pipelines().keys()].join(", ") || "none"}`);
    return 2;
  }

  const models = { ...DEFAULT_MODELS, ...config.models };
  const phase = flag(args, "phase");
  // The phase names report files and the argon kind: one plain word.
  if (phase !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(phase)) {
    log(`--phase must be lower-case letters, digits and dashes, got ${phase}`);
    return 2;
  }
  const asOf = flag(args, "as-of") ?? new Intl.DateTimeFormat("en-CA", { timeZone: pipeline.zone ?? "UTC" }).format(new Date());
  setAsOf(asOf);
  const runId = `${asOf}-${target}-${phase ?? "run"}-${randomUUID().slice(0, 8)}`;
  const code = codeVersion();
  db.prepare("INSERT INTO runs (id, bundle, phase, as_of, code, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')").run(
    runId, target, phase ?? null, asOf, code, new Date().toISOString(),
  );
  log(`run ${runId} code ${code}`);

  // Spans: one row per assistant step, written as the event lands.
  const labels = new Map<string, string>();
  const stepStart = new Map<string, number>();
  const stepModel = new Map<string, string>();
  const steps = new Map<string, number>();
  const caps = new Map<string, { max: number; trip(): void }>();
  const insertSpan = db.prepare(
    `INSERT INTO spans (run_id, session_id, role, label, step, model, input, output, cache_read, cache_write, context, wall_ms, cost_usd, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ctx.on("session/event", (session: any, event: any) => {
    const sid: string = session.id;
    if (event.type === "request/context") stepModel.set(sid, event.data.model);
    else if (event.type === "step/start") {
      stepStart.set(sid, event.time);
      const n = (steps.get(sid) ?? 0) + 1;
      steps.set(sid, n);
      const cap = caps.get(sid);
      if (cap !== undefined && n > cap.max) cap.trip();
    }
    else if (event.type === "assistant/message" && event.data.usage) {
      const u = event.data.usage;
      const usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0 };
      const model = stepModel.get(sid) ?? null;
      const role: string = session.header?.agentPreset ?? "driver";
      const started = stepStart.get(sid);
      insertSpan.run(
        runId, sid, role, labels.get(sid) ?? null, event.data.step, model,
        usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
        usage.input + usage.cacheRead + usage.cacheWrite,
        started === undefined ? null : event.time - started,
        model === null ? null : costUsd(model, usage),
        new Date(event.time).toISOString(),
      );
    }
  });

  const timeoutS = Number(flag(args, "timeout") ?? 1800);
  const signal = AbortSignal.timeout(timeoutS * 1000);
  const live = new Set<{ dispose(): Promise<void> }>();
  const aborted = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => {
      for (const a of live) a.dispose().catch(() => {});
      reject(new Error(`run timed out after ${timeoutS}s`));
    }),
  );
  aborted.catch(() => {});

  const { agent: driver } = await ctx.agents.create({
    sessionId: `helium-${runId}`,
    meta: { cwd: process.env.HELIUM_RUN_CWD ?? process.cwd() },
    agentOptions: models["reason.quick"],
  });
  await driver.whenIdle();

  const root = stateRoot();
  const run: Run = {
    id: runId,
    bundle: target,
    phase,
    asOf,
    signal,
    log: (m) => log(`${target}: ${m}`),
    async agent<T>(task: AgentTask): Promise<T> {
      const label = task.label ?? task.role;
      const max = task.maxSteps ?? 10;
      const prompt = `${task.prompt}\n\nYou have at most ${max} model steps for this task; submit your answer with structured_output before then.`;
      const activation = await ctx.subagents.startActivation({
        provider: "spawn",
        label,
        signal,
        delivery: "caller",
        request: {
          agentPreset: task.role,
          parent: driver,
          prompt: [{ type: "text", text: prompt }],
          agentOptions: models[task.capability],
          outputSchema: task.schema,
        },
      });
      labels.set(activation.childId, label);
      live.add(activation);
      let overran!: (e: Error) => void;
      const overrun = new Promise<never>((_, reject) => (overran = reject));
      caps.set(activation.childId, {
        max,
        trip() {
          activation.dispose().catch(() => {});
          overran(new Error(`agent ${label} started step ${max + 1} of at most ${max}`));
        },
      });
      try {
        const r = await Promise.race([activation.result, overrun]);
        const stop = typeof r.stopReason === "string" ? r.stopReason : r.stopReason?.kind;
        if (stop !== "completed" || r.structured === undefined) {
          throw new Error(`agent ${label} ended ${stop}${r.diagnostic ? `: ${r.diagnostic}` : ""} without structured output`);
        }
        return r.structured as T;
      } finally {
        live.delete(activation);
        caps.delete(activation.childId);
      }
    },
    deliver: (channel: ChannelName, doc: Doc) =>
      deliver(channel, doc, pipeline.channels, { db, stateRoot: root, runId, bundle: target, phase, day: asOf, code, env: process.env, signal }),
    enter(key, due, payload) {
      db.prepare("INSERT INTO ledger (id, bundle, run_id, key, as_of, due, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        `${runId}:${key}`, target, runId, key, asOf, due, JSON.stringify(payload),
      );
    },
  };

  const finish = (status: string, detail: string | null) =>
    db.prepare("UPDATE runs SET status = ?, detail = ?, ended_at = ? WHERE id = ?").run(status, detail, new Date().toISOString(), runId);
  try {
    if (pipeline.settle) {
      const due = openEntries(db, target, asOf);
      if (due.length > 0) {
        const settled = await Promise.race([pipeline.settle(due, run), aborted]);
        const ids = new Set(due.map((d) => d.id));
        const stray = settled.filter((s) => !ids.has(s.id)).map((s) => s.id);
        if (stray.length > 0) throw new Error(`settle returned entries it was not given: ${stray.join(", ")}`);
        const upd = db.prepare("UPDATE ledger SET outcome = ?, settled_run = ? WHERE id = ? AND outcome IS NULL");
        for (const s of settled) upd.run(JSON.stringify(s.outcome), runId, s.id);
        log(`settled ${settled.length}/${due.length}`);
      }
    }
    const work = pipeline.run(run);
    work.catch(() => {}); // after a timeout it still rejects; the race already decided
    await Promise.race([work, aborted]);
    finish("ok", null);
    log(`ok ${runId}`);
    return 0;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    finish(signal.aborted ? "timeout" : "failed", detail);
    log(`failed ${runId}: ${detail}`);
    return 1;
  }
}
