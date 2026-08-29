import { describe, expect, it } from "vitest";
import type { Incident } from "@helium/core";
import {
  AlertManager,
  type AlertDelivery,
  type AlertMessage,
} from "./alerts.js";

const incident = (over: Partial<Incident> = {}): Incident => ({
  key: "host|capacity|degraded|host",
  rootComponentId: "host",
  symptomComponentIds: ["apex", "argon"],
  dimension: "capacity",
  failureClass: "degraded",
  state: "open",
  observationIds: ["obs-host-memory-1"],
  openedAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

function delivery(fail = false): AlertDelivery & { messages: AlertMessage[] } {
  const messages: AlertMessage[] = [];
  return {
    messages,
    async deliver(message) {
      messages.push(message);
      if (fail) throw new Error("channel unavailable");
    },
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  incident: incident(),
  severity: "warning" as const,
  impact: "optional work is paused",
  inhibitedSymptoms: ["argon", "apex"],
  nextDecision: "wait for sustained recovery",
  ...over,
});

describe("AlertManager", () => {
  it("waits for the sustained for-window before raising an alert", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 300_000 });

    expect(await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"))).toEqual({ emitted: false });
    expect(await alerts.evaluate(input(), new Date("2026-08-29T12:04:59.999Z"))).toEqual({ emitted: false });
    expect(await alerts.evaluate(input(), new Date("2026-08-29T12:05:00.000Z"))).toEqual({ emitted: true });
    expect(channel.messages).toHaveLength(1);
  });

  it("deduplicates and never periodically restates an unchanged incident", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 0 });
    await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    await alerts.evaluate(input(), new Date("2026-08-29T13:00:00.000Z"));
    await alerts.evaluate(input(), new Date("2026-08-30T12:00:00.000Z"));
    expect(channel.messages).toHaveLength(1);
  });

  it("groups by incident root and lists inhibited symptoms", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 0 });
    await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    expect(channel.messages[0]).toMatchObject({
      dedupeKey: "host|capacity|degraded|host",
      rootComponentId: "host",
      inhibitedSymptoms: ["apex", "argon"],
    });
    expect(channel.messages[0]?.summary).toContain("root=host");
    expect(channel.messages[0]?.summary).toContain("inhibited=apex,argon");
  });

  it("emits one recovery transition with truthful attribution", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 0 });
    await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    await alerts.evaluate(
      input({
        incident: incident({ state: "recovered" }),
        actionAttribution: "operator",
        verification: "postconditions-passed",
      }),
      new Date("2026-08-29T12:10:00.000Z"),
    );
    await alerts.evaluate(
      input({ incident: incident({ state: "recovered" }), actionAttribution: "operator" }),
      new Date("2026-08-29T12:20:00.000Z"),
    );

    expect(channel.messages.map((message) => message.transition)).toEqual(["raised", "recovered"]);
    expect(channel.messages[1]).toMatchObject({ actionAttribution: "operator" });
  });

  it("alerts again when the same stable incident key recurs after recovery", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 0 });
    await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    await alerts.evaluate(
      input({ incident: incident({ state: "recovered" }) }),
      new Date("2026-08-29T12:10:00.000Z"),
    );
    await alerts.evaluate(input(), new Date("2026-08-29T13:00:00.000Z"));

    expect(channel.messages.map((message) => message.transition)).toEqual([
      "raised",
      "recovered",
      "raised",
    ]);
  });

  it("starts a fresh for-window when an unalerted episode recovers and later recurs", async () => {
    const channel = delivery();
    const alerts = new AlertManager({ delivery: channel, forMs: 300_000 });
    await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    await alerts.evaluate(
      input({ incident: incident({ state: "recovered" }) }),
      new Date("2026-08-29T12:01:00.000Z"),
    );
    await alerts.evaluate(input(), new Date("2026-08-29T13:00:00.000Z"));

    expect(
      await alerts.evaluate(input(), new Date("2026-08-29T13:04:59.999Z")),
    ).toEqual({ emitted: false });
    expect(
      await alerts.evaluate(input(), new Date("2026-08-29T13:05:00.000Z")),
    ).toEqual({ emitted: true });
    expect(channel.messages).toHaveLength(1);
  });

  it("turns channel failure into one delivery incident and does not restate or trigger recovery", async () => {
    const channel = delivery(true);
    const alerts = new AlertManager({ delivery: channel, forMs: 0 });

    const first = await alerts.evaluate(input(), new Date("2026-08-29T12:00:00.000Z"));
    const second = await alerts.evaluate(input(), new Date("2026-08-29T13:00:00.000Z"));

    expect(first).toMatchObject({
      emitted: false,
      deliveryIncident: { state: "open", failureClass: "failed" },
      recoveryActionRequested: false,
    });
    expect(second).toEqual({ emitted: false });
    expect(channel.messages).toHaveLength(1);
  });
});
