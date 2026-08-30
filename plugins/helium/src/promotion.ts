/** P4 bounded review-only promotion and durable human review queue. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, type TeamRunProjection } from "@helium/core";
import type { JobSpec } from "@helium/v1-compat";
import { z } from "zod";
import type { TriggerEvent } from "./sensor.js";
import type { TeamRunInput } from "./team-controller.js";

export type TeamPromotionMode = "shadow" | "review-only";

export const ControlledCanaryRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().regex(/^canary-[0-9a-f]{24}$/),
  caseKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  job: z.string().min(1),
  requestedBy: z.string().min(1),
  reason: z.string().min(1),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type ControlledCanaryRequest = z.infer<typeof ControlledCanaryRequestSchema>;

export interface PromotionProviderHealth {
  version: string;
  domains: Array<{
    quotaDomain: string;
    targets: string[];
    availability: { state: "available" | "quota-exhausted" | "unavailable"; retryAfter?: string };
  }>;
  circuits?: Array<{
    provider: "codex" | "deepseek" | "claude";
    consecutiveFailures: number;
    state: "closed" | "open";
  }>;
}

export interface TeamReviewItem {
  reviewId: string;
  at: string;
  status: "pending" | "accepted" | "rejected";
  job: string;
  dedupKey: string;
  team: {
    teamRunId: string;
    caseId: string;
    state: TeamRunProjection["state"];
    tasks: Record<string, number>;
    attempts: Array<{
      attemptId: string;
      taskId: string;
      state: string;
      targetId: string;
      executionSnapshot?: unknown;
    }>;
    artifacts: Array<{ ref: string; hash: string; taskId: string }>;
    budget: { tokens: number; cost: number; ms: number };
  };
  providerHealth: PromotionProviderHealth;
  operator?: string;
  reason?: string;
  decidedAt?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeNewJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  syncDirectory(parent);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const REVIEW_ID = /^review-[0-9a-f]{24}$/;

function assertReviewId(reviewId: string): void {
  if (!REVIEW_ID.test(reviewId)) throw new Error(`invalid review id: ${reviewId}`);
}

function summarize(team: TeamRunProjection): TeamReviewItem["team"] {
  const tasks: Record<string, number> = {};
  for (const task of Object.values(team.tasks)) {
    tasks[task.state] = (tasks[task.state] ?? 0) + 1;
  }
  const budget = Object.values(team.budgetReservations).reduce(
    (total, reservation) => ({
      tokens: total.tokens + reservation.amount.tokens,
      cost: total.cost + reservation.amount.cost,
      ms: total.ms + reservation.amount.ms,
    }),
    { tokens: 0, cost: 0, ms: 0 },
  );
  return {
    teamRunId: team.teamRunId,
    caseId: team.caseId,
    state: team.state,
    tasks,
    attempts: Object.values(team.attempts).map((attempt) => ({
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      state: attempt.state,
      targetId: attempt.targetId,
      ...(attempt.result?.executionSnapshot === undefined
        ? {}
        : { executionSnapshot: attempt.result.executionSnapshot }),
    })),
    artifacts: Object.values(team.artifacts).map((artifact) => ({
      ref: artifact.ref,
      hash: artifact.hash,
      taskId: artifact.taskId,
    })),
    budget,
  };
}

export class TeamReviewStore {
  readonly #pendingDir: string;
  readonly #decisionDir: string;

  constructor(
    stateRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const root = join(stateRoot, "team-reviews");
    this.#pendingDir = join(root, "pending");
    this.#decisionDir = join(root, "decisions");
    mkdirSync(this.#pendingDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#decisionDir, { recursive: true, mode: 0o700 });
  }

  enqueue(input: {
    job: string;
    dedupKey: string;
    team: TeamRunProjection;
    providerHealth: PromotionProviderHealth;
  }): TeamReviewItem {
    const reviewId = `review-${hash(canonicalJson({
      job: input.job,
      dedupKey: input.dedupKey,
      teamRunId: input.team.teamRunId,
      terminalAt: input.team.terminalAt,
    })).slice(0, 24)}`;
    const path = join(this.#pendingDir, `${reviewId}.json`);
    if (existsSync(path)) return this.get(reviewId);
    const item: TeamReviewItem = {
      reviewId,
      at: this.now().toISOString(),
      status: "pending",
      job: input.job,
      dedupKey: input.dedupKey,
      team: summarize(input.team),
      providerHealth: input.providerHealth,
    };
    writeNewJson(path, item);
    return item;
  }

  decide(input: {
    reviewId: string;
    decision: "accepted" | "rejected";
    operator: string;
    reason: string;
  }): TeamReviewItem {
    assertReviewId(input.reviewId);
    const pendingPath = join(this.#pendingDir, `${input.reviewId}.json`);
    if (!existsSync(pendingPath)) throw new Error(`unknown review: ${input.reviewId}`);
    const decisionPath = join(this.#decisionDir, `${input.reviewId}.json`);
    if (existsSync(decisionPath)) throw new Error(`review already decided: ${input.reviewId}`);
    if (input.operator.trim() === "" || input.reason.trim() === "") {
      throw new Error("review decision requires operator and reason");
    }
    writeNewJson(decisionPath, {
      reviewId: input.reviewId,
      status: input.decision,
      operator: input.operator,
      reason: input.reason,
      decidedAt: this.now().toISOString(),
    });
    return this.get(input.reviewId);
  }

  get(reviewId: string): TeamReviewItem {
    assertReviewId(reviewId);
    const pendingPath = join(this.#pendingDir, `${reviewId}.json`);
    if (!existsSync(pendingPath)) throw new Error(`unknown review: ${reviewId}`);
    const pending = readJson<TeamReviewItem>(pendingPath);
    const decisionPath = join(this.#decisionDir, `${reviewId}.json`);
    return existsSync(decisionPath)
      ? { ...pending, ...readJson<Partial<TeamReviewItem>>(decisionPath) }
      : pending;
  }

  pending(): TeamReviewItem[] {
    return readdirSync(this.#pendingDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.get(name.slice(0, -5)))
      .filter((item) => item.status === "pending");
  }
}

class DurableCanaryBudget {
  constructor(
    private readonly stateRoot: string,
    private readonly now: () => Date,
  ) {}

  claim(job: string, caseId: string, maxPerUtcDay: number): boolean {
    const day = this.now().toISOString().slice(0, 10);
    const directory = join(this.stateRoot, "team-canary", day, hash(job).slice(0, 24));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      if (readJson<{ caseId: string }>(join(directory, name)).caseId === caseId) return true;
    }
    for (let slot = 1; slot <= maxPerUtcDay; slot += 1) {
      const path = join(directory, `${slot}.json`);
      try {
        writeNewJson(path, { job, caseId, admittedAt: this.now().toISOString(), slot });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const skipped = join(
      this.stateRoot,
      "team-canary",
      "skipped",
      day,
      `${hash(canonicalJson({ job, caseId })).slice(0, 24)}.json`,
    );
    if (!existsSync(skipped)) {
      writeNewJson(skipped, {
        job,
        caseId,
        reason: "daily-cap-exhausted",
        skippedAt: this.now().toISOString(),
        maxPerUtcDay,
      });
    }
    return false;
  }
}

export interface TeamPromotionAdapterOptions {
  mode: TeamPromotionMode;
  canaryJobs: string[];
  maxPerUtcDay: number;
  stateRoot: string;
  run(input: TeamRunInput): Promise<TeamRunProjection>;
  providerHealth(): PromotionProviderHealth;
  now?: () => Date;
}

/** v1-first fan-out whose promoted output can only enter the review queue. */
export class TeamPromotionAdapter {
  readonly #reviews: TeamReviewStore;
  readonly #budget: DurableCanaryBudget;
  readonly #now: () => Date;

