import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, type TriggerStateChange } from "@helium/core";
import {
  extractFields,
  hashFields,
  StateChangePoller,
  type TriggerEvent,
} from "./sensor.js";
import { json, startFixture, type Fixture } from "./testing/http-fixture.js";

describe("extractFields", () => {
  it("resolves dot-paths, array indices and missing paths", () => {
    const body = {
      regime: { state: "tightening", confidence: 0.72 },
      direction: "up",
      legs: [{ tenor: "2y" }, { tenor: "10y" }],
    };
    expect(
      extractFields(body, ["regime.state", "legs.1.tenor", "missing.path"]),
    ).toEqual({
      "regime.state": "tightening",
      "legs.1.tenor": "10y",
      "missing.path": null,
    });
  });

  it("returns null for every path when the body is not an object", () => {
    expect(extractFields("boom", ["a.b"])).toEqual({ "a.b": null });
  });
});

describe("hashFields", () => {
  it("is a 12-char hex digest independent of key insertion order", () => {
    const a = hashFields({ "regime.state": "tightening", direction: "up" });
    const b = hashFields({ direction: "up", "regime.state": "tightening" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when any watched value changes", () => {
    expect(hashFields({ a: 1 })).not.toBe(hashFields({ a: 2 }));
  });
});

const trigger = (url: string): TriggerStateChange => ({
  kind: "state-change",
  url,
  fields: ["regime.state"],
  intervalMs: 30_000,
  dedupTtlMs: 600_000,
});

describe("StateChangePoller", () => {
  let fixture: Fixture;
  let store: StateStore;
  let payload: unknown;
  let fired: TriggerEvent[];
  let clock: number;

  beforeEach(async () => {
    payload = { regime: { state: "tightening" } };
    fired = [];
    clock = Date.parse("2026-08-23T12:00:00.000Z");
    store = new StateStore(mkdtempSync(join(tmpdir(), "helium-state-")));
    fixture = await startFixture((_req, res) => json(res, payload));
  });
  afterEach(async () => {
    await fixture.close();
  });

  const poller = () =>
    new StateChangePoller({
      job: "macro-watch",
      trigger: trigger(`${fixture.url}/api/rates/snapshot`),
      store,
      onTrigger: (ev) => {
        fired.push(ev);
      },
      now: () => new Date(clock),
    });

  it("establishes a baseline on cold start and never fires", async () => {
    const status = await poller().tick();
    expect(status.state).toBe("baseline");
    expect(fired).toHaveLength(0);
    expect(store.loadSensor("macro-watch").baseline?.hash).toBe(status.hash);
  });

  it("does not fire when the watched fields are unchanged", async () => {
    const p = poller();
    await p.tick();
    expect((await p.tick()).state).toBe("unchanged");
    expect(fired).toHaveLength(0);
  });

  it("fires once with previous and current on a real change", async () => {
    const p = poller();
    await p.tick();
    payload = { regime: { state: "easing" } };
    const status = await p.tick();
    expect(status.state).toBe("changed");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.kind).toBe("state-change");
    expect(fired[0]?.firedAt).toMatch(/Z$/);
    expect(fired[0]?.payload).toMatchObject({
      previous: { "regime.state": "tightening" },
      current: { "regime.state": "easing" },
    });
    expect(
      store.loadSensor("macro-watch").dedup[fired[0]!.dedupKey],
    ).toBeDefined();
  });

  it("suppresses a repeat of the same hash inside the TTL and re-fires after it", async () => {
    const p = poller();
    await p.tick();
    payload = { regime: { state: "easing" } };
    await p.tick();
    payload = { regime: { state: "tightening" } };
    await p.tick();
    payload = { regime: { state: "easing" } };
    expect((await p.tick()).state).toBe("deduped");
    expect(fired).toHaveLength(2);

    clock += 700_000; // past dedupTtlMs
    payload = { regime: { state: "tightening" } };
    await p.tick();
    payload = { regime: { state: "easing" } };
    expect((await p.tick()).state).toBe("changed");
    expect(fired).toHaveLength(4);
  });

  it("reports unknown and leaves state untouched when the endpoint fails", async () => {
    const p = poller();
    await p.tick();
    const before = JSON.stringify(store.loadSensor("macro-watch"));
    const dead = new StateChangePoller({
      job: "macro-watch",
      trigger: trigger("http://127.0.0.1:1/api/rates/snapshot"),
      store,
      onTrigger: (ev) => {
        fired.push(ev);
      },
      now: () => new Date(clock),
    });
    const status = await dead.tick();
    expect(status.state).toBe("unknown");
    expect(status.error).toBeTruthy();
    expect(fired).toHaveLength(0);
    expect(JSON.stringify(store.loadSensor("macro-watch"))).toBe(before);
  });
});
