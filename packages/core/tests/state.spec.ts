import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

function makeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), "helium-state-")), "state");
}

describe("StateStore", () => {
  it("returns an empty state for an unknown job", () => {
    expect(new StateStore(makeRoot()).loadSensor("macro-watch")).toEqual({
      dedup: {},
      triageFires: [],
      seniorFires: [],
    });
  });

  it("round-trips a saved state", () => {
    const store = new StateStore(makeRoot());
    const state = {
      baseline: {
        hash: "abc123def456",
        fields: { direction: "up", confidence: 0.7 },
      },
      dedup: { "regime:up": "2026-08-24T00:00:00.000Z" },
      triageFires: ["2026-08-23T10:00:00.000Z"],
      seniorFires: [],
    };
    store.saveSensor("macro-watch", state);
    expect(store.loadSensor("macro-watch")).toEqual(state);
  });

  it("leaves no temp file behind (write is tmp + rename)", () => {
    const root = makeRoot();
    const store = new StateStore(root);
    store.saveSensor("macro-watch", {
      dedup: {},
      triageFires: [],
      seniorFires: [],
    });
    expect(readdirSync(join(root, "sensors"))).toEqual(["macro-watch.json"]);
    expect(
      JSON.parse(
        readFileSync(join(root, "sensors", "macro-watch.json"), "utf8"),
      ).dedup,
    ).toEqual({});
  });

  it("refuses a job name that would escape the sensors directory", () => {
    const store = new StateStore(makeRoot());
    expect(() => store.loadSensor("../escape")).toThrow(/invalid job name/);
  });
});
