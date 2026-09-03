/**
 * `team.yaml` is the five-phase manifest (spec
 * `docs/superpowers/specs/2026-09-03-option-wizard-prompt-design.md`). These
 * checks are the structural half of doctrine 3 (a role declares capabilities,
 * never a model) and the global constraint that no position size ever enters
 * a proposal — the parts a human reviewing the YAML by eye would otherwise
 * have to re-verify on every edit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTeamYaml } from "@helium/core";
import { VOCABULARY } from "../tools/index.js";

const TEAM = join(__dirname, "..", "team.yaml");
const raw = readFileSync(TEAM, "utf8");
const manifest = parseTeamYaml(raw);

describe("option-wizard team.yaml", () => {
  it("parses as a valid team manifest", () => {
    expect(manifest.name).toBe("option-wizard");
    expect(manifest.tasks.length).toBeGreaterThan(0);
  });

  it("names no model or vendor — a role routes by capability only (doctrine 3)", () => {
    // parseTeamYaml already rejects provider:/model:/effort: as routing keys;
    // this additionally guards against a vendor name slipping into a raw
    // scalar (e.g. `tools: [claude]`) that the schema would not catch.
    const vendorNames = /\b(claude|gpt-|deepseek|codex|opus|sonnet|haiku)\b/i;
    for (const line of raw.split("\n")) {
      if (vendorNames.test(line)) {
        throw new Error(`vendor name found outside prose: ${line}`);
      }
    }
  });

  it("never declares a quantity or position-size field", () => {
    // The shared preamble and several personas use the word "quantity" in
    // the sentence that FORBIDS a size field ("No quantity, no position
    // size."). Asserting on that prose would fail on the ban itself, so this
    // checks the thing a size leak would actually look like: a `quantity`
    // key in the proposal JSON shape, or a `quantity:` field anywhere.
    expect(raw).not.toMatch(/"quantity"/);
    expect(raw).not.toMatch(/\bquantity\s*:/i);
  });

  it("every task's tools exist in the tool VOCABULARY", () => {
    for (const [roleName, role] of Object.entries(manifest.roles)) {
      for (const tool of role.permissions.tools) {
        expect(
          VOCABULARY.has(tool),
          `role ${roleName} names unknown tool ${tool}`,
        ).toBe(true);
      }
    }
  });

  it("each phase selects a non-empty task set", () => {
    for (const phase of ["premarket", "intraday", "close", "weekly", "frank"]) {
      const chosen = manifest.tasks.filter(
        (task) => task.phases === undefined || task.phases.includes(phase),
      );
      expect(chosen.length, `phase ${phase} selects no tasks`).toBeGreaterThan(
        0,
      );
    }
  });

  it("close includes markout and weekly does not", () => {
    const closeTasks = manifest.tasks
      .filter(
        (task) => task.phases === undefined || task.phases.includes("close"),
      )
      .map((task) => task.id);
    const weeklyTasks = manifest.tasks
      .filter(
        (task) => task.phases === undefined || task.phases.includes("weekly"),
      )
      .map((task) => task.id);
    expect(closeTasks).toContain("markout");
    expect(weeklyTasks).not.toContain("markout");
  });
});

describe("phase remits", () => {
  const task = (id: string) => manifest.tasks.find((t) => t.id === id);
  const runsIn = (id: string, phase: string) =>
    task(id)?.phases?.includes(phase) ?? true;

  it("intraday does not design or review — it only checks drift", () => {
    // Leaving a design step in intraday is what made the model produce a
    // fresh set of trades every run: hand it a design task and it will
    // design something, whether or not anything moved.
    expect(runsIn("design", "intraday")).toBe(false);
    expect(runsIn("review", "intraday")).toBe(false);
    expect(runsIn("drift", "intraday")).toBe(true);
    expect(task("drift")?.phases).toEqual(["intraday"]);
  });

  it("drift reads this morning's own report", () => {
    const prompt = task("drift")?.prompt ?? "";
    expect(prompt).toContain("phase:premarket");
    expect(prompt).toContain("无变化");
  });
});

describe("close settles the day it just watched", () => {
  const task = (id: string) => manifest.tasks.find((t) => t.id === id);

  it("markout settles today's own calls, by horizon", () => {
    // It used to read days:2 phase:close and days:8 phase:weekly — a fixed
    // window, which can never contain this morning's report no matter what
    // horizon a thesis declared.
    const prompt = task("markout")?.prompt ?? "";
    expect(prompt).toContain("phase:premarket");
    expect(prompt).toContain("phase:intraday");
    expect(prompt).toContain("horizon");
    expect(prompt).toContain("平仓建议");
  });

  it("close writes today's story", () => {
    expect(task("recap")?.phases).toEqual(["close"]);
    const prompt = task("recap")?.prompt ?? "";
    expect(prompt).toContain("今日故事");
    expect(prompt).toContain("今日市场");
  });
});

it("every narrative task replies as one sections JSON", () => {
  // The renderer shows the blocks a run produced. A task that answers in
  // prose contributes nothing to the mail — which is exactly how a premarket
  // run that had written four regime sections and four scenario paths
  // delivered a brief with one paragraph in it.
  for (const id of ["regime", "scenarios", "weekly", "frank", "drift", "markout", "recap"]) {
    const prompt = manifest.tasks.find((t) => t.id === id)?.prompt ?? "";
    expect(prompt, id).toContain('{"sections":[{"title","body"}]}');
  }
});
