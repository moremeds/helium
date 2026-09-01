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
import { z } from "zod";
import type { TeamRunInput } from "./team-controller.js";
import {
  buildTenantRunInput,
  type TenantTriggerEvent,
} from "./tenant-runtime.js";
import type { LoadedTenant } from "./tenants.js";

export type TeamPromotionMode = "shadow" | "review-only" | "delivered";

const ORDER = ["off", "shadow", "review-only", "delivered"] as const;

/**
 * The more restrictive of the host brake (`HELIUM_TEAM_PROMOTION_MODE`) and the
 * tenant's own request (`tenant.yaml`'s `promotionMode`). The host key can only
 * ever restrict; the tenant file is a request, never a grant.
 */
export function narrower(
  host: TeamPromotionMode | "off",
  tenant: TeamPromotionMode,
): TeamPromotionMode | "off" {
  return ORDER.indexOf(host) <= ORDER.indexOf(tenant) ? host : tenant;
}

export const ControlledCanaryRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().regex(/^canary-[0-9a-f]{24}$/),
  caseKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  tenant: z.string().min(1),
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
  mode: TeamPromotionMode | "off";
  canaryTenants: string[];
  maxPerUtcDay: number;
  stateRoot: string;
  providerHealth(): PromotionProviderHealth;
  now?: () => Date;
}

/** The single owner of promotion: allow-list, daily budget, review fallback. */
export class TeamPromotionAdapter {
  readonly #reviews: TeamReviewStore;
  readonly #budget: DurableCanaryBudget;
  readonly #now: () => Date;

  constructor(private readonly options: TeamPromotionAdapterOptions) {
    if (
      options.mode !== "off"
      && options.mode !== "shadow"
      && options.canaryTenants.length === 0
    ) {
      throw new Error(`${options.mode} promotion requires a canary tenant allow-list`);
    }
    if (!Number.isSafeInteger(options.maxPerUtcDay) || options.maxPerUtcDay < 1) {
      throw new Error("team canary daily cap must be a positive integer");
    }
    this.#now = options.now ?? (() => new Date());
    this.#reviews = new TeamReviewStore(options.stateRoot, this.#now);
    this.#budget = new DurableCanaryBudget(options.stateRoot, this.#now);
  }

  async handle(
    loaded: LoadedTenant,
    event: TenantTriggerEvent,
    run: (input: TeamRunInput) => Promise<TeamRunProjection>,
  ): Promise<void> {
    const tenant = loaded.spec.tenant;
    // The effective mode is the MORE RESTRICTIVE of the host brake and the
    // tenant's own request, ordered off < shadow < review-only < delivered.
    // One switch, decided in one place.
    const mode = narrower(this.options.mode, loaded.spec.promotionMode);
    if (mode === "off") return;
    if (mode !== "shadow" && !this.options.canaryTenants.includes(tenant)) {
      return;
    }
    // The SAME derivation `TenantRuntime` would use, from the one exported
    // builder -- two independent copies of the caseId hash is how a budget
    // claim and the run it is meant to bound come to disagree.
    const input = buildTenantRunInput(
      tenant,
      event,
      loaded.prompt ?? `${tenant} scheduled run`,
    );
    if (
      mode !== "shadow"
      && !this.#budget.claim(tenant, input.caseId, this.options.maxPerUtcDay)
    ) {
      return;
    }
    const team = await run(input);
    if (mode === "shadow" || team.state !== "completed") return;
    // `delivered` still enqueues a review item when nothing actually went out:
    // a gate failure, a disabled env opt-in and a dead SMTP host all land the
    // run in the human inbox rather than nowhere. `delivered` ONLY --
    // `uncertain` (skipped, rate-capped, pending) and `failed` mean the human
    // still needs to see it.
    const delivered = Object.values(team.deliveries ?? {}).some(
      (record) => record.state === "delivered",
    );
    if (mode === "delivered" && delivered) return;
    this.#reviews.enqueue({
      job: tenant,
      dedupKey: event.dedupKey,
      team,
      providerHealth: this.options.providerHealth(),
    });
  }

  /**
   * Runs one explicit operator canary. This is not a production trigger, so it
   * does not dispatch v1 or deliver anything; its only output is a pending
   * review item. The same caseKey may be retried after a pressure refusal.
   */
  async handleCanary(
    loaded: LoadedTenant,
    request: ControlledCanaryRequest,
    run: (input: TeamRunInput) => Promise<TeamRunProjection>,
  ): Promise<void> {
    const tenant = loaded.spec.tenant;
    if (this.options.mode === "off" || this.options.mode === "shadow") {
      throw new Error("controlled canary requires review-only or delivered mode");
    }
    if (request.tenant !== tenant || !this.options.canaryTenants.includes(tenant)) {
      throw new Error(`tenant is not allow-listed for canary: ${request.tenant}`);
    }
    const budgetCaseId = `canary-${hash(canonicalJson({ tenant, caseKey: request.caseKey })).slice(0, 24)}`;
    if (!this.#budget.claim(tenant, budgetCaseId, this.options.maxPerUtcDay)) {
      throw new Error("team canary daily cap exhausted");
    }
    // A request is one execution attempt of the logical, daily-bounded case.
    // Pressure or provider-infrastructure failures are immutable terminal team
    // runs, so a retry needs its own partition instead of replaying that
    // terminal projection. The stable caseKey above still owns exactly one
    // daily slot; a different logical case remains refused by the cap.
    const caseId = `canary-${hash(canonicalJson({
      tenant,
      caseKey: request.caseKey,
      requestId: request.requestId,
    })).slice(0, 24)}`;
    const content = canonicalJson(request);
    const digest = hash(content);
    const team = await run({
      caseId,
      subject: `${tenant}:controlled-canary`,
      prompt: loaded.prompt ?? `${tenant} controlled canary`,
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
      job: tenant,
      dedupKey: request.requestId,
      team,
      providerHealth: this.options.providerHealth(),
    });
  }
}
