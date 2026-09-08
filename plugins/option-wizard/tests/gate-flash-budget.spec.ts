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

describe("flash-budget over the one-thing and review shapes", () => {
  const editor = { runId: "run-1", role: "editor" };
  const long = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  const frameOutput = (mode: string) =>
    JSON.stringify({
      kind: "session-frame/1",
      mode,
      caps: {
        weekly: {
          review: 900,
          outlook: 400,
          catalysts: 150,
          rowWords: 15,
          focusWords: 20,
          themeWords: 25,
        },
        daily: {
          review: 120,
          outlook: 180,
          catalysts: 60,
          rowWords: 10,
          focusWords: 20,
          themeWords: 25,
        },
      },
    });

  it("refuses a 250-word lead item against 180", async () => {
    const result = await gate.check(
      { text: JSON.stringify({ oneThing: long(250) }) },
      { ...editor, toolOutputs: [frameOutput("ratio")] } as never,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("oneThing 250 of 180");
  });

  it("refuses the same paragraph at 90 under the persistence mode", async () => {
    const result = await gate.check(
      { text: JSON.stringify({ oneThing: long(250) }) },
      { ...editor, toolOutputs: [frameOutput("persistence")] } as never,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("of 90");
  });

  it("measures a review document against the caps the frame carries", async () => {
    const doc = JSON.stringify({
      review: long(350),
      coverage: [{ id: "rates.long", why: "short", observable: "short" }],
      themes: [{ id: "t", why: "short" }],
    });
    // `themes` present -> the wider table the frame declared.
    const wide = await gate.check(
      { text: doc },
      { ...editor, toolOutputs: [frameOutput("ratio")] } as never,
    );
    expect(wide.pass).toBe(true);
    // No frame at all -> the STRICTER table, because a gate that guesses the
    // looser limit guards nothing.
    const strict = await gate.check({ text: doc }, editor as never);
    expect(strict.pass).toBe(false);
    expect(strict.reason).toContain("review 350 of 300");
  });

  it("passes a document with none of the three shapes", async () => {
    const result = await gate.check(
      { text: JSON.stringify({ tape: [] }) },
      editor as never,
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("no sections to measure");
  });
});
