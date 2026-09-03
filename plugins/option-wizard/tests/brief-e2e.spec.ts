/**
 * Gate and renderer over the SAME text, in the order a run applies them.
 *
 * The regression this exists for: the gate and the renderer were each correct
 * in their own suite while disagreeing about the shape of a proposal, and
 * nothing tested the pair. run-ec962c3e (2026-09-02 23:47 HKT, the first live
 * run on the new renderer) delivered a brief whose trades had been replaced by
 * `malformed proposal: quantity: Invalid input` — the gate still required two
 * fields the designer had stopped emitting.
 *
 * Fixture: that run's risk-reviewer output, verbatim, mids included. Those are
 * the NBBO mids ow_uw_chain returned for those contracts that evening.
 */
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import gate from "../gates/ib-preflight.js";
import renderReport from "../render/index.js";

/** run-ec962c3e, risk-reviewer, verbatim (rationales trimmed for width). */
const REVIEW_TEXT = JSON.stringify({
  proposals: [
    {
      ticker: "SPY",
      strategy: "put debit spread",
      legs: [
        { right: "put", expiry: "2026-09-30", strike: 750, action: "buy", ratio: 1, mid: 4.92 },
        { right: "put", expiry: "2026-09-30", strike: 720, action: "sell", ratio: 1, mid: 2.02 },
      ],
      rationale: "Defined-risk light hedge against a low-volatility regime.",
    },
    {
      ticker: "QQQ",
      strategy: "call debit spread",
      legs: [
        { right: "call", expiry: "2026-09-30", strike: 710, action: "buy", ratio: 1, mid: 13.68 },
        { right: "call", expiry: "2026-09-30", strike: 730, action: "sell", ratio: 1, mid: 4.91 },
      ],
      rationale: "Defined-risk modest bullish expression; the 730 caps upside.",
    },
    {
      ticker: "TLT",
      strategy: "put debit spread",
      legs: [
        { right: "put", expiry: "2026-09-30", strike: 82, action: "buy", ratio: 1, mid: 0.95 },
        { right: "put", expiry: "2026-09-30", strike: 79, action: "sell", ratio: 1, mid: 0.15 },
      ],
      rationale: "Defined-risk long-end hedge against term-premium drift.",
    },
  ],
  riskList: [],
});

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

function report(): RunReport {
  return {
    runId: "run-ec962c3e-d57a-4b80-99fe-c5f4e67899f9",
    tenant: "option-wizard",
    // The runner's day, resolved in the tenant's reportTimezone (ET).
    day: "2026-09-02",
    mode: "model",
    outcome: "completed",
    providersLive: ["codex-subscription"],
    providersSkipped: [],
    gatesSkipped: [],
    toolsUnconfigured: [],
    delivery: [],
    steps: [
      { task: "review", role: "risk-reviewer", text: REVIEW_TEXT, targetId: "codex-subscription:gpt-5.6-luna" },
    ],
  } as unknown as RunReport;
}

describe("one brief, gated then rendered", () => {
  it("passes the gate the run applies to the reviewer's own output", async () => {
    // The runner hands a gate the step output, not a bare string.
    const verdict = await gate.check({ text: REVIEW_TEXT }, {} as never);
    expect(verdict.reason).not.toContain("malformed");
    expect(verdict.pass).toBe(true);
  });

  it("puts the trades in the brief instead of a gate error", async () => {
    const rendered = renderReport(report(), SPEC);
    const body = `${rendered.text}\n${rendered.html ?? ""}`;
    for (const ticker of ["SPY", "QQQ", "TLT"]) expect(body).toContain(ticker);
    expect(body).not.toContain("malformed proposal");
    expect(body).not.toContain("Invalid input");
    // SPY 750/720 put debit: 2.90 paid, so 290 risked, 2710 max gain
    // (30 width less the debit), breakeven 750 - 2.90.
    expect(body).toContain("747.10");
    expect(body).toContain("290.00");
  });
});
