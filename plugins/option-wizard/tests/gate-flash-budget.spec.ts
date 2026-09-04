/**
 * The `flash-budget` output gate, measured against the recorded 2026-09-03
 * intraday sections (171, 189, 91, 210 words under a 38-word headline).
 * @module dsh-plugin-tenant-option-wizard/tests/gate-flash-budget
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import gate from "../gates/flash-budget.js";

const FX = JSON.parse(
  readFileSync(
    new URL("./fixtures/flash-2026-09-03.json", import.meta.url),
    "utf8",
  ),
) as {
  intradayHeadline: string;
  intradayRegimeSections: Array<{ title: string; body: string }>;
};

const ctx = { runId: "run-1", role: "regime-analyst" };

describe("flash-budget", () => {
  it("refuses the recorded intraday step, naming the counts", async () => {
    const text = JSON.stringify({
      headline: FX.intradayHeadline,
      sections: FX.intradayRegimeSections,
    });
    const result = await gate.check({ text }, ctx);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("4 of 4 sections over 60 words");
    for (const n of ["171", "189", "210", "91"])
      expect(result.reason).toContain(n);
    expect(result.reason).toContain("headline 38 of 30");
  });

  it("names a first-sentence-over-budget body separately", async () => {
    // The recorded 210-word body's clauses joined into one sentence: no
    // sentence end before the budget, so the renderer must word-cut it.
    const one = FX.intradayRegimeSections[3]!.body.replace(/[.!?]\s+/g, ", ");
    const result = await gate.check(
      { text: JSON.stringify({ sections: [{ title: "x", body: one }] }) },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("first sentence alone over budget");
    expect(result.reason).toContain("section 1");
  });

  it("passes an in-budget step", async () => {
    const short = FX.intradayRegimeSections.map((s) => ({
      title: s.title,
      body: s.body.split(/\s+/).slice(0, 12).join(" ") + ".",
    }));
    const result = await gate.check(
      { text: JSON.stringify({ headline: "Short.", sections: short }) },
      ctx,
    );
    expect(result.pass).toBe(true);
  });

  it("passes prose with no sections to measure", async () => {
    const result = await gate.check(
      { text: "The regime step wrote prose and no JSON this time." },
      ctx,
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("no sections to measure");
  });

  it("counts more than five sections as an overage", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      title: `s${String(i)}`,
      body: "Short.",
    }));
    const result = await gate.check(
      { text: JSON.stringify({ sections: six }) },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("6 sections of 5");
  });
});
