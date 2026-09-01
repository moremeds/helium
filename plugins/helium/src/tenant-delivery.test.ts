import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlWriter } from "@helium/core";
import { Delivery } from "./delivery.js";
import { TenantDelivery, type TenantDeliveryPort } from "./tenant-delivery.js";
import type { TenantDescriptor } from "./tenants.js";

/**
 * The production shape: the projection still says "running" because the port
 * fires immediately BEFORE the terminal append. A fixture whose projection
 * already says "completed" hides exactly the bug the outcome argument exists
 * to prevent.
 */
function projection(overrides: Record<string, unknown> = {}) {
  return {
    teamRunId: "t1",
    caseId: "c1",
    state: "running",
    tasks: {},
    artifacts: {},
    ...overrides,
  } as never;
}

function deliverInput(events: string[]) {
  return {
    teamRunId: "t1",
    team: projection(),
    outcome: "completed" as const,
    artifacts: {},
    recordIntent: (refs: string[]) => {
      events.push(`intent:${refs.join(",")}`);
      return "d1";
    },
    recordOutcome: (id: string, outcome: string) => {
      events.push(`outcome:${id}:${outcome}`);
    },
  };
}

function harness(enabled: boolean, sendMail?: () => Promise<void>) {
  const stateRoot = mkdtempSync(join(tmpdir(), "helium-tenant-delivery-"));
  const jsonlDir = join(stateRoot, "jsonl");
  const delivery = new Delivery({
    jsonl: new JsonlWriter(jsonlDir),
    jsonlDir,
    reportsDir: join(stateRoot, "reports"),
    emailTo: "operator@example.invalid",
    smtp: sendMail
      ? {
          host: "smtp.example.invalid",
          port: 587,
          secure: false,
          from: "helium@example.invalid",
        }
      : null,
    ...(sendMail
      ? { transport: { sendMail: async () => await sendMail() } as never }
      : {}),
    sleep: async () => undefined,
  });
  const port = new TenantDelivery({
    tenant: "alpha",
    policy: {
      jsonl: true,
      email: { to: "operator", subjectPrefix: "[helium/alpha]", maxPerDay: 2 },
    },
    delivery,
    enabled,
  });
  const events: string[] = [];
  const call = async (): Promise<void> =>
    await port.deliver(deliverInput(events));
  const rows = (): Record<string, unknown>[] =>
    readdirSync(jsonlDir)
      .filter((name) => name.startsWith("deliveries-"))
      .flatMap((name) =>
        readFileSync(join(jsonlDir, name), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
  return { call, events, rows };
}

/** A `Delivery` stand-in that records what it was asked to send. */
function fakeDelivery(
  sent: { subject: string; body: string }[],
  state = "sent",
): Delivery {
  return {
    deliver: async (input: { subject: string; body: string }) => {
      sent.push({ subject: input.subject, body: input.body });
      return { state, deliveryId: "d1" };
    },
  } as unknown as Delivery;
}

describe("TenantDelivery", () => {
  it("records the delivery intent before any outcome", async () => {
    let sent = 0;
    const h = harness(true, async () => {
      sent += 1;
    });
    await h.call();
    expect(h.events[0]).toMatch(/^intent:/);
    expect(h.events[1]).toBe("outcome:d1:delivered");
    expect(sent).toBe(1);
  });

  it("records a failed outcome when SMTP never accepts", async () => {
    const h = harness(true, async () => {
      throw new Error("connection refused");
    });
    await h.call();
    expect(h.events[0]).toMatch(/^intent:/);
    expect(h.events[1]).toBe("outcome:d1:failed");
  });

  it("writes the JSONL intent row before the outcome row", async () => {
    const h = harness(true, async () => undefined);
    await h.call();
    const kinds = h.rows().map((row) => row.kind);
    expect(kinds.indexOf("delivery-intent")).toBeLessThan(
      kinds.indexOf("delivery-outcome"),
    );
  });

  it("sends nothing without the HELIUM_TENANT_DELIVERY opt-in", async () => {
    let sent = 0;
    const h = harness(false, async () => {
      sent += 1;
    });
    await h.call();
    expect(sent).toBe(0);
    expect(h.events).toEqual([]);
  });

  it("cites the run itself when the team produced no artifact", async () => {
    const h = harness(true, async () => undefined);
    await h.call();
    expect(h.events[0]).toBe("intent:artifact://team-run/t1");
  });
});

describe("TenantDelivery render override", () => {
  it("uses the tenant descriptor's renderEmail instead of the generic renderer", async () => {
    const sent: { subject: string; body: string }[] = [];
    const events: string[] = [];
    const port = new TenantDelivery({
      tenant: "alpha",
      policy: { jsonl: true },
      delivery: fakeDelivery(sent),
      enabled: true,
      renderEmail: () => ({
        subject: "alpha book review completed",
        text: "rendered by the tenant",
      }),
    });
    await port.deliver(deliverInput(events));
    expect(sent[0]!.subject).toBe("alpha book review completed");
    expect(sent[0]!.body).toBe("rendered by the tenant");
  });

  it("falls back to renderTeamEmail when the tenant ships no renderer", async () => {
    const sent: { subject: string; body: string }[] = [];
    const events: string[] = [];
    const port = new TenantDelivery({
      tenant: "alpha",
      policy: { jsonl: true },
      delivery: fakeDelivery(sent),
      enabled: true,
    });
    await port.deliver(deliverInput(events));
    expect(sent[0]!.body).toContain("Tasks:");
    // The terminal outcome comes from the controller, NOT from team.state,
    // which still reads "running" at this point.
    expect(sent[0]!.body).toContain("state: completed");
    expect(sent[0]!.subject).toBe("[helium/alpha] completed");
  });
});

describe("TenantDelivery outcome mapping", () => {
  // Six real delivery states, three outcomes. Only a state that actually sent
  // mail is `delivered`; folding `skipped`/`rate-capped` into `delivered` is
  // how a run that sent nothing came to look successful AND suppressed the
  // human-review fallback.
  it.each([
    ["sent", "delivered"],
    ["failed", "failed"],
    ["skipped", "uncertain"],
    ["rate-capped", "uncertain"],
    ["pending", "uncertain"],
  ])("maps delivery state %s to team outcome %s", async (state, expected) => {
    const events: string[] = [];
    const port = new TenantDelivery({
      tenant: "alpha",
      policy: { jsonl: true },
      delivery: fakeDelivery([], state),
      enabled: true,
    });
    await port.deliver(deliverInput(events));
    expect(events[1]).toBe(`outcome:d1:${expected}`);
  });
});

describe("TenantDelivery artifact bodies", () => {
  it("passes the controller-supplied artifact bodies straight to renderEmail", async () => {
    // The BODIES are read by the controller, from the store that case owns —
    // `TeamController` opens one store per caseId, so a store held by the port
    // would belong to whichever run happened to be first. The port only
    // forwards. `team-controller.test.ts` proves the read end.
    const renderEmail = vi.fn(
      (_input: unknown) => ({ subject: "s", text: "t" }),
    );
    const port = new TenantDelivery({
      tenant: "alpha",
      policy: { jsonl: true },
      delivery: fakeDelivery([]),
      enabled: true,
      renderEmail: renderEmail as unknown as TenantDescriptor["renderEmail"],
    });
    const events: string[] = [];
    const artifacts = {
      "artifact://report/one": {
        taskId: "render",
        ref: "artifact://report/one",
        hash: `sha256:${createHash("sha256").update("FIRST BODY").digest("hex")}`,
        publishedAt: new Date().toISOString(),
        content: "FIRST BODY",
      },
    };
    await port.deliver({ ...deliverInput(events), artifacts } as never);
    const seen = renderEmail.mock.calls[0]![0] as Parameters<
      NonNullable<TenantDescriptor["renderEmail"]>
    >[0];
    expect(seen.artifacts["artifact://report/one"]!.content).toBe("FIRST BODY");
  });
});

/** Type-level: the class must satisfy the port the controller depends on. */
const _port: TenantDeliveryPort = new TenantDelivery({
  tenant: "alpha",
  policy: { jsonl: true },
  delivery: fakeDelivery([]),
  enabled: false,
});
void _port;
