import { describe, expect, it } from "vitest";
import { renderHtml } from "../render/html.js";
import type { BriefView, CandidateView } from "../render/index.js";

const candidate: CandidateView = {
  id: "SPY-2026-09-04-premarket-1",
  ticker: "SPY",
  strategy: "put_debit_spread",
  expiry: "2026-10-02",
  dte: 28,
  legs: [
    { action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 },
    { action: "sell", right: "put", strike: 745, expiry: "2026-10-02", mid: 4.2 },
  ],
  pricing: { kind: "unpriced", reason: "no spot" },
  width: 25,
  invalidation: [{ level: 778, side: "above" }],
  target: { level: 748, side: "below" },
  thesis: "SPY grinds toward the September gamma shelf",
  resolutionDeadline: "2026-10-02",
  rationale: "r",
};

function view(over: Partial<BriefView> = {}): BriefView {
  return {
    schemaVersion: 2,
    date: "2026-09-04",
    tenant: "option-wizard",
    outcome: "completed",
    headline: "h",
    tape: [],
    schedule: [],
    overnight: [],
    sections: [],
    regime: { paragraph: "p" },
    candidates: [candidate],
    riskList: [],
    charts: { gex: [] },
    ...over,
  } as BriefView;
}

describe("candidate card html", () => {
  it("prints the numeric target beside the invalidation", () => {
    const html = renderHtml(view());
    // Through `invalidationLabel`, the same helper the invalidation cell uses:
    // one arrow notation for both, because they are the same kind of thing and
    // a second format for the target is a second thing for a reader to learn.
    expect(html).toContain("748\u2193");
    expect(html).toContain("778\u2191");
  });

  it("prints the thesis under the legs", () => {
    expect(renderHtml(view())).toContain(
      "SPY grinds toward the September gamma shelf",
    );
  });

  it("prints an em dash for a candidate with no typed target, and still renders the row", () => {
    const bare = { ...candidate, thesis: "" };
    delete (bare as { target?: unknown }).target;
    const html = renderHtml(view({ candidates: [bare as CandidateView] }));
    expect(html).toContain("SPY");
    expect(html).not.toContain("undefined");
  });
});
