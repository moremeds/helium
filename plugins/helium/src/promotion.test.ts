import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TeamRunProjection } from "@helium/core";
import {
  narrower,
  TeamPromotionAdapter,
  TeamReviewStore,
} from "./promotion.js";
import type { TenantTriggerEvent } from "./tenant-runtime.js";
import type { LoadedTenant } from "./tenants.js";

function tenant(
  name: string,
  promotionMode: LoadedTenant["spec"]["promotionMode"] = "review-only",
): LoadedTenant {
  return {
    dir: `/tmp/${name}`,
    manifest: {} as never,
    prompt: "analyze",
    spec: {
      tenant: name,
      enabled: true,
      team: "team.yaml",
      promotionMode,
      triggers: [{ kind: "cron", schedule: "0 0 * * *", timezone: "UTC" }],
      delivery: { jsonl: true },
      extensions: {},
    },
  };
}

const alpha = tenant("alpha");
const otherTenant = tenant("other");
const event: TenantTriggerEvent = {
  tenant: "alpha",
  kind: "cron",
  firedAt: "2026-08-30T00:00:00.000Z",
  dedupKey: "alpha:one",
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
  it("refuses a tenant outside the canary allow-list", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input: { caseId: string }) =>
      projection(input.caseId),
    );
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await adapter.handle(otherTenant, event, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("takes the MORE RESTRICTIVE of the host brake and the tenant request", async () => {
    expect(narrower("review-only", "delivered")).toBe("review-only");
    expect(narrower("delivered", "review-only")).toBe("review-only");
    expect(narrower("off", "delivered")).toBe("off");
    expect(narrower("shadow", "shadow")).toBe("shadow");
    expect(narrower("delivered", "delivered")).toBe("delivered");

    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input: { caseId: string }) =>
      projection(input.caseId),
    );
    const adapter = new TeamPromotionAdapter({
      mode: "off",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });
    // The tenant asks for `delivered`; the host brake says `off`. Nothing runs.
    await adapter.handle(tenant("alpha", "delivered"), event, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces the daily canary bound across adapter restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input: { caseId: string }) =>
      projection(input.caseId),
    );
    const build = () => new TeamPromotionAdapter({
      mode: "review-only",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await build().handle(alpha, event, run);
    await build().handle(alpha, { ...event, dedupKey: "alpha:two" }, run);
    expect(run).toHaveBeenCalledOnce();
    const skippedDay = join(root, "team-canary", "skipped", "2026-08-30");
    expect(readdirSync(skippedDay)).toHaveLength(1);
  });

  it("writes a complete pending-review surface and never auto-approves", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({
        version: "providers-1",
        domains: [{ quotaDomain: "codex", targets: ["opaque-1"], availability: { state: "available" } }],
      }),
    });

    await adapter.handle(alpha, event, async (input) =>
      projection(input.caseId),
    );
    const pending = new TeamReviewStore(root, now).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "pending",
      job: "alpha",
      team: {
        state: "completed",
        tasks: { completed: 1 },
        artifacts: [{ ref: "artifact://report/one", hash: `sha256:${"a".repeat(64)}` }],
      },
      providerHealth: { version: "providers-1" },
    });
  });

  it("runs an operator-requested review-only case", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input: { caseId: string }) =>
      projection(input.caseId),
    );
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });

    await adapter.handleCanary(alpha, {
      version: 1,
      requestId: `canary-${"a".repeat(24)}`,
      caseKey: "weekend-smoke-1",
      tenant: "alpha",
      requestedBy: "weekend-operator",
      reason: "prove the review-only path",
      createdAt: "2026-08-30T00:55:00.000Z",
      expiresAt: "2026-08-30T02:00:00.000Z",
    }, run);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      caseId: expect.stringMatching(/^canary-/),
      subject: "alpha:controlled-canary",
    });
    expect(new TeamReviewStore(root, now).pending()).toHaveLength(1);
  });

  it("retries one logical canary in a fresh execution without spending a second daily slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const run = vi.fn(async (input: { caseId: string }) =>
      run.mock.calls.length === 1
        ? { ...projection(input.caseId), state: "failed" as const }
        : projection(input.caseId));
    const adapter = new TeamPromotionAdapter({
      mode: "review-only",
      canaryTenants: ["alpha"],
      maxPerUtcDay: 1,
      stateRoot: root,
      now,
      providerHealth: () => ({ version: "providers-1", domains: [] }),
    });
    const request = {
      version: 1 as const,
      requestId: `canary-${"b".repeat(24)}`,
      caseKey: "weekend-smoke-retry",
      tenant: "alpha",
      requestedBy: "weekend-operator",
      reason: "retry one infrastructure case",
      createdAt: "2026-08-30T00:55:00.000Z",
      expiresAt: "2026-08-30T02:00:00.000Z",
    };

    await expect(adapter.handleCanary(alpha, request, run)).rejects.toThrow(
      /did not complete/,
    );
    await adapter.handleCanary(alpha, {
      ...request,
      requestId: `canary-${"c".repeat(24)}`,
    }, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0].caseId).not.toBe(run.mock.calls[1]?.[0].caseId);

    await expect(adapter.handleCanary(alpha, {
      ...request,
      requestId: `canary-${"d".repeat(24)}`,
      caseKey: "a-different-daily-case",
    }, run)).rejects.toThrow(/daily cap exhausted/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("accepts one attributable human decision for a pending review", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-promotion-"));
    const reviews = new TeamReviewStore(root, now);
    const item = reviews.enqueue({
      job: "alpha",
      dedupKey: "alpha:one",
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
