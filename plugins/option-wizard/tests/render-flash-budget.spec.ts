/**
 * The renderer ENFORCES the flash budget — deterministically, after the
 * editor, before charts. Fixtures are the recorded 2026-09-03 premarket view
 * (11 sections of 111–259 words, a 43-word headline, a 53-word Confidence).
 * @module dsh-plugin-tenant-option-wizard/tests/render-flash-budget
 */
import { readFileSync } from "node:fs";
import type { RunReport, TenantSpec } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  FLASH_BUDGET,
  ONE_THING_BUDGET,
  REVIEW_BUDGET,
  measureOneThing,
  measureReview,
  trim,
  words,
} from "../render/budget.js";
import { buildView, type BriefView } from "../render/index.js";

const cfg = { tenant: "option-wizard" } as unknown as TenantSpec;

const FX = JSON.parse(
  readFileSync(
    new URL("./fixtures/flash-2026-09-03.json", import.meta.url),
    "utf8",
  ),
) as {
  premarketView: {
    headline: string;
    sections: Array<{ title: string; body: string }>;
    coverage: { title: string; body: string };
    decision: Array<{ label: string; value: string }>;
  };
};

/** A run whose `edit` step wrote the recorded premarket view verbatim. */
function report(
  doc: Record<string, unknown>,
  step: Partial<RunReport["steps"][number]> = {},
): RunReport {
  return {
    runId: "run-flash-fixture",
    tenant: "option-wizard",
    phase: "premarket",
    day: "2026-09-03",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps: [
      {
        task: "edit",
        role: "editor",
        mode: "model",
        text: JSON.stringify(doc),
        ...step,
      },
    ],
  } as RunReport;
}

const reverseRisk = FX.premarketView.sections.find(
  (s) => s.title === "Reverse risk",
)!;

describe("trim", () => {
  it("cuts the recorded 259-word Reverse risk body at a sentence end", () => {
    const out = trim(reverseRisk.body, FLASH_BUDGET.sectionBodyWords);
    expect(out.cut).toBe("sentence");
    expect(words(out.text)).toBeLessThanOrEqual(60);
    expect(out.text.endsWith(".")).toBe(true);
    expect(out.text).not.toContain("…");
  });

  it("keeps a sentence whose end falls exactly on the budget", () => {
    const body =
      Array.from({ length: 60 }, () => "w").join(" ") + ". Next one.";
    const out = trim(body, 60);
    expect(words(out.text)).toBe(60);
    expect(out.text.endsWith("w.")).toBe(true);
  });

  it("word-cuts with … when the first sentence alone is over budget", () => {
    const one = reverseRisk.body.replace(/[.!?]\s+/g, ", ");
    const out = trim(one, 60);
    expect(out.cut).toBe("word");
    expect(out.text.endsWith("…")).toBe(true);
    expect(words(out.text)).toBe(60);
  });

  it("returns an in-budget text untouched", () => {
    expect(trim("One. Two.", 5)).toEqual({ text: "One. Two.", cut: "none" });
  });
});

describe("enforceBudget in buildView", () => {
  // The editor writes `decision` as {label: value}; the stored view holds it
  // as rows. Same recorded values, the editor's shape.
  const editorDoc = {
    ...FX.premarketView,
    decision: Object.fromEntries(
      FX.premarketView.decision.map((d) => [d.label, d.value]),
    ),
  };
  const view: BriefView = buildView(report(editorDoc), cfg);

  it("keeps five sections, each within 60 words", () => {
    expect(FX.premarketView.sections).toHaveLength(11);
    expect(view.sections).toHaveLength(5);
    for (const s of view.sections)
      expect(words(s.body)).toBeLessThanOrEqual(60);
    expect(view.sections.map((s) => s.title)).toEqual(
      FX.premarketView.sections.slice(0, 5).map((s) => s.title),
    );
  });

  it("cuts the 43-word headline to 30", () => {
    expect(words(FX.premarketView.headline)).toBe(43);
    expect(words(view.headline)).toBeLessThanOrEqual(30);
  });

  it("cuts the 53-word Confidence value to 25", () => {
    const before = FX.premarketView.decision.find(
      (d) => d.label === "Confidence",
    )!;
    expect(words(before.value)).toBe(53);
    const after = view.decision!.find((d) => d.label === "Confidence")!;
    expect(words(after.value)).toBeLessThanOrEqual(25);
  });

  it("leaves coverage untouched", () => {
    expect(view.coverage).toEqual(FX.premarketView.coverage);
  });

  it("returns a view already inside budget byte-identical", () => {
    const small = {
      headline: "Short headline.",
      sections: FX.premarketView.sections.slice(0, 3).map((s) => ({
        title: s.title,
        body: "Two sentences. Both short.",
      })),
      decision: [{ label: "Call", value: "Hold." }],
    };
    const a = buildView(report(small), cfg);
    const b = buildView(report(small), cfg);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.sections.map((s) => s.body)).toEqual(
      small.sections.map((s) => s.body),
    );
    expect(a.headline).toBe("Short headline.");
  });

  it("keeps the editor's document through a flash-budget-only refusal", () => {
    const refused = buildView(
      report(editorDoc, {
        gateRefusals: [{ id: "flash-budget", reason: "4 of 11 over" }],
      }),
      cfg,
    );
    expect(refused.edited).toBe(true);
    expect(refused.sections).toHaveLength(5);
  });

  it("still discards the document on any other gate's refusal", () => {
    const refused = buildView(
      report(editorDoc, {
        failure: "gate-refused",
        gateRefusals: [{ id: "as-of-verbatim", reason: "invented clock" }],
      }),
      cfg,
    );
    expect(refused.edited).toBeUndefined();
  });
});

describe("the budget tables name a field, never a run label", () => {
  it("holds no phase name and takes a mode or a caps object", () => {
    // The renderer may not learn a phase. `measureOneThing` is switched by the
    // SELECTION MODE the tool reported and `measureReview` by the CAPS the
    // tenant declared — both data handed in, so adding a sixth run label costs
    // no edit here.
    const src = readFileSync(
      new URL("../render/budget.ts", import.meta.url).pathname,
      "utf8",
    );
    for (const name of ["premarket", "intraday", "weekly", "frank"])
      expect(src.includes(`"${name}"`), name).toBe(false);
    expect(measureOneThing.length).toBe(2);
    expect(measureReview.length).toBe(2);
    expect(Object.keys(ONE_THING_BUDGET).some((k) => k.includes("phase"))).toBe(
      false,
    );
    expect(REVIEW_BUDGET.weekly.total).toBeGreaterThan(REVIEW_BUDGET.daily.total);
    expect(REVIEW_BUDGET.daily.total).toBeGreaterThanOrEqual(
      REVIEW_BUDGET.daily.review + REVIEW_BUDGET.daily.outlook,
    );
  });
});
