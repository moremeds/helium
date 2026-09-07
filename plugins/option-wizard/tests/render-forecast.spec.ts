import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import { forecastFrom } from "../render/index.js";

function report(scenariosText: string): RunReport {
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
        task: "scenarios",
        role: "scenario-analyst",
        mode: "model",
        text: scenariosText,
      },
    ],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  } as unknown as RunReport;
}

const good = JSON.stringify({
  sections: [{ title: "A", body: "b" }],
  spyForecast: {
    referenceClose: { date: "2026-09-03", value: 770.19 },
    t1Down: 0.42,
    t5Down: 0.47,
  },
});

describe("spyForecast", () => {
  it("parses a well-formed forecast as scorable", () => {
    expect(forecastFrom(report(good))).toEqual({
      scorable: true,
      forecast: {
        referenceClose: { date: "2026-09-03", value: 770.19 },
        t1Down: 0.42,
        t5Down: 0.47,
      },
    });
  });

  it("is absent when the scenarios step did not run", () => {
    const bare = report(good);
    bare.steps = [];
    expect(forecastFrom(bare)).toBeUndefined();
  });

  it("a missing forecast is not scorable and says why — the brief still renders", () => {
    const block = forecastFrom(report(JSON.stringify({ sections: [] })));
    expect(block).toEqual({
      scorable: false,
      reason: "the scenarios step wrote no spyForecast object",
    });
  });

  it("a probability outside [0,1] is not scorable", () => {
    const text = JSON.stringify({
      spyForecast: {
        referenceClose: { date: "2026-09-03", value: 770.19 },
        t1Down: 1.4,
        t5Down: 0.5,
      },
    });
    expect(forecastFrom(report(text))!.scorable).toBe(false);
    expect(forecastFrom(report(text))!.reason).toContain("t1Down");
  });

  it("a missing referenceClose is not scorable", () => {
    const text = JSON.stringify({ spyForecast: { t1Down: 0.4, t5Down: 0.5 } });
    expect(forecastFrom(report(text))!.reason).toContain("referenceClose");
  });

  it("no LLM normalisation: a string probability is refused, not coerced", () => {
    const text = JSON.stringify({
      spyForecast: {
        referenceClose: { date: "2026-09-03", value: 770.19 },
        t1Down: "0.42",
        t5Down: 0.5,
      },
    });
    expect(forecastFrom(report(text))!.scorable).toBe(false);
  });
});

describe("a zero anchor is not a price", () => {
  // A laptop PIT replay minted t1/t5 commitments anchored at 0. `settleSpy`
  // compares the settling close to that anchor, and every close is above zero,
  // so the leg was unfalsifiable — a forecast that cannot be wrong.
  it("refuses referenceClose.value 0 with the reason", () => {
    const zero = JSON.stringify({
      spyForecast: {
        referenceClose: { date: "2026-09-03", value: 0 },
        t1Down: 0.42,
        t5Down: 0.47,
      },
    });
    expect(forecastFrom(report(zero))).toEqual({
      scorable: false,
      reason: "referenceClose.value is not a positive price",
    });
  });

  it("accepts SPY's real 2026-09-03 raw close", () => {
    const real = JSON.stringify({
      spyForecast: {
        referenceClose: { date: "2026-09-03", value: 773.17 },
        t1Down: 0.42,
        t5Down: 0.47,
      },
    });
    expect(forecastFrom(report(real))?.scorable).toBe(true);
  });
});