  constructor(private readonly options: TeamPromotionAdapterOptions) {
    if (options.mode === "review-only" && options.canaryJobs.length === 0) {
      throw new Error("review-only promotion requires a canary job allow-list");
    }
    if (!Number.isSafeInteger(options.maxPerUtcDay) || options.maxPerUtcDay < 1) {
      throw new Error("team canary daily cap must be a positive integer");
    }
    this.#now = options.now ?? (() => new Date());
    this.#reviews = new TeamReviewStore(options.stateRoot, this.#now);
    this.#budget = new DurableCanaryBudget(options.stateRoot, this.#now);
  }

  async handle(job: JobSpec, event: TriggerEvent, continueV1: () => void): Promise<void> {
    continueV1();
    if (this.options.mode === "review-only" && !this.options.canaryJobs.includes(job.name)) {
      return;
    }
    const content = canonicalJson({ job: job.name, event });
    const digest = hash(content);
    const caseId = `shadow-${digest.slice(0, 24)}`;
    if (
      this.options.mode === "review-only"
      && !this.#budget.claim(job.name, caseId, this.options.maxPerUtcDay)
    ) {
      return;
    }
    const team = await this.options.run({
      caseId,
      subject: `${job.name}:${event.kind}`,
      prompt: job.prompt,
      inputArtifacts: [{
        ref: `artifact://shadow-trigger/${digest}`,
        hash: `sha256:${digest}`,
        content,
      }],
    });
    if (this.options.mode === "review-only" && team.state === "completed") {
      this.#reviews.enqueue({
        job: job.name,
        dedupKey: event.dedupKey,
        team,
        providerHealth: this.options.providerHealth(),
      });
    }
  }

  /**
   * Runs one explicit operator canary. This is not a production trigger, so it
   * does not dispatch v1 or deliver anything; its only output is a pending
   * review item. The same caseKey may be retried after a pressure refusal.
   */
  async handleCanary(job: JobSpec, request: ControlledCanaryRequest): Promise<void> {
    if (this.options.mode !== "review-only") {
      throw new Error("controlled canary requires review-only mode");
    }
    if (request.job !== job.name || !this.options.canaryJobs.includes(job.name)) {
      throw new Error(`job is not allow-listed for canary: ${request.job}`);
    }
    const budgetCaseId = `canary-${hash(canonicalJson({ job: job.name, caseKey: request.caseKey })).slice(0, 24)}`;
    if (!this.#budget.claim(job.name, budgetCaseId, this.options.maxPerUtcDay)) {
      throw new Error("team canary daily cap exhausted");
    }
    // A request is one execution attempt of the logical, daily-bounded case.
    // Pressure or provider-infrastructure failures are immutable terminal team
    // runs, so a retry needs its own partition instead of replaying that
    // terminal projection. The stable caseKey above still owns exactly one
    // daily slot; a different logical case remains refused by the cap.
    const caseId = `canary-${hash(canonicalJson({
      job: job.name,
      caseKey: request.caseKey,
      requestId: request.requestId,
    })).slice(0, 24)}`;
    const content = canonicalJson(request);
    const digest = hash(content);
    const team = await this.options.run({
      caseId,
      subject: `${job.name}:controlled-canary`,
      prompt: job.prompt,
      inputArtifacts: [{
        ref: `artifact://controlled-canary/${digest}`,
        hash: `sha256:${digest}`,
        content,
      }],
    });
    if (team.state !== "completed") {
      throw new Error(`controlled canary did not complete: ${team.state}`);
    }
    this.#reviews.enqueue({
      job: job.name,
      dedupKey: request.requestId,
      team,
      providerHealth: this.options.providerHealth(),
    });
  }
}
