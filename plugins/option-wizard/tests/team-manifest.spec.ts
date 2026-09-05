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
import flashBudget from "../gates/flash-budget.js";

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
});

describe("phase remits", () => {
  const task = (id: string) => manifest.tasks.find((t) => t.id === id);
  const runsIn = (id: string, phase: string) =>
    task(id)?.phases?.includes(phase) ?? true;

  it("intraday does not design or review", () => {
    // Leaving a design step in intraday is what made the model produce a
    // fresh set of trades every run: hand it a design task and it will
    // design something, whether or not anything moved.
    expect(runsIn("design", "intraday")).toBe(false);
    expect(runsIn("review", "intraday")).toBe(false);
  });

  it("no longer claims the credit and policy layers have no tool", () => {
    // ow_macro_rates carries HY OAS and ow_argon_policy_path the hike
    // probabilities; a persona still saying "NO TOOL" would make a role write
    // `skipped` over data it was handed.
    expect(manifest.roles["regime-analyst"]?.persona ?? "").not.toContain(
      "NO TOOL",
    );
  });
});

it("every narrative task replies as one sections JSON", () => {
  // The renderer shows the blocks a run produced. A task that answers in
  // prose contributes nothing to the mail — which is exactly how a premarket
  // run that had written four regime sections and four scenario paths
  // delivered a brief with one paragraph in it.
  for (const id of ["scenarios", "weekly", "frank"]) {
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
      "overnight",
      "regime",
      "scenarios",
      "design",
      "review",
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
    // The exemplar's masthead is a NAMED cause carrying that day's number, not
    // a fixed opening phrase. "Rates are (still) the first cause" was the
    // fixed phrase; it shipped as the masthead every day until it was cut.
    expect(prompt).toContain(
      "A bear-steepener took the 10Y to 4.788%. No candidate ships today.",
    );
    expect(prompt).not.toContain("first cause");
  });

  it("does not force the regime step into a fixed first-cause title", () => {
    // The persona used to hardcode four numbered sections, the first titled
    // "Rates are the first cause"; the model then wrote filler for the tags
    // that did not apply. Sections are now the model's own claim, and an
    // inapplicable one is omitted rather than explained away.
    const persona = manifest.roles["regime-analyst"]?.persona ?? "";
    expect(persona).not.toContain("first cause");
    expect(persona).toContain("NAME the one input that moved today's tape");
    expect(persona).toContain("OMITTED");
    // Rates stay a mandatory datapoint even when they are not the cause.
    expect(persona).toContain("MANDATORY datapoint");
    // The renderer's trim has to be stated, or the model writes past it.
    expect(persona).toContain("60 words");
    expect(persona).toContain("You do not propose trades.");
    expect(persona.length).toBeLessThanOrEqual(4000);
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

it("carries no settlement ceremony: no markout, no drift, no recap", () => {
  // Candidate selection is moving to its own team and settlement is the
  // Outcome Ledger's job. Until then these three steps spent one section per
  // run saying "nothing to settle", and the recap step wrote Chinese titles
  // into an English brief. The tools stay registered; only the steps go.
  const ids = manifest.tasks.map((entry) => entry.id);
  for (const gone of ["markout", "drift", "recap"])
    expect(ids, gone).not.toContain(gone);
  for (const gone of ["markout-clerk", "drift-watcher", "recap-writer"])
    expect(Object.keys(manifest.roles), gone).not.toContain(gone);
});

it("asks no step for a CJK section title", () => {
  // The delivered brief is English. 今日故事 / 今日市场 / 无变化 were section
  // titles the manifest DEMANDED, so no persona rule could keep them out.
  const prompts = manifest.tasks.map((entry) => entry.prompt ?? "").join("\n");
  for (const title of ["今日故事", "今日市场", "无变化"])
    expect(prompts, title).not.toContain(title);
});

it("no task depends on a step that no longer exists", () => {
  const ids = new Set(manifest.tasks.map((entry) => entry.id));
  for (const entry of manifest.tasks)
    for (const dependency of entry.dependsOn ?? [])
      expect(ids.has(dependency), `${entry.id} -> ${dependency}`).toBe(true);
});

it("no prompt asks ow_reports for a step id that no longer exists", () => {
  // `weekly` used to read steps:["markout","recap"]. Those files will never
  // contain those headings again, so the tool would return nothing and the
  // week would be written from an empty page.
  const prompts = manifest.tasks.map((entry) => entry.prompt ?? "").join("\n");
  for (const gone of ['"markout"', '"drift"', '"recap"'])
    expect(prompts, gone).not.toContain(gone);
});

it("flash-budget guards only roles that still exist", () => {
  for (const role of flashBudget.appliesTo)
    expect(Object.keys(manifest.roles), role).toContain(role);
});

it("asks the regime analyst for a regime-state block with the six schema fields", () => {
  const persona = manifest.roles["regime-analyst"]?.persona ?? "";
  expect(persona).toContain("regime-state");
  for (const field of ["cause", "ust2y", "ust10y", "s2s10", "tide", "thesis"])
    expect(persona, field).toContain(field);
});

it("keeps every persona inside the 4000-character cap core enforces", () => {
  // packages/core/src/team.ts:44. A persona over the cap does not degrade —
  // parseTeamYaml throws and the tenant is skipped with a recorded reason, so
  // the day produces no brief at all.
  for (const [name, role] of Object.entries(manifest.roles))
    expect((role.persona ?? "").length, name).toBeLessThanOrEqual(4000);
});

it("tells the editor to compare regimeState rather than re-read the brief", () => {
  const persona = manifest.roles.editor?.persona ?? "";
  expect(persona).toContain("regimeState");
  expect(persona).toContain("delta");
});

describe("the weekly review", () => {
  it("runs in the weekly phase and adds no sixth phase", () => {
    // A sixth phase costs a sixth launchd plist, a sixth triggers entry, a
    // sixth argon `kinds` entry and a recount of maxPerDay (tenant.yaml
    // :150-166, peak 4 of 5). The Sunday run is already after Friday's close.
    const task = manifest.tasks.find((entry) => entry.id === "week-review");
    expect(task).toBeDefined();
    expect(task?.phases).toEqual(["weekly"]);
    const phases = new Set(
      manifest.tasks.flatMap((entry) => entry.phases ?? []),
    );
    expect([...phases].sort()).toEqual([
      "close",
      "frank",
      "intraday",
      "premarket",
      "weekly",
    ]);
  });

  it("does not collide with the pre-flight `review` step", () => {
    const ids = manifest.tasks.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("review");
    expect(ids).toContain("week-review");
  });

  it("gives the reviewer ow_review_window and nothing live", () => {
    expect(manifest.roles["week-reviewer"]?.permissions.tools).toEqual([
      "ow_review_window",
    ]);
    expect(manifest.roles["week-reviewer"]?.permissions.mutations).toBe(
      "forbidden",
    );
  });

  it("names the three windows in the prompt and forbids arithmetic", () => {
    const task = manifest.tasks.find((entry) => entry.id === "week-review");
    for (const window of ["5", "10", "21"])
      expect(task?.prompt ?? "", window).toContain(window);
    expect(task?.prompt ?? "").toContain("never compute");
  });
});
