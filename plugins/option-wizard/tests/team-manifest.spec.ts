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
import { parseTeamYaml, parseTenantYaml, topologicalOrder } from "@helium/core";
import { VOCABULARY } from "../tools/index.js";
import flashBudget from "../gates/flash-budget.js";
import { coverageRowIds, parseReviewConfig } from "../quality/review-config.js";

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

  it("forbids the gex step from asking the reader a question", () => {
    // 2026-09-03 close: ow_tv_watchlist and ow_ib_positions were unavailable
    // as-of, and the step wrote "To proceed, I need clarification: Should
    // I…" straight into the brief. Nobody is on the other end of that step;
    // its output is copied into the mail as it stands.
    const persona = manifest.roles["gex-reporter"]?.persona ?? "";
    expect(persona).toContain("You never ask a question");
    // The two fallbacks, in order: SPY and QQQ from the gex tool alone, then
    // one line and nothing else.
    expect(persona).toContain("SPY and QQQ");
    expect(persona).toContain("GEX: unavailable —");
    expect(persona.length).toBeLessThanOrEqual(4000);
  });
});

it("every narrative task replies as one sections JSON", () => {
  // The renderer shows the blocks a run produced. A task that answers in
  // prose contributes nothing to the mail — which is exactly how a premarket
  // run that had written four regime sections and four scenario paths
  // delivered a brief with one paragraph in it.
  // `weekly` left this list on 2026-09-06: it now returns the REVIEW document
  // (`review`/`outlook`/`catalysts`/`coverage`/`focus`/`themes`), and the seven
  // section titles are the renderer's, not the model's.
  for (const id of ["frank"]) {
    const prompt = manifest.tasks.find((t) => t.id === id)?.prompt ?? "";
    expect(prompt, id).toContain('{"sections":[{"title","body"}]}');
  }
  expect(manifest.tasks.find((t) => t.id === "weekly")?.prompt ?? "").toContain(
    '"coverage":[{"id","token","p","why","observable"}]',
  );
  // `scenarios` is the second task whose reply is no longer JUST a sections
  // object: it also states the scored `spyForecast`, so its `sections` key
  // opens a larger object. Same check as `regime` below — the load-bearing
  // part is the array of `{title, body}`, not the brace that used to close
  // the object immediately after it.
  const scenariosPrompt =
    manifest.tasks.find((t) => t.id === "scenarios")?.prompt ?? "";
  expect(scenariosPrompt).toContain('{"sections":[{"title","body"}],');
  expect(scenariosPrompt).toContain('"spyForecast"');
  expect(scenariosPrompt).toContain('"referenceClose"');
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
      "frame",
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
    // The 2.5 KB five-section STYLE EXEMPLAR was replaced by brief-craft.md's
    // blueprint, which is the shape of the document this PR actually ships.
    expect(prompt).toContain("BLUEPRINT");
    expect(prompt).not.toContain("STYLE EXEMPLAR");
    // The exemplar's masthead is a NAMED cause carrying that day's number, not
    // a fixed opening phrase. "Rates are (still) the first cause" was the
    // fixed phrase; it shipped as the masthead every day until it was cut.
    expect(prompt).toContain(
      "Volatility fell 1.14 points on the day the 10-year ground to",
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
    // The "MANDATORY datapoint" rule was DELETED on 2026-09-06: it guaranteed
    // rates prose on days rates did nothing, and it produced "Rates are the
    // story" three sessions running. The ranked list decides instead.
    expect(persona).not.toContain("MANDATORY datapoint");
    expect(persona).toContain("including material news and earnings");
    // The renderer's trim has to be stated, or the model writes past it — but
    // the flat 60-word cap is gone with it; the per-field caps live in the
    // prompt and in render/budget.ts.
    expect(persona).toContain("the renderer enforces it, not you");
    expect(persona).toContain("You do not propose trades.");
    expect(persona.length).toBeLessThanOrEqual(4000);
  });

  it("forbids the editor every number on a candidate except the words around it", () => {
    const prompt = task?.prompt ?? "";
    expect(prompt).toContain(
      "`candidates` entries carry ONLY `id` and `rationale`",
    );
    expect(prompt).toContain("cannot be changed here");
    // The three rules the brief is judged on. "Say what CHANGED, not what IS"
    // was deleted: it asked for a delta the model had to work out. The delta is
    // now handed to it in the frame's `move` field, and the rule says so.
    expect(prompt).not.toContain("what CHANGED");
    expect(prompt).toContain("The delta is handed to you");
    expect(prompt).toContain("No filler");
    // The word budget replaced the flat 120-words-per-section cap on
    // 2026-09-04; since the flash-format change it is a statement of what the
    // renderer does (render/budget.ts), not a request — the prompt must say
    // so, or the model writes past a cut it does not know is coming.
    expect(prompt).toContain("enforced by the renderer");
    // Per-FIELD caps replaced the flat 60-words-per-section and the
    // five-section ceiling on 2026-09-06: the document is seven fixed sections
    // plus the lead item, so "choose the five that matter" had nothing left to
    // choose from.
    expect(prompt).toContain("`oneThing`: 180 words");
    expect(prompt).toContain("`everythingElse`: 5 lines of 12 words");
    expect(prompt).toContain("never an HTTP status code in prose");
  });

  it("forbids inventing a book on a session that produced none", () => {
    // 2026-09-03 close: design returned `proposals: []` and review returned
    // `proposals: []` and `riskList: []` — no structure was ever priced. The
    // editor still wrote "Every structure priced strikes against levels far
    // from where SPY actually close…", "Reject the book…" and "the arithmetic
    // gate failed on every leg". None of that happened.
    const persona = manifest.roles.editor?.persona ?? "";
    expect(persona).toContain("WHEN THERE IS NO BOOK");
    expect(persona).toContain("No book this session —");
    expect(persona).toContain("`none`");
    expect(persona).toContain("`n/a`");
    // The three things the invented decision block described.
    expect(persona).toContain("strikes, legs");
    expect(persona.length).toBeLessThanOrEqual(4000);
    // Stated in the prompt too, where the decision-block rules are.
    expect(task?.prompt ?? "").toContain("there is no book to describe");
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

it("asks the EDITOR for the regime-state block, and asks nobody else", () => {
  // The record moved off the regime analyst on 2026-09-06: the runner lifts a
  // fence from every step and a later one overwrites an earlier one, so the
  // block belongs to the last step that knows the three checks the next run
  // scores. Two authors would mean the analyst's record is silently discarded.
  const prompt =
    manifest.tasks.find((task) => task.id === "edit")?.prompt ?? "";
  expect(prompt).toContain("regime-state");
  for (const field of [
    "cause",
    "ust2y",
    "ust10y",
    "s2s10",
    "tide",
    "thesis",
    "checks",
    "invalidation",
  ])
    expect(prompt, field).toContain(field);
  expect(manifest.roles["regime-analyst"]?.persona ?? "").not.toContain(
    "regime-state",
  );
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

describe("the flash page is public — no role reads the book", () => {
  it("no role can read positions", () => {
    // The argon /flash page is public (user, 2026-09-06). team.yaml already
    // forbids quantity, size and account value in prose, but a HELD TICKER NAME
    // is itself private and a prompt is never a permission boundary
    // (AGENTS.md, Safety model). The tool is removed from every role rather
    // than gated at render time: a gate would require the renderer to hold the
    // positions list, one step closer to `data: view`, which argon persists.
    for (const [name, role] of Object.entries(manifest.roles))
      expect(role.permissions.tools ?? [], name).not.toContain(
        "ow_ib_positions",
      );
  });

  it("no prompt still asks a role to merge in open positions", () => {
    const text = manifest.tasks.map((t) => t.prompt ?? "").join("\n");
    expect(text).not.toContain("open IB positions");
    expect(text).not.toContain("carries an open position");
  });

  it("the universe is built from the watchlists and the tickers of interest", () => {
    expect(manifest.roles["universe-builder"]?.permissions.tools).toEqual([
      "ow_tv_watchlist",
      "ow_argon_watchlist",
      "ow_spot",
    ]);
    const universe =
      manifest.tasks.find((t) => t.id === "universe")?.prompt ?? "";
    expect(universe).toContain("tickers of interest");
  });

  it("frames the session in a deterministic step, not in a model", () => {
    // Eight of eleven model-computed numbers audited on 2026-09-03 were wrong.
    // `requires: []` is the manifest saying, in core's own vocabulary, that no
    // model is routed for this step.
    expect(manifest.tasks.find((e) => e.id === "frame")?.requires).toEqual([]);
    expect(manifest.roles["frame-clerk"]?.requires).toEqual([]);
    expect(manifest.roles["frame-clerk"]?.permissions.tools).toContain(
      "ow_session_frame",
    );
  });

  it("every author of a review section sees the same frame", () => {
    for (const id of ["regime", "edit", "weekly", "week-review"])
      expect(manifest.tasks.find((e) => e.id === id)?.dependsOn, id).toContain(
        "frame",
      );
  });

  it("prices the rotation table once a week, in a deterministic step", () => {
    // 12 + N ow_apex_bars calls is a weekly cost, not a daily one, and the
    // MANIFEST is where that belongs: the renderer may not learn a phase and
    // the tool is handed {}.
    const rotation = manifest.tasks.find((e) => e.id === "rotation");
    expect(rotation?.requires).toEqual([]);
    expect(rotation?.phases).toEqual(["weekly"]);
    expect(rotation?.dependsOn).toContain("frame");
    expect(manifest.roles["frame-clerk"]?.permissions.tools).toEqual([
      "ow_session_frame",
      "ow_rotation",
    ]);
    expect(manifest.tasks.find((e) => e.id === "weekly")?.dependsOn).toContain(
      "rotation",
    );
  });

  it("no persona or prompt speaks of positions or holdings outside a ban clause", () => {
    // `position`, `held` and `holding` may appear ONLY inside an explicit
    // "Never …" / "never a …" ban sentence — that is the one place the words
    // have to appear in order to forbid themselves.
    const lines = [
      ...Object.values(manifest.roles).flatMap((r) =>
        (r.persona ?? "").split("\n"),
      ),
      ...manifest.tasks.flatMap((t) => (t.prompt ?? "").split("\n")),
    ];
    for (const line of lines) {
      if (/never/iu.test(line)) continue;
      expect(line.toLowerCase(), line).not.toMatch(
        /\b(position|held|holding)\b/u,
      );
    }
  });
});

/**
 * The rewritten personas and prompts (Task 15).
 *
 * These are REWRITES, not appends: a persona that carried both "choose the
 * five that matter" and "print every row" is a persona the model obeys
 * whichever half it read last. Measured, not eyeballed — the 2026-09-05
 * rewrite came within 580 characters of `TeamRoleSchema.persona`'s 4000 cap.
 */
describe("the review authors, rewritten", () => {
  it("every persona fits the 4000-character cap, and the rewritten ones with room to spare", () => {
    // Measured, not eyeballed: the 2026-09-05 rewrite came within 580
    // characters of `TeamRoleSchema.persona`'s 4000 cap, and a persona over it
    // does not degrade — parseTeamYaml throws and the tenant is skipped.
    for (const [name, role] of Object.entries(manifest.roles))
      expect((role.persona ?? "").length, name).toBeLessThanOrEqual(4000);
    // The five this PR rewrote are held to 3800. `structure-designer` is 3987
    // and is NOT rewritten here: trimming it would change design behaviour
    // outside this change, and it is recorded rather than quietly relaxed.
    for (const name of [
      "regime-analyst",
      "scenario-analyst",
      "weekly-analyst",
      "week-reviewer",
      "editor",
    ])
      expect((manifest.roles[name]?.persona ?? "").length, name).toBeLessThan(
        3800,
      );
  });

  it("every prompt fits the 20000-character cap", () => {
    for (const task of manifest.tasks)
      expect((task.prompt ?? "").length, task.id).toBeLessThan(20000);
  });

  it("no persona or prompt still asks for the deleted formats", () => {
    const text = [
      ...Object.values(manifest.roles).map((role) => role.persona ?? ""),
      ...manifest.tasks.map((task) => task.prompt ?? ""),
    ].join("\n");
    for (const gone of [
      "choose the five that matter",
      "Choose the five that matter",
      "At most FIVE sections",
      "at most FIVE",
      "Layer Coverage",
      "MANDATORY datapoint",
      "BEAT-AND-RAISE",
      "Say what CHANGED",
      "settle each of the week's numbered calls by name",
    ])
      expect(text, gone).not.toContain(gone);
  });

  it("exactly one role is asked for the regime-state fence, and it is the editor", () => {
    // `liftState` runs on EVERY step and a later fence overwrites an earlier
    // one, so two authors would silently race.
    const authors = Object.entries(manifest.roles)
      .filter(([, role]) => (role.persona ?? "").includes("regime-state"))
      .map(([name]) => name);
    expect(authors).toEqual(["editor"]);
  });

  it.each(["team.yaml", "team.C.yaml", "team.C-nonews.yaml"])(
    "%s keeps the public market weekly separate from internal evaluation",
    (name) => {
      const variant = parseTeamYaml(readFileSync(join(__dirname, "..", name), "utf8"));
      const weekly = variant.tasks.find((task) => task.id === "weekly")!;
      expect(weekly.requires).toContain("reason.deep");
      expect(weekly.prompt).toContain("MARKET WEEK");
      expect(weekly.prompt).toContain("no own-performance section");
      expect(weekly.prompt).toContain("omit `p` and `observable`");
      expect(weekly.prompt).not.toContain("noRestate");
      expect(weekly.prompt).toContain("shortlist of 15 names stable");
      const tools = variant.roles["weekly-analyst"]!.permissions.tools;
      expect(tools).toEqual(name === "team.C-nonews.yaml"
        ? ["ow_reports", "ow_session_frame", "ow_rotation"]
        : ["ow_reports", "ow_session_frame", "ow_rotation", "ow_uw_headlines", "ow_uw_earnings"]);
      const internal = variant.tasks.find((task) => task.id === "week-review");
      expect(internal?.phases).toEqual(["weekly"]);
      expect(internal?.prompt).toContain("ow_review_window");
      expect(internal?.prompt).toContain("sample too small to score edge");
    },
  );

  it("the daily editor makes increments without imposing weekly proportions", () => {
    const persona = manifest.roles.editor?.persona ?? "";
    expect(persona).toContain("Premarket is the main newsletter");
    expect(persona).toContain("Intraday is an increment");
    expect(persona).toContain("Close explains how the day");
    expect(persona).toContain("shortlist of 5 names stable");
    expect(persona).not.toContain("one third");
  });

  it("the scenario analyst is bounded to section 5", () => {
    const persona = manifest.roles["scenario-analyst"]?.persona ?? "";
    expect(persona).toContain("150");
    expect(persona).toContain("base case");
  });

  it("the week reviewer is forbidden P/L outside the longest window", () => {
    const persona = manifest.roles["week-reviewer"]?.persona ?? "";
    expect(persona).toContain("no P/L");
    expect(persona).toContain("sample too small to score edge");
  });

  it("both review authors are bounded on the focus and theme lines", () => {
    for (const id of ["weekly", "edit"]) {
      const prompt =
        manifest.tasks.find((task) => task.id === id)?.prompt ?? "";
      expect(prompt, id).toMatch(/at\s+most 40 words/u);
      // The rule is no longer "never a direction" — a focus line is the
      // analyst's judgment of the setup, and "no view yet" is a stance. What
      // stays forbidden is deriving one mechanically from the IV column.
      expect(prompt, id).toContain("NEVER MAP IV TO A DIRECTION");
      expect(prompt, id).toContain("never a price target");
      expect(prompt, id).toContain("PROPOSED:");
    }
  });

  it("the review authors are told the verdict needs a probability", () => {
    const persona = manifest.roles["weekly-analyst"]?.persona ?? "";
    expect(persona).toContain("0.50");
    expect(persona).toContain("0.95");
  });

  // review-v6: both documents answered 11 of 23 coverage rows. All ten sector
  // rows and the theme row came back `not called this period` over a frame
  // that had priced every one of them — the prompt said "one entry per row you
  // were given" and never said which rows those were. It does now, and the
  // list is asserted against `extensions.review` rather than a literal, so
  // adding a sector or a theme fails HERE until the prompt carries it.
  it("the daily review prompt names every coverage row id the declaration produces", () => {
    const tenantPath = join(__dirname, "..", "tenant.yaml");
    const spec = parseTenantYaml(readFileSync(tenantPath, "utf8"), tenantPath);
    const ids = coverageRowIds(
      parseReviewConfig(spec.extensions as Record<string, unknown>),
    );
    expect(ids.length).toBe(23);
    for (const id of ["edit"]) {
      const prompt =
        manifest.tasks.find((task) => task.id === id)?.prompt ?? "";
      for (const rowId of ids)
        expect(prompt, `${id} / ${rowId}`).toContain(rowId);
      expect(prompt, id).toContain("ALL 23");
      expect(prompt, id).toContain("not a prediction quota");
    }
  });

  it("daily and weekly prose can cite supporting numbers without compulsory forecasts", () => {
    for (const name of ["team.yaml", "team.C.yaml", "team.C-nonews.yaml"]) {
      const variant = parseTeamYaml(readFileSync(join(__dirname, "..", name), "utf8"));
      for (const id of ["edit", "weekly"]) {
        const prompt = variant.tasks.find((task) => task.id === id)?.prompt ?? "";
        expect(prompt, `${name}/${id}`).not.toContain("noRestate");
        expect(prompt, `${name}/${id}`).toContain("Essential sourced numbers may");
        expect(prompt, `${name}/${id}`).toContain("omit `p` and `observable`");
      }
    }
  });
  it.each(["team.yaml", "team.C.yaml", "team.C-nonews.yaml"])(
    "%s writes market prose and no empty-calendar scenarios",
    (name) => {
      const variant = parseTeamYaml(readFileSync(join(__dirname, "..", name), "utf8"));
      const edit = variant.tasks.find((task) => task.id === "edit")!.prompt;
      expect(edit).toContain("market developments relevant to this phase");
      expect(edit).not.toContain("only ids the scorecard printed");
      expect(edit).not.toContain("ROW 1");
      expect(edit).not.toContain("Every paragraph carries a number");
      expect(variant.roles.editor!.persona).not.toContain("ROW 1");
      const scenarios = variant.tasks.find((task) => task.id === "scenarios")!.prompt;
      expect(scenarios).toContain('return {"sections":[]} and stop; omit spyForecast');
      expect(scenarios).not.toContain("Write A/B/C/D");
      expect(variant.roles["scenario-analyst"]!.persona).toContain('return {"sections":[]} and stop');
    },
  );

});
