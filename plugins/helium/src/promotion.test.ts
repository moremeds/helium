import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TeamRunProjection } from "@helium/core";
import {
  TeamPromotionAdapter,
  TeamReviewStore,
} from "./promotion.js";
import type { TriggerEvent } from "./sensor.js";

const job = { name: "macro-watch", prompt: "analyze" } as never;
const otherJob = { name: "other", prompt: "analyze" } as never;
const event: TriggerEvent = {
  job: "macro-watch",
  kind: "cron",
  firedAt: "2026-08-30T00:00:00.000Z",
  dedupKey: "macro:one",
  payload: { n: 1 },
};
const now = () => new Date("2026-08-30T01:00:00.000Z");

function projection(caseId: string): TeamRunProjection {
  return {
    teamRunId: `${caseId}:shadow`,
    caseId,
    state: "completed",
    roster: {},
    graphRevision: 1,
    tasks: {
      renderer: {
        id: "renderer",
        ownerAgentId: "renderer",
        dependsOn: [],
        acceptance: { outputSchema: "ShadowReport.v1" },
        revision: 1,
        state: "completed",
      },
    },
    artifacts: {
      "artifact://report/one": {
        taskId: "renderer",
        ref: "artifact://report/one",
        hash: `sha256:${"a".repeat(64)}`,
        publishedAt: now().toISOString(),
      },
    },
    artifactRefs: ["artifact://report/one"],
    budgetReservations: {},
    attempts: {},
    capacityWaits: {},
    waitingByTask: {},
    deliveries: {},
    startedAt: now().toISOString(),
    terminalAt: now().toISOString(),
  };
}

describe("P4 team promotion", () => {
  it("preserves v1 first and refuses tenants outside the canary allow-list", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const order: string[] = [];
    const run = vi.fn(async (input) => {
      order.push("team");
      return projection(input.caseId);
    });
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryJobs: ["macro-watch"],
      maxPerUtcDay: 1,
      stateRoot: root,
      run,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await adapter.handle(otherJob, event, () => order.push("v1"));
    expect(order).toEqual(["v1"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces the daily canary bound across adapter restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input) => projection(input.caseId));
    const build = () => new TeamPromotionAdapter({
      mode: "review-only",
      canaryJobs: ["macro-watch"],
      maxPerUtcDay: 1,
      stateRoot: root,
      run,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await build().handle(job, event, () => {});
    await build().handle(job, { ...event, dedupKey: "macro:two" }, () => {});
    expect(run).toHaveBeenCalledOnce();
    const skippedDay = join(root, "team-canary", "skipped", "2026-08-30");
    expect(readdirSync(skippedDay)).toHaveLength(1);
  });

  it("writes a complete pending-review surface and never auto-approves", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryJobs: ["macro-watch"],
      maxPerUtcDay: 1,
      stateRoot: root,
      run: async (input) => projection(input.caseId),
      now,
      providerHealth: () => ({
        version: "providers-1",
        domains: [{ quotaDomain: "codex", targets: ["opaque-1"], availability: { state: "available" } }],
      }),
    });

    await adapter.handle(job, event, () => {});
    const pending = new TeamReviewStore(root, now).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "pending",
      job: "macro-watch",
      team: {
        state: "completed",
        tasks: { completed: 1 },
        artifacts: [{ ref: "artifact://report/one", hash: `sha256:${"a".repeat(64)}` }],
      },
      providerHealth: { version: "providers-1" },
    });
  });

  it("runs an operator-requested review-only case without dispatching v1", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input) => projection(input.caseId));
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryJobs: ["macro-watch"],
      maxPerUtcDay: 1,
      stateRoot: root,
      run,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await adapter.handleCanary(job, {
      version: 1,
      requestId: `canary-${"a".repeat(24)}`,
      caseKey: "weekend-smoke-1",
      job: "macro-watch",
      requestedBy: "weekend-operator",
      reason: "prove the review-only path",
      createdAt: "2026-08-30T00:55:00.000Z",
      expiresAt: "2026-08-30T02:00:00.000Z",
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      caseId: expect.stringMatching(/^canary-/),
      subject: "macro-watch:controlled-canary",
    });
    expect(new TeamReviewStore(root, now).pending()).toHaveLength(1);
  });

  it("accepts one attributable human decision for a pending review", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const reviews = new TeamReviewStore(root, now);
    const item = reviews.enqueue({
      job: "macro-watch",
      dedupKey: "macro:one",
      team: projection("case-one"),
      providerHealth: { version: "providers-1", domains: [] },
    });
    reviews.decide({
      reviewId: item.reviewId,
      decision: "accepted",
      operator: "weekend-operator",
      reason: "evidence checked",
    });
    expect(reviews.get(item.reviewId)).toMatchObject({
      status: "accepted",
      operator: "weekend-operator",
      reason: "evidence checked",
    });
    expect(() => reviews.decide({
      reviewId: item.reviewId,
      decision: "rejected",
      operator: "weekend-operator",
      reason: "second decision",
    })).toThrow(/already decided/i);
    expect(() => reviews.decide({
      reviewId: `review-${"0".repeat(24)}`,
      decision: "rejected",
      operator: "weekend-operator",
      reason: "unknown",
    })).toThrow(/unknown review/i);
    expect(() => reviews.get("../escape")).toThrow(/invalid review id/i);
  });
});
