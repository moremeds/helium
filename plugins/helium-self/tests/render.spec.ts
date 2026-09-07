import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import {
  EXPERIMENT_KIND,
  commitmentDrafts,
  loadExperiments,
} from "../render/index.js";
import render from "../render/index.js";

const REPORT = {
  runId: "run-1",
  tenant: "helium-self",
  mode: "model",
  phase: "manual",
  day: "2026-09-06",
  providersLive: [],
  providersSkipped: [],
  steps: [
    { task: "restate", role: "scribe", mode: "model", text: "restated." },
  ],
  outcome: "completed",
  gatesSkipped: [],
  delivery: [],
  toolsUnconfigured: [],
} as unknown as RunReport;

const SPEC = { tenant: "helium-self" } as unknown as TenantSpec;

const priorStateRoot = process.env.HELIUM_STATE_ROOT;
afterEach(() => {
  if (priorStateRoot === undefined) delete process.env.HELIUM_STATE_ROOT;
  else process.env.HELIUM_STATE_ROOT = priorStateRoot;
});

describe("helium-self renderer", () => {
  it("loads the declared experiments from the tenant's own directory", () => {
    const ids = loadExperiments().map((experiment) => experiment.id);
    expect(ids).toContain("2026-09-06-density-arm-h");
  });

  it("mints one commitment per experiment, payload = file plus kind", () => {
    const experiments = loadExperiments();
    const drafts = commitmentDrafts(experiments, new Set());
    expect(drafts).toHaveLength(experiments.length);
    const first = drafts.find(
      (draft) => draft.id === "2026-09-06-density-arm-h",
    );
    expect(first).toBeDefined();
    const payload = first?.payload as Record<string, unknown>;
    expect(payload.kind).toBe(EXPERIMENT_KIND);
    expect(payload.baselineSweepRun).toBe(3);
    // The thresholds travel with the promise: a settler must never have to
    // reread the file, which is exactly what an edit after mint would change.
    expect(payload.metrics).toEqual({
      q05PinballRatio: { improveIfDeltaAtMost: -0.03 },
      meanPinball: { regressIfDeltaAbove: 0.01 },
    });
  });

  it("skips every id the ledger already holds", () => {
    const experiments = loadExperiments();
    const minted = new Set(experiments.map((e) => String(e.id)));
    expect(commitmentDrafts(experiments, minted)).toEqual([]);
    const [first] = minted;
    expect(
      commitmentDrafts(experiments, new Set([first])).map((d) => d.id),
    ).not.toContain(first);
  });

  it("renders text and mints against an empty state root", () => {
    process.env.HELIUM_STATE_ROOT = mkdtempSync(join(tmpdir(), "helium-self-"));
    const out = render(REPORT, SPEC);
    expect(out.commitments?.map((draft) => draft.id)).toContain(
      "2026-09-06-density-arm-h",
    );
    expect(out.text).toContain("2026-09-06-density-arm-h");
    expect(out.text).toContain("restated.");
  });
});
