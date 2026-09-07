/**
 * The focus settler, and the guard split.
 *
 * Real closes only: SPY 773.17 on 2026-09-03 and 770.19 on 2026-09-04
 * (`tests/fixtures/review/closes-2026-09-03-04.json`, recorded from the
 * option-wizard close reports of those days), a −0.3854% two-session move. The
 * 60-session realized threshold reads SPY's daily closes out of
 * `tests/fixtures/review/rotation-closes-2026-08-28.json`, recorded live from
 * apex on 2026-09-06.
 */
import { describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import type { Bar, BarSource } from "../eval/bars.js";
import { buildSettler, settleAll } from "../eval/settle.js";
import { realizedThreshold, settleFocus } from "../eval/verdict.js";
import closes from "./fixtures/review/closes-2026-09-03-04.json" with { type: "json" };
import rotation from "./fixtures/review/rotation-closes-2026-08-28.json" with { type: "json" };

const NOW = new Date("2026-09-08T20:30:00Z");

function barsFrom(map: Record<string, number>): Bar[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, close]) => ({
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    }));
}

const SPY_TWO_DAY = barsFrom(closes.closes.SPY);
const SPY_SERIES = barsFrom(rotation.closes.SPY);

function source(bars: Bar[]): BarSource {
  return {
    async bars1m() {
      return [];
    },
    async bars1d(_symbol, from, to) {
      return bars.filter((bar) => bar.time >= from && bar.time <= to);
    },
  };
}

function admit(
  over: { pct?: number; toDay?: string; fromDay?: string; p?: number } = {},
): Commitment {
  return {
    id: "2026-09-03-close-focus-SPY",
    runId: "run-0",
    tenant: "option-wizard",
    issuedAt: "2026-09-03T20:30:00Z",
    deployment: "test",
    variant: "test",
    payload: {
      kind: "focus-admit",
      evaluator: "focus-v0",
      ticker: "SPY",
      admittedFor: {
        kind: "macroNamed",
        day: "2026-09-04",
        session: "pre",
        source: "ow_uw_calendar",
        label: "NFP",
      },
      window: {
        fromDay: over.fromDay ?? "2026-09-03",
        toDay: over.toDay ?? "2026-09-04",
        openDays: 2,
      },
      threshold: {
        pct: over.pct ?? 0.25,
        source: "ow_uw_iv_term implied_move_perc, expiry 2026-09-05, dte 2",
      },
      p: over.p ?? 0.5,
      settleAfterOpenDays: 2,
    },
  };
}

describe("settleFocus", () => {
  it("a move bigger than the implied move is a hit", async () => {
    const receipt = await settleFocus({
      commitment: admit({ pct: 0.25 }),
      now: NOW,
      source: source(SPY_TWO_DAY),
    });
    expect(receipt.status).toBe("hit");
    const detail = receipt.detail as { movePct: number; ticker: string };
    expect(detail.ticker).toBe("SPY");
    expect(detail.movePct).toBeCloseTo(-0.3854, 3);
    expect(receipt.scores.focusBrier).toBeCloseTo(0.25, 10);
  });

  it("the same move under a bigger implied move is a miss, scored the same", async () => {
    const receipt = await settleFocus({
      commitment: admit({ pct: 1.0 }),
      now: NOW,
      source: source(SPY_TWO_DAY),
    });
    expect(receipt.status).toBe("miss");
    expect(receipt.scores.focusBrier).toBeCloseTo(0.25, 10);
  });

  it("a window whose end has no bar yet pends, naming the ticker and the day", async () => {
    const receipt = await settleFocus({
      commitment: admit({ toDay: "2026-09-08" }),
      now: NOW,
      source: source(SPY_TWO_DAY),
    });
    expect(receipt.status).toBe("pending");
    const reason = (receipt.detail as { reason: string }).reason;
    expect(reason).toContain("SPY");
    expect(reason).toContain("2026-09-08");
  });

  it("a missing anchor pends, never misses", async () => {
    const receipt = await settleFocus({
      commitment: admit({ fromDay: "2026-08-01", toDay: "2026-09-04" }),
      now: NOW,
      source: source(SPY_TWO_DAY.slice(1)),
    });
    expect(receipt.status).toBe("pending");
  });

  it("two settles produce the same evidence hash", async () => {
    const first = await settleFocus({
      commitment: admit(),
      now: NOW,
      source: source(SPY_TWO_DAY),
    });
    const second = await settleFocus({
      commitment: admit(),
      now: new Date("2026-09-20T00:00:00Z"),
      source: source(SPY_TWO_DAY),
    });
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });
});

describe("realizedThreshold", () => {
  it("returns a finite percent over 60 real daily closes", () => {
    const value = realizedThreshold(SPY_SERIES, 2);
    expect(value).not.toBeNull();
    expect(Number.isFinite(value!)).toBe(true);
    expect(value!).toBeGreaterThan(0);
  });

  it("returns null from fewer than openDays + 1 bars", () => {
    expect(realizedThreshold(SPY_SERIES.slice(0, 2), 2)).toBeNull();
  });
});

describe("the OW_APEX_API_BASE guard is narrowed to the bar-backed kinds", () => {
  const focus = admit();
  const verdict: Commitment = {
    id: "2026-09-03-close-verdict-rates.front",
    runId: "run-0",
    tenant: "option-wizard",
    issuedAt: "2026-09-03T20:30:00Z",
    deployment: "test",
    variant: "test",
    payload: {
      kind: "coverage-verdict",
      evaluator: "verdict-v0",
      rowId: "rates.front",
      series: "DGS2",
      unit: "bp",
      token: "reverse",
      p: 0.7,
      observed: { delta: -3.1 },
      settleAfterOpenDays: 1,
    },
  };
  const laterVerdict: Commitment = {
    ...verdict,
    id: "2026-09-04-close-verdict-rates.front",
    issuedAt: "2026-09-04T20:30:00Z",
    payload: {
      ...(verdict.payload as Record<string, unknown>),
      observed: { delta: 4.4 },
    },
  };

  it("pends a focus admission and still settles a coverage verdict", async () => {
    const settler = buildSettler({
      stateRoot: "/nonexistent-state-root-for-this-test",
      env: {},
      variant: "test",
    });
    const receipts = await settler.settle([focus, verdict, laterVerdict], NOW);
    const byId = new Map(receipts.map((row) => [row.commitmentId, row]));
    expect(byId.get(focus.id)?.status).toBe("pending");
    expect((byId.get(focus.id)?.detail as { reason: string }).reason).toContain(
      "OW_APEX_API_BASE",
    );
    expect(byId.get(verdict.id)?.status).toBe("reverse");
  });

  it("an unknown kind is still left alone", async () => {
    const receipts = await settleAll(
      [{ ...verdict, id: "x", payload: { kind: "not-a-kind" } }],
      NOW,
      null,
    );
    expect(receipts).toEqual([]);
  });
});
