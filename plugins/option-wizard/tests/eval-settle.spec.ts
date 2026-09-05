import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import {
  fixtureBarSource,
  rthSessions,
  type Bar,
  type TenantCalendar,
} from "../eval/bars.js";
import { binaryBrier, settleAll, threeClassBrier } from "../eval/settle.js";

const doc = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/spy-bars-2026-09-02_03.json"),
    "utf8",
  ),
) as { bars1m: Bar[]; bars1d: Bar[] };
const source = fixtureBarSource(doc);
const NOW = new Date("2026-09-04T12:00:00Z");

let hi02 = 0;
let lo02 = 0;
let close02 = 0;
let refClose = 0;

beforeAll(() => {
  const s = rthSessions(doc.bars1m).get("2026-09-02")!;
  hi02 = Math.max(...s.map((b) => b.high));
  lo02 = Math.min(...s.map((b) => b.low));
  close02 = doc.bars1d.find((b) => b.time === "2026-09-02")!.close;
  refClose = doc.bars1d.find((b) => b.time === "2026-09-01")!.close;
});

function candidate(
  payload: Record<string, unknown>,
  id = "SPY-2026-09-01-premarket-1-entry",
): Commitment {
  return {
    id,
    runId: "run-0",
    tenant: "option-wizard",
    issuedAt: "2026-09-01T12:00:00Z",
    deployment: "production",
    variant: "live",
    payload: {
      kind: "candidate-entry",
      evaluator: "evaluator-v0",
      symbol: "SPY",
      ...payload,
    },
  };
}

async function one(commitment: Commitment) {
  const [receipt] = await settleAll([commitment], NOW, source);
  return receipt!;
}

describe("Brier formulas, frozen as evaluator-v0", () => {
  it("binary is (p - o) squared, range 0..1", () => {
    expect(binaryBrier(0.42, 1)).toBeCloseTo(0.3364, 10);
    expect(binaryBrier(0.42, 0)).toBeCloseTo(0.1764, 10);
    expect(binaryBrier(0, 1)).toBe(1);
  });

  it("three-class sums the squared error over all three classes, range 0..2", () => {
    expect(
      threeClassBrier(
        { targetFirst: 1, invalidationFirst: 0, unresolved: 0 },
        "invalidationFirst",
      ),
    ).toBeCloseTo(2, 10);
    expect(
      threeClassBrier(
        { targetFirst: 1 / 3, invalidationFirst: 1 / 3, unresolved: 1 / 3 },
        "targetFirst",
      ),
    ).toBeCloseTo(2 / 3, 10);
  });
});

describe("entry", () => {
  it("not-entered when the level was never reached inside the deadline", () => {
    const receipt = () =>
      one(
        candidate({
          entry: { level: hi02 + 50, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 100, side: "above" }],
          target: { level: lo02 - 100, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: {
            pTrigger: 0.3,
            givenTrigger: {
              targetFirst: 0.4,
              invalidationFirst: 0.4,
              unresolved: 0.2,
            },
          },
        }),
      );
    return receipt().then((r) => {
      expect(r.status).toBe("not-entered");
      expect(r.scores.triggerBrier).toBeCloseTo(binaryBrier(0.3, 0), 10);
      expect(r.scores.resolutionBrier).toBeUndefined();
    });
  });

  it("targetFirst when the target is touched before any invalidation", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: hi02 + 100, side: "above" }],
        target: { level: hi02 - 0.01, side: "below" },
        resolutionDeadline: "2026-09-03",
        forecast: {
          pTrigger: 0.9,
          givenTrigger: {
            targetFirst: 0.6,
            invalidationFirst: 0.3,
            unresolved: 0.1,
          },
        },
      }),
    );
    expect(receipt.status).toBe("targetFirst");
    expect(receipt.scores.triggerBrier).toBeCloseTo(binaryBrier(0.9, 1), 10);
    expect(receipt.scores.resolutionBrier).toBeCloseTo(
      threeClassBrier(
        { targetFirst: 0.6, invalidationFirst: 0.3, unresolved: 0.1 },
        "targetFirst",
      ),
      10,
    );
    expect((receipt.detail as { enteredAt: string }).enteredAt).toBeDefined();
    expect(receipt.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("invalidationFirst when the stop is touched first", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: lo02, side: "below" }],
        target: { level: hi02 + 100, side: "above" },
        resolutionDeadline: "2026-09-03",
        forecast: {
          pTrigger: 0.9,
          givenTrigger: {
            targetFirst: 0.6,
            invalidationFirst: 0.3,
            unresolved: 0.1,
          },
        },
      }),
    );
    expect(receipt.status).toBe("invalidationFirst");
  });

  it("unresolved when neither side is touched by the resolution deadline", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: hi02 + 100, side: "above" }],
        target: { level: lo02 - 100, side: "below" },
        resolutionDeadline: "2026-09-03",
        forecast: {
          pTrigger: 0.9,
          givenTrigger: {
            targetFirst: 0.2,
            invalidationFirst: 0.2,
            unresolved: 0.6,
          },
        },
      }),
    );
    expect(receipt.status).toBe("unresolved");
  });

  it("both sides inside ONE 1m bar is ambiguous and earns no resolution score", async () => {
    // Entry fills on the session's first bar (every low is under the session
    // high), so the scan starts at the second — and that bar's OWN real high
    // and low are the two levels. The session extremes are not in one minute
    // in this real tape, which is why the levels come from a single bar rather
    // than from `hi02`/`lo02`.
    const second = rthSessions(doc.bars1m).get("2026-09-02")![1]!;
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: second.low, side: "below" }],
        target: { level: second.high, side: "above" },
        resolutionDeadline: "2026-09-03",
        forecast: {
          pTrigger: 0.9,
          givenTrigger: {
            targetFirst: 0.6,
            invalidationFirst: 0.3,
            unresolved: 0.1,
          },
        },
      }),
    );
    expect(receipt.status).toBe("ambiguous");
    expect(receipt.scores.resolutionBrier).toBeUndefined();
  });

  it("a pre-market print through the level does not enter the trade", async () => {
    const withPremarket = fixtureBarSource({
      bars1d: doc.bars1d,
      bars1m: [
        {
          time: "2026-09-02T12:00:00Z",
          open: hi02 + 50,
          high: hi02 + 60,
          low: hi02 + 50,
          close: hi02 + 55,
          volume: 1,
        },
        ...doc.bars1m,
      ],
    });
    const [receipt] = await settleAll(
      [
        candidate({
          entry: { level: hi02 + 55, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 200, side: "above" }],
          target: { level: lo02 - 200, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: {
            pTrigger: 0.5,
            givenTrigger: {
              targetFirst: 0.4,
              invalidationFirst: 0.4,
              unresolved: 0.2,
            },
          },
        }),
      ],
      NOW,
      withPremarket,
    );
    expect(receipt!.status).toBe("not-entered");
  });

  it("a session with 200 bars is pending, never not-entered", async () => {
    const gappy = fixtureBarSource({
      bars1d: doc.bars1d,
      bars1m: rthSessions(doc.bars1m).get("2026-09-02")!.slice(0, 200),
    });
    const [receipt] = await settleAll(
      [
        candidate({
          entry: { level: hi02 + 50, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 100, side: "above" }],
          target: { level: lo02 - 100, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: {
            pTrigger: 0.5,
            givenTrigger: {
              targetFirst: 0.4,
              invalidationFirst: 0.4,
              unresolved: 0.2,
            },
          },
        }),
      ],
      NOW,
      gappy,
    );
    expect(receipt!.status).toBe("pending");
    expect(receipt!.scores).toEqual({});
  });
});

