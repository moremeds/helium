import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import { baselineDraft, forecastCommitments } from "../render/ledger.js";
import type { BriefView } from "../render/index.js";

const metrics = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/argon-metrics-2026-09-04.json"),
    "utf8",
  ),
) as { response: unknown };

const view = {
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
  candidates: [
    {
      id: "SPY-2026-09-04-premarket-1",
      ticker: "SPY",
      strategy: "put_debit_spread",
      expiry: "2026-10-02",
      dte: 28,
      legs: [
        { action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 },
      ],
      pricing: { kind: "unpriced", reason: "no spot" },
      width: 0,
      invalidation: [{ level: 778, side: "above" }],
      target: { level: 748, side: "below" },
      thesis: "t",
      resolutionDeadline: "2026-10-02",
      rationale: "r",
    },
  ],
  riskList: [],
  charts: { gex: [] },
  spyForecast: {
    scorable: true,
    forecast: {
      referenceClose: { date: "2026-09-03", value: 770.19 },
      t1Down: 0.42,
      t5Down: 0.47,
    },
  },
} as unknown as BriefView;

function report(toolOutputs: string[]): RunReport {
  return {
    runId: "run-1",
    tenant: "option-wizard",
    mode: "model",
    phase: "premarket",
    day: "2026-09-04",
    providersLive: [],
    providersSkipped: [],
    steps: [
      {
        task: "regime",
        role: "regime-analyst",
        mode: "model",
        text: "",
        toolOutputs,
      },
    ],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  } as unknown as RunReport;
}

describe("commitments", () => {
  it("mints one commitment per settleable thing, phase-segmented", () => {
    const drafts = forecastCommitments(view, "premarket");
    expect(drafts.map((d) => d.id)).toEqual([
      "2026-09-04-premarket-spy-t1",
      "2026-09-04-premarket-spy-t5",
    ]);
    expect(drafts[0]!.payload).toEqual({
      kind: "spy-direction",
      evaluator: "evaluator-v0",
      horizonBars: 1,
      symbol: "SPY",
      referenceClose: { date: "2026-09-03", value: 770.19 },
      pDown: 0.42,
    });
    expect((drafts[1]!.payload as { horizonBars: number }).horizonBars).toBe(5);
  });

  it("mints nothing when the forecast is not scorable", () => {
    const bad = {
      ...view,
      spyForecast: { scorable: false, reason: "no forecast" },
    } as BriefView;
    expect(forecastCommitments(bad, "premarket")).toEqual([]);
  });

  it("emits NO candidate forecast commitment in V0", () => {
    // The candidate-selection team that will emit `candidate.forecast` is a
    // separate build; settle.ts already knows the -entry/-result rules.
    expect(
      forecastCommitments(view, "premarket").every((d) => d.id.includes("-spy-")),
    ).toBe(true);
  });
});

describe("baselines", () => {
  it("writes the neutral and uniform floors the run has to beat", () => {
    const draft = baselineDraft(view, report([]), "premarket");
    expect(draft.id).toBe("2026-09-04-premarket-baseline");
    const payload = draft.payload as Record<string, unknown>;
    expect(payload.neutral).toEqual({ t1Down: 0.5, t5Down: 0.5 });
    expect(payload.uniform).toEqual([
      {
        candidateId: "SPY-2026-09-04-premarket-1",
        pTrigger: 0.5,
        givenTrigger: {
          targetFirst: 1 / 3,
          invalidationFirst: 1 / 3,
          unresolved: 1 / 3,
        },
      },
    ]);
  });

  it("carries dataDate verbatim from ow_argon_metrics and names what is missing", () => {
    const draft = baselineDraft(
      view,
      report([JSON.stringify(metrics.response)]),
      "premarket",
    );
    expect((draft.payload as { argon: unknown }).argon).toEqual({
      dataDate: "2026-09-04",
      missing: ["confidence", "expectedReturn20d", "signal"],
    });
  });

  it("omits the argon block when no metrics tool answered", () => {
    expect(
      (baselineDraft(view, report([]), "premarket").payload as { argon?: unknown })
        .argon,
    ).toBeUndefined();
  });
});
