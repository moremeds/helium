/**
 * The verdict settler: a stored token scored against the NEXT dated
 * observation of the same row.
 *
 * The moves asserted here are the real 2026-09-03 close ones from
 * `$S/pit/weekend-2026-09-06/reports/option-wizard-2026-09-03-close.md`:
 * 2Y -3.1bp on the day, 10Y -0.8bp, 30Y -0.7bp.
 */
import { describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import { classify, settleVerdict } from "../eval/verdict.js";

const NOW = new Date("2026-09-14T20:30:00Z");

function verdict(
  over: {
    id?: string;
    issuedAt?: string;
    rowId?: string;
    token?: string;
    p?: number;
    delta?: number;
    settleAfterOpenDays?: number;
  } = {},
): Commitment {
  const rowId = over.rowId ?? "rates.front";
  const day = (over.issuedAt ?? "2026-09-03T20:30:00Z").slice(0, 10);
  return {
    id: over.id ?? `${day}-close-verdict-${rowId}`,
    runId: "run-0",
    tenant: "option-wizard",
    issuedAt: over.issuedAt ?? "2026-09-03T20:30:00Z",
    deployment: "test",
    variant: "test",
    payload: {
      kind: "coverage-verdict",
      evaluator: "verdict-v0",
      rowId,
      series: "DGS2",
      unit: "bp",
      token: over.token ?? "reverse",
      p: over.p ?? 0.7,
      observed: { delta: over.delta ?? -3.1 },
      settleAfterOpenDays: over.settleAfterOpenDays ?? 5,
    },
  };
}

describe("classify", () => {
  it("puts the next move in the band the token claimed", () => {
    expect(classify(-3.1, 4.4)).toBe("reverse");
    expect(classify(-3.1, -3.0)).toBe("continue");
    expect(classify(-3.1, -0.2)).toBe("fade");
    expect(classify(-3.1, -9.0)).toBe("strengthen");
  });

  it("a wiggle under the nil fraction has no sign and fades", () => {
    expect(classify(-3.1, -0.05)).toBe("fade");
    expect(classify(-3.1, 0.05)).toBe("fade");
  });

  // review-v6 close: `flow — 39758465 → +0 USD — CONTINUE (0USD..0USD)`.
  // Every band is a multiple of the prior magnitude, so a nil prior has no
  // band and there is nothing to be right about.
  it("a NIL prior has no band at all — neither continue nor strengthen", () => {
    expect(classify(0, 0)).toBe(null);
    expect(classify(0, 4.4)).toBe(null);
    expect(classify(-0, -9)).toBe(null);
  });
});

describe("settleVerdict", () => {
  const later = verdict({
    issuedAt: "2026-09-11T20:30:00Z",
    delta: 4.4,
  });

  it("scores a correct reverse at (0.7 - 1) squared", async () => {
    const receipt = settleVerdict({
      commitment: verdict({ token: "reverse", p: 0.7 }),
      later: [later],
      now: NOW,
    });
    expect(receipt.status).toBe("reverse");
    expect(receipt.scores.verdictBrier).toBeCloseTo(0.09, 10);
    const detail = receipt.detail as {
      rowId: string;
      said: string;
      got: string;
    };
    expect(detail.rowId).toBe("rates.front");
    expect(detail.said).toBe("reverse");
    expect(detail.got).toBe("reverse");
  });

  it("scores the same observation said continue at (0.7 - 0) squared", () => {
    const receipt = settleVerdict({
      commitment: verdict({ token: "continue", p: 0.7 }),
      later: [later],
      now: NOW,
    });
    expect(receipt.status).toBe("reverse");
    expect(receipt.scores.verdictBrier).toBeCloseTo(0.49, 10);
  });

  it("pends when no later observation of the row exists", () => {
    const receipt = settleVerdict({
      commitment: verdict(),
      later: [verdict({ rowId: "vol", issuedAt: "2026-09-11T20:30:00Z" })],
      now: NOW,
    });
    expect(receipt.status).toBe("pending");
    expect((receipt.detail as { reason: string }).reason).toContain(
      "rates.front",
    );
  });

  it("pends rather than scoring a verdict whose prior move was nil", () => {
    const receipt = settleVerdict({
      commitment: verdict({ rowId: "flow", token: "continue", delta: 0 }),
      later: [
        verdict({
          rowId: "flow",
          issuedAt: "2026-09-11T20:30:00Z",
          delta: 39_758_465,
        }),
      ],
      now: NOW,
    });
    expect(receipt.status).toBe("pending");
    expect((receipt.detail as { reason: string }).reason).toContain(
      "was nil: no band to score",
    );
    expect(receipt.scores.verdictBrier).toBeUndefined();
  });

  it("pends when fewer open days have passed than the cadence asks for", () => {
    // 2026-09-03 is a Thursday: 09-04 is one open day out, 09-07 is two.
    const receipt = settleVerdict({
      commitment: verdict({ settleAfterOpenDays: 5 }),
      later: [verdict({ issuedAt: "2026-09-07T20:30:00Z", delta: 4.4 })],
      now: NOW,
    });
    expect(receipt.status).toBe("pending");
    expect((receipt.detail as { reason: string }).reason).toContain("2 seen");
  });

  it("two settles of the same commitment produce the same evidence hash", () => {
    const args = {
      commitment: verdict(),
      later: [later],
      now: NOW,
    };
    expect(settleVerdict(args).evidenceHash).toBe(
      settleVerdict({ ...args, now: new Date("2026-09-20T00:00:00Z") })
        .evidenceHash,
    );
  });
});