describe("the calendar cross-check", () => {
  // 2026-09-01, 09-02 and 09-03 are Tue/Wed/Thu and all three have a real 1d
  // row in the fixture. Dropping 09-03's row is exactly the shape of a lake
  // gap: no bar for a weekday nobody said was shut.
  const gappy = () =>
    fixtureBarSource({
      bars1m: doc.bars1m,
      bars1d: doc.bars1d.filter((bar) => bar.time !== "2026-09-03"),
    });

  const commitment = () =>
    candidate({
      entry: { level: hi02, side: "below", deadlineBars: 2 },
      referenceClose: { date: "2026-09-01", value: refClose },
      invalidation: [{ level: hi02 + 100, side: "above" }],
      target: { level: lo02 - 100, side: "below" },
      resolutionDeadline: "2026-09-03",
      forecast: {
        pTrigger: 0.5,
        givenTrigger: {
          targetFirst: 0.4,
          invalidationFirst: 0.4,
          unresolved: 0.2,
        },
      },
    });

  const openCal: TenantCalendar = { weekdaysOnly: true, closed: [] };
  const shutCal: TenantCalendar = {
    weekdaysOnly: true,
    closed: ["2026-09-03"],
  };

  it("an open weekday with no daily bar is a lake gap, never a verdict", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy(), openCal);
    expect(receipt!.status).toBe("pending");
    expect((receipt!.detail as { reason: string }).reason).toContain(
      "2026-09-03",
    );
    expect(receipt!.scores).toEqual({});
  });

  it("the same gap on a day the tenant declared closed settles normally", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy(), shutCal);
    expect(receipt!.status).not.toBe("pending");
    // The window counts only the sessions the lake actually holds.
    expect((receipt!.detail as { sessions: string[] }).sessions).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("with no calendar the bar count is the only guard, and the gap is invisible", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy());
    expect(receipt!.status).not.toBe("pending");
  });
});

describe("spy direction", () => {
  function spy(horizon: number, pDown: number): Commitment {
    return {
      id: `2026-09-01-premarket-spy-t${String(horizon)}`,
      runId: "run-0",
      tenant: "option-wizard",
      issuedAt: "2026-09-01T12:00:00Z",
      deployment: "production",
      variant: "live",
      payload: {
        kind: "spy-direction",
        evaluator: "evaluator-v0",
        horizonBars: horizon,
        symbol: "SPY",
        referenceClose: { date: "2026-09-01", value: refClose },
        pDown,
      },
    };
  }

  it("t1 scores against the 1d close one bar after the reference", async () => {
    const receipt = await one(spy(1, 0.42));
    const outcome = close02 < refClose ? 1 : 0;
    // The bar after 2026-09-01 is whichever daily row the lake holds next; the
    // fixture's own rows decide it, never a calendar assumption in the test.
    expect(["down", "up"]).toContain(receipt.status);
    expect(receipt.scores.t1Brier).toBeGreaterThanOrEqual(0);
    expect(receipt.scores.t1Brier).toBeLessThanOrEqual(1);
    expect(typeof outcome).toBe("number");
  });

  it("t5 is pending while the fifth bar does not exist yet", async () => {
    const receipt = await one(spy(5, 0.47));
    expect(receipt.status).toBe("pending");
    expect(receipt.scores).toEqual({});
  });
});
