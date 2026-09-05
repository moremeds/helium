import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import {
  EvidenceFile,
  evidencePath,
  type EvidenceHeader,
} from "../src/evidence.js";

const header: EvidenceHeader = {
  runId: "run-1",
  tenant: "fake-tenant",
  day: "2026-09-05",
  phase: "premarket",
  deployment: "test",
  variant: "live",
  startedAt: "2026-09-05T00:00:00Z",
  codeSha: "abc1234",
  dshVersion: "0.1.2-alpha.3",
  teamYamlSha256: "a".repeat(64),
  tenantYamlSha256: "b".repeat(64),
  toolIo: "/state/runs/run-1/tool-io/",
};

function report(steps: RunReport["steps"]): RunReport {
  return {
    runId: "run-1",
    tenant: "fake-tenant",
    mode: "model",
    phase: "premarket",
    day: "2026-09-05",
    providersLive: ["p"],
    providersSkipped: [],
    steps,
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  };
}

describe("evidence file", () => {
  it("names the file <tenant>-<day>-<phase>-<runId>.json under evidence/", () => {
    expect(
      evidencePath("/s", "fake-tenant", "2026-09-05", "premarket", "run-1"),
    ).toBe("/s/evidence/fake-tenant-2026-09-05-premarket-run-1.json");
  });

  it("writes the header before any step exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    new EvidenceFile(path, header);
    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      run: EvidenceHeader;
      steps: unknown[];
    };
    expect(doc.run.toolIo).toBe("/state/runs/run-1/tool-io/");
    expect(doc.steps).toEqual([]);
  });

  it("carries the assembled prompt onto each step by task id", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(
      report([
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: "out",
          targetId: "m1",
        },
      ]),
      new Map([["regime", "CLOCK\n\nBUDGET\n\nask"]]),
    );
    const doc = file.read();
    expect(doc.steps[0]).toMatchObject({
      task: "regime",
      role: "regime-analyst",
      mode: "model",
      model: "m1",
      output: "out",
      assembledPrompt: "CLOCK\n\nBUDGET\n\nask",
    });
  });

  it("a run killed after step 3 leaves three steps on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    const steps: RunReport["steps"] = [];
    for (const task of ["a", "b", "c"]) {
      steps.push({ task, role: "r", mode: "model", text: `t-${task}` });
      file.sync(report([...steps]), new Map());
    }
    // Nothing further is written — the process "dies" here.
    const doc = JSON.parse(readFileSync(path, "utf8")) as { steps: unknown[] };
    expect(doc.steps).toHaveLength(3);
  });

  it("keeps gate results and drops nothing a refusal recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(
      report([
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: "",
          failure: "gate-refused",
          gateRefusals: [{ id: "as-of-verbatim", reason: "invented" }],
        },
      ]),
      new Map(),
    );
    expect(file.read().steps[0]!.gateResults).toEqual([
      { id: "as-of-verbatim", reason: "invented" },
    ]);
  });

  it("stores the rendered view opaquely", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(report([]), new Map(), { schemaVersion: 2, anything: [1, 2] });
    expect(file.read().view).toEqual({ schemaVersion: 2, anything: [1, 2] });
  });
});
