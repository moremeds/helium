/**
 * The three deterministic numbers every run writes. No LLM judge.
 * @module dsh-plugin-tenant-option-wizard/tests/quality-metrics
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunReport } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  budgetViolations,
  priorCauseTitle,
  qualityMetrics,
} from "../quality/index.js";

const TITLE_A =
  "A hawkish front end: futures put 64% on a September hike while the 10Y sits at 4.75%, its highest August close";
const TITLE_B =
  "August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give the labor market";

function reportFile(dir: string, day: string, label: string, title: string) {
  writeFileSync(
    join(dir, `option-wizard-${day}-${label}.md`),
    `# [TEST] ${label} ${day}\n\n## edit — editor\n\n${JSON.stringify({
      headline: "h",
      sections: [{ title, body: "b" }],
    })}\n`,
    "utf8",
  );
}

function report(steps: RunReport["steps"] = []): RunReport {
  return {
    runId: "run-q",
    tenant: "option-wizard",
    phase: "premarket",
    day: "2026-09-04",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps,
  } as RunReport;
}

describe("priorCauseTitle", () => {
  it("takes the newest report strictly before this run, across days", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-01", "intraday", TITLE_A);
    reportFile(dir, "2026-09-04", "premarket", "today's own, must not be read");
    expect(
      priorCauseTitle({ dir, day: "2026-09-04", label: "premarket" }),
    ).toBe(TITLE_A);
  });

  it("orders two reports on the same day by their place in the day", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-04", "premarket", TITLE_A);
    reportFile(dir, "2026-09-04", "intraday", TITLE_B);
    expect(priorCauseTitle({ dir, day: "2026-09-04", label: "close" })).toBe(
      TITLE_B,
    );
    expect(priorCauseTitle({ dir, day: "2026-09-04", label: "intraday" })).toBe(
      TITLE_A,
    );
  });

  it("returns null when there is no earlier report, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    expect(
      priorCauseTitle({ dir, day: "2026-09-04", label: "premarket" }),
    ).toBe(null);
    expect(
      priorCauseTitle({
        dir: join(dir, "nope"),
        day: "2026-09-04",
        label: "premarket",
      }),
    ).toBe(null);
  });
});

describe("budgetViolations", () => {
  it("counts every overage the flash budget measures across the run's steps", () => {
    const long = Array.from({ length: 61 }, () => "w").join(" ");
    const doc = {
      headline: Array.from({ length: 31 }, () => "h").join(" "),
      sections: [
        { title: "one", body: long },
        { title: "two", body: long },
      ],
    };
    // headline over 30, two bodies over 60 = 3.
    expect(
      budgetViolations(
        report([
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(doc),
          },
        ]),
      ),
    ).toBe(3);
  });

  it("counts a section-count overflow as one more violation", () => {
    const doc = {
      headline: "short",
      sections: Array.from({ length: 6 }, (_x, i) => ({
        title: `s${String(i)}`,
        body: "fine",
      })),
    };
    expect(
      budgetViolations(
        report([
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(doc),
          },
        ]),
      ),
    ).toBe(1);
  });

  it("is zero for a step that produced no sections", () => {
    expect(
      budgetViolations(
        report([{ task: "one", role: "prober", mode: "model", text: "hello" }]),
      ),
    ).toBe(0);
  });
});

describe("qualityMetrics", () => {
  it("returns the three rows in order, with the pinned Jaccard", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-01", "intraday", TITLE_A);
    const metrics = qualityMetrics({
      view: {
        headline: "No prior premarket brief exists — starting from today.",
        sections: [{ title: TITLE_B, body: "The front end has no cut." }],
      },
      report: report(),
      dir,
    });
    expect(metrics.map((metric) => [metric.name, metric.short])).toEqual([
      ["metaLeakHits", "leaks"],
      ["budgetViolations", "budget"],
      ["causeTitleSimilarity", "cause-sim"],
    ]);
    expect(metrics[0]!.value).toBe(1);
    expect(metrics[1]!.value).toBe(0);
    expect(metrics[2]!.value).toBeCloseTo(3 / 28, 12);
  });

  it("reports a null similarity when there is no prior report", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    const metrics = qualityMetrics({
      view: { headline: "Clean.", sections: [{ title: TITLE_A, body: "b" }] },
      report: report(),
      dir,
    });
    expect(metrics[2]!.value).toBe(null);
  });
});
