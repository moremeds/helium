import { describe, expect, it } from "vitest";
import type { ShepherdEvent } from "./events.js";
import { reduceShepherd } from "./reducer.js";
import { CoverageLedger } from "./coverage-ledger.js";
import { createWorkUnit } from "./work-unit.js";

const at = "2026-08-31T01:00:00.000Z";
const evidence = { ref: "artifact://probe/coverage", hash: `sha256:${"a".repeat(64)}` };

function unit(date: string) {
  return createWorkUnit({
    kind: "market-partition",
    provider: "massive",
    assetClass: "equity",
    marketDate: date,
    timeframe: "1m",
    layer: "bronze",
  });
}

describe("CoverageLedger", () => {
  it("uses only an explicit scope manifest for denominators", () => {
    const verified = unit("2026-08-28");
    const missing = unit("2026-08-29");
    const events: ShepherdEvent[] = [
      { version: 1, eventId: "d1", at, type: "work-unit/discovered", payload: { unit: verified } },
      { version: 1, eventId: "d2", at, type: "work-unit/discovered", payload: { unit: missing } },
      {
        version: 1,
        eventId: "coverage-1",
        at,
        type: "coverage/recorded",
        payload: {
          workUnitId: verified.workUnitId,
          expectedRevision: 0,
          revision: 1,
          dimension: "bars",
          state: "verified",
          evidence: [evidence],
        },
      },
    ];
    const report = new CoverageLedger(reduceShepherd(events)).summarize({
      scopeId: "current-members-1m",
      workUnitIds: [verified.workUnitId, missing.workUnitId],
      dimensions: ["bars"],
    });
    expect(report.dimensions.bars).toMatchObject({ numerator: 1, denominator: 2 });
    expect(report.dimensions.bars?.states).toEqual({ missing: 1, verified: 1 });
  });

  it("does not infer verified from data existence or a later dimension", () => {
    const work = unit("2026-08-28");
    const projection = reduceShepherd([
      { version: 1, eventId: "d1", at, type: "work-unit/discovered", payload: { unit: work } },
      {
        version: 1,
        eventId: "coverage-1",
        at,
        type: "coverage/recorded",
        payload: {
          workUnitId: work.workUnitId,
          expectedRevision: 0,
          revision: 1,
          dimension: "duckdb-parity",
          state: "verified",
          evidence: [evidence],
        },
      },
    ] satisfies ShepherdEvent[]);
    const report = new CoverageLedger(projection).summarize({
      scopeId: "one",
      workUnitIds: [work.workUnitId],
      dimensions: ["bars", "duckdb-parity"],
    });
    expect(report.dimensions.bars).toMatchObject({ numerator: 0, states: { missing: 1 } });
    expect(report.dimensions["duckdb-parity"]).toMatchObject({ numerator: 1, states: { verified: 1 } });
  });

  it("rejects a denominator containing an unknown or duplicate work unit", () => {
    const work = unit("2026-08-28");
    const ledger = new CoverageLedger(reduceShepherd([
      { version: 1, eventId: "d1", at, type: "work-unit/discovered", payload: { unit: work } },
    ]));
    expect(() => ledger.summarize({ scopeId: "bad", workUnitIds: [work.workUnitId, work.workUnitId], dimensions: ["bars"] }))
      .toThrow(/duplicate/i);
    expect(() => ledger.summarize({ scopeId: "bad", workUnitIds: ["lws-missing"], dimensions: ["bars"] }))
      .toThrow(/unknown/i);
  });
});
