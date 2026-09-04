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
import { parseTeamYaml, topologicalOrder } from "@helium/core";
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

  it("no longer claims the credit and policy layers have no tool", () => {
    // ow_macro_rates carries HY OAS and ow_argon_policy_path the hike
    // probabilities; a persona still saying "NO TOOL" would make a role write
    // `skipped` over data it was handed.
    expect(manifest.roles["regime-analyst"]?.persona ?? "").not.toContain(
      "NO TOOL",
    );
  });

  it("drift reads this morning's own report", () => {
    const prompt = task("drift")?.prompt ?? "";
    expect(prompt).toContain("phase:premarket");
    expect(prompt).toContain("无变化");
  });
});

describe("close settles the day it just watched", () => {
  const task = (id: string) => manifest.tasks.find((t) => t.id === id);

  it("markout settles today's own calls against their own levels", () => {
    // It used to read days:2 phase:close and days:8 phase:weekly — a fixed
    // window, which can never contain this morning's report.
    const prompt = task("markout")?.prompt ?? "";
    expect(prompt).toContain("phase:premarket");
    expect(prompt).toContain("phase:intraday");
    expect(prompt).toContain("invalidation");
    expect(prompt).toContain("平仓建议");
  });

  it("markout may settle only ids the tool returned", () => {
    // 2026-09-02 close: markout reported six intraday theses settled — MSFT
    // 505/510, AVGO 375/385, IWM 290/285, TLT 82/81.5 — against a premarket
    // that proposed none of them. Every one of those tickers appears in that
    // report's GEX table, which is what survived the tool-output cut. Handed a
    // ticker table and told to settle proposals, it settled the ticker table,
    // and recap carried it into the delivered mail verbatim.
    const prompt = task("markout")?.prompt ?? "";
    expect(prompt).toContain("ONLY ids the tool returned");
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
  for (const id of ["scenarios", "weekly", "frank", "drift", "recap"]) {
    const prompt = manifest.tasks.find((t) => t.id === id)?.prompt ?? "";
    expect(prompt, id).toContain('{"sections":[{"title","body"}]}');
  }
  // regime's reply is no longer JUST a sections object: the 2026-09-03
  // newsletter redesign has it also emit `headline`, `tape` and `schedule` —
  // the fields the masthead, tape strip and today's-schedule section render
  // from — so its `sections` key sits inside a larger object rather than at
  // the top. The tail of the same shape is still the load-bearing part: one
  // `sections` array of `{title, body}` entries, checked here without the
  // leading brace that no longer immediately precedes it.
  const regimePrompt =
    manifest.tasks.find((t) => t.id === "regime")?.prompt ?? "";
  expect(regimePrompt).toContain('"sections":[{"title","body"}]}');
  expect(regimePrompt).toContain('"headline"');
  expect(regimePrompt).toContain('"tape":[...]');
  expect(regimePrompt).toContain('"schedule":[...]');
});

it("markout settles by id, in four states, so the renderer can check it", () => {
  // Free prose cannot be gated: the 2026-09-02 close mail settled six theses
  // that were never proposed and nothing in the pipeline could tell. A settled
  // id is checkable against the ledger ow_reports returned; a sentence is not.
  const prompt = manifest.tasks.find((t) => t.id === "markout")?.prompt ?? "";
  expect(prompt).toContain(
    '{"settlements":[{"id","ticker","state","note"}],"sections":[{"title","body"}]}',
  );
  // 未触发 is the state the three-state prompt had no room for, so a thesis
  // whose entry never filled was written up as 加强 or 反转 — a judgement about
  // a position that does not exist.
  for (const state of ["反转", "加强", "不变", "未触发"])
    expect(prompt, state).toContain(state);
});

it("the two judgement steps declare reason.deep on the TASK, which is what routes", () => {
  // The router prices `task.requires`, not `role.requires` (runner.ts builds
  // the WorkOrder from the task). `design` declared `[structured.output]`
  // alone and the cheapest structured-output model won it every time — 24 of
  // 42 runs proposed strikes with no ow_spot call and landed 15-84% off spot.
  // The roles already declared reason.deep; the tasks did not, and only the
  // task is read.
  for (const id of ["design", "review"]) {
    const task = manifest.tasks.find((t) => t.id === id);
    expect(task?.requires ?? [], id).toContain("reason.deep");
    // The manifest is only self-consistent if the role can serve what the
    // task asks for; parseTeamYaml enforces it, and this names the reason.
    expect(manifest.roles[task!.role]?.requires ?? [], id).toContain(
      "reason.deep",
    );
  }
});

it("the settlement level is demanded where a proposal is born, not only where it is checked", () => {
  // 2026-09-02 premarket: the contract lived only in the review prompt, the
  // designer emitted nothing, and the reviewer correctly dropped all eight
  // proposals — eight identical rejections. A field is demanded where it
  // originates.
  //
  // What is demanded changed on 2026-09-03. `horizon` asked for one of three
  // words and got `multiday` thirteen times out of thirteen: the model took
  // the value with the least resistance, the close run's three-state
  // settlement degraded to "not due yet", and the field carried no
  // information. A level and a side cannot be shrugged at the same way, and
  // unlike a word it can be checked against a spot.
  for (const id of ["design", "review"])
    expect(manifest.tasks.find((t) => t.id === id)?.prompt ?? "", id).toContain(
      '"side": "above"|"below"',
    );
});

describe("the editor is one author over seven fragments", () => {
  const task = manifest.tasks.find((entry) => entry.id === "edit");

  it("routes on reason.deep, declared on the TASK — which is what the router prices", () => {
    // Same reason `design` and `review` name it: runner.ts builds the
    // WorkOrder from `task.requires`, so a judgement step that declares only
    // the cheap capability is routed to the cheap model. Writing the whole
    // brief in one pass is the deepest reasoning step in the run.
    expect(task?.requires ?? []).toContain("reason.deep");
    expect(task?.requires ?? []).toContain("long.context");
    expect(manifest.roles.editor?.requires ?? []).toContain("reason.deep");
    expect(manifest.roles.editor?.requires ?? []).toContain("long.context");
  });

  it("runs last, after every step whose output it edits", () => {
    // `dependsOn` is what FEEDS it: runner.ts forwards each named step's whole
    // output into the prompt, so this list is the editor's desk. An editor
    // missing a dependency is an author who never saw a chapter.
    // All three daily phases: intraday shipped eight raw sections and close
    // seven on 2026-09-03 because neither had an author. Weekly and frank
    // already have a single author each and are out of scope.
    expect(task?.phases).toEqual(["premarket", "intraday", "close"]);
    expect(task?.phases).not.toContain("weekly");
    expect(task?.phases).not.toContain("frank");
    // Phase-scoped dependencies are safe: a task whose phase does not match
    // produces no text, and handoff drops dependencies with no text.
    expect(task?.dependsOn ?? []).toEqual([
      "universe",
      "gex",
      "markout",
      "overnight",
      "regime",
      "scenarios",
      "design",
      "review",
      "drift",
      "recap",
    ]);
    const ids = new Set(manifest.tasks.map((entry) => entry.id));
    for (const dependency of task?.dependsOn ?? [])
      expect(ids.has(dependency), dependency).toBe(true);
    const order = topologicalOrder(manifest);
    for (const dependency of task?.dependsOn ?? [])
      expect(order.indexOf(dependency), dependency).toBeLessThan(
        order.indexOf("edit"),
      );
  });

  it("carries the style exemplar in the TASK prompt, where the 4000-char cap is not", () => {
    // TeamRoleSchema caps `persona` at 4000 characters and TeamTaskSchema caps
    // `prompt` at 20000. The exemplar is the approved mockup's own prose and
    // does not fit in a persona, so it lives in the prompt — and the persona
    // has to stay under its cap for parseTeamYaml to accept the file at all.
    expect((manifest.roles.editor?.persona ?? "").length).toBeLessThanOrEqual(
      4000,
    );
    const prompt = task?.prompt ?? "";
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain("STYLE EXEMPLAR");
    expect(prompt).toContain("Rates are still the first cause");
  });

  it("forbids the editor every number on a candidate except the words around it", () => {
    const prompt = task?.prompt ?? "";
    expect(prompt).toContain(
      "`candidates` entries carry ONLY `id` and `rationale`",
    );
    expect(prompt).toContain("cannot be changed here");
    // The three rules the brief is judged on.
    expect(prompt).toContain("what CHANGED");
    expect(prompt).toContain("No filler sentence");
    // The word budget replaced the flat 120-words-per-section cap on
    // 2026-09-04; since the flash-format change it is a statement of what the
    // renderer does (render/budget.ts), not a request — the prompt must say
    // so, or the model writes past a cut it does not know is coming.
    expect(prompt).toContain("enforced by the renderer");
    expect(prompt).toContain("60 words");
    expect(prompt).toContain("at most FIVE");
    expect(prompt).toContain("never an HTTP status code in prose");
  });

  it("reads yesterday's brief, and only through the tool that caps it", () => {
    expect(manifest.roles.editor?.permissions.tools).toEqual([
      "ow_prior_brief",
    ]);
    const prompt = task?.prompt ?? "";
    expect(prompt).toContain("ow_prior_brief");
    // A day with no prior report is one line, not a silent gap.
    expect(prompt).toContain("prior:null");
  });
});
