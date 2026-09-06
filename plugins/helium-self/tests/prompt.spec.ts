/**
 * The one thing that can rot silently here: the experiment file is the source
 * of truth for the thresholds, but the model step is handed the declaration
 * INLINE (the role has no tools and cannot open a file). Two copies of one
 * sentence drift; this test is what makes them drift loudly.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExperiments } from "../render/index.js";

const TENANT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const team = readFileSync(join(TENANT_DIR, "team.yaml"), "utf8");

describe("helium-self team prompt", () => {
  it("quotes every declared experiment's hypothesis and rule verbatim", () => {
    const experiments = loadExperiments();
    expect(experiments.length).toBeGreaterThan(0);
    for (const experiment of experiments) {
      expect(team).toContain(String(experiment.hypothesis));
      expect(team).toContain(String(experiment.rule));
    }
  });

  it("names no model and no vendor", () => {
    expect(team).not.toMatch(/claude|codex|deepseek|gpt|haiku|sonnet|opus/i);
  });
});
