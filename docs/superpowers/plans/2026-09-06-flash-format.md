# Flash Format Implementation Plan (helium)

> **For agentic workers:** execute with `/execute-plan` — linear, straight-through, in this worktree. Do NOT use subagent-driven-development or parallel dispatch (forbidden by the operator's global rules). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two defects in the option-wizard daily brief, fixed where they can be enforced rather than requested.
**A. Verbosity.** All three daily phases become a news flash: headline ≤30 words, ≤5 sections of ≤60 words, decision values ≤25, candidate rationales ≤40 — enforced by arithmetic in the renderer, measured by an audited gate, never by prompt text alone.
**B. Cause-finding.** When the tape moves and the calendar shows nothing, the regime analyst must go looking in the headline feed and cite what it found verbatim — or say "cause not located". A gate checks the citation against the tool's own bytes; a renderer rule stamps a stale policy-path snapshot.

**Architecture:** Everything lands under `plugins/option-wizard/` — one team-manifest edit, two new gates, three renderer functions. Core is not touched: no new field, no new interface, no retry mechanism. The measurement/enforcement split is forced by the runner (see _The constraint_, below) and is the whole design.

**Tech Stack:** TypeScript ESM, pnpm workspace, Node 22.19+, vitest. DSH pinned at `0.1.1-rc.2` with a patch in `patches/`.

**Branch:** `feat/flash-format`, worktree `.worktrees/flash-format/`, base `41b1fc2` (master, rebased 2026-09-04). Remove the worktree when done. Line numbers cited below were taken at `619b89d`; `editorDocFrom` is now at `render/index.ts:1010`, `buildView` at `:1307`, the `edit` task at `team.yaml:569-572`. Grep, do not trust the numbers. Revisions from the 2026-09-04 review are marked **[rev 2026-09-04]**.

## Doctrine — the acceptance criteria for every task

Quoted verbatim from `/Users/chenxi/projects/helium/AGENTS.md`, because that file is gitignored and does not travel to a worktree, a fresh clone, the mini, or a dispatched subagent. Reject returned work that violates one; a subagent's own recommendation does not override this.

1. **Recursive self-improvement is the soul.** Helium must be able to run an agent team against its own repo, in a sandbox, and land the result. Every design decision is judged by one question: does it make the _next_ iteration of Helium faster, cheaper, or safer to attempt? A feature that only helps one tenant and not the loop is a tenant plugin, never core.
2. **Multipurpose.** Core knows no domain, no provider, no business word. Options, market data, ops, Helium-itself are all tenants under `plugins/<name>/`, discovered by glob, no registry. First two tenants: option-wizard (daily candidate orders by email) and livewire build/heal (agents that find gaps and fix the pipeline). Third: helium-self.
3. **Pluggable multi-agent from day one.** Agents, providers, tools, tenants, gates are all plugins with one small interface each. A role declares capabilities (`requires: [...]`), never a model. Adding an agent kind or a model vendor must be a new directory, not a core edit.
4. **Context and token sense is built in, not bolted on.** Every run records, per agent per step: model, tokens in/out, context size, wall time, cost. The audit is a queryable table, not a log line. Agents are given a budget and know how much of it is left; the harness picks the cheapest model the capability allows; large tool outputs are summarised before they enter a context. "Where did the tokens go" must be answerable in one query.
5. **Fast iteration; destructive experiments are allowed.** Blast radius is defined by _where_ an agent runs (git worktree, throwaway `$DSH_HOME`, scratch dirs), not by signatures, leases, or authority manifests. Inside a sandbox an agent may do anything. Outside it, two rules: never write the production data lake, never place an order. (Whether an agent may push to master is an open question, not yet decided.) Deploy is `git pull && pnpm build && launchctl kickstart` — minutes, not days.
6. **Ceremony must earn its keep.** A gate, review pass, contract test, or release step stays only if it has caught a real defect. Measure where the wall time goes on every change; when the process takes longer than the change itself, the process is the bug. Prefer deleting over certifying.

**How this plan is judged against them.** Point 2: every file changed is under `plugins/option-wizard/`; `contracts/tests/core-neutrality.contract.spec.ts` must stay green with no core edit at all. Point 3: the two new gates are files in `plugins/option-wizard/gates/`, discovered by `loadGates` — no registry line. Point 4: adding an `edit` step to two more phases is a real, recurring model cost and Task 2 states the number it must be measured at; every gate is a zero-token audited span so gate cost is separable from model cost in one query. Point 6: Task 0 refuses to build a Fed-calendar tool on speculation, and each new mechanism below carries the ablation that justifies it and the date on which it gets deleted if it never fires.

## Global constraints

- **No synthetic market data.** Every fixture uses the recorded 2026-09-03 runs, retrieved from the local argon (`http://127.0.0.1:8400/api/agent-runs/run/{premarket,intraday,close}/2026-09-03?tenant=option-wizard`, all three at `code_sha 8d26e0a`, `schema_version 1`). Real section titles and word counts are quoted in _Evidence_ below; use those strings, not invented ones.
- **Core stays domain-free.** Nothing under `packages/core/src` is edited. If a task seems to need a core field, the design is wrong — re-read the constraint section.
- **Key NAMES only in `tenant.yaml`.** No value in the repo. This plan adds no new environment key unless Task 0 decides to build the Fed feed, and then only a name.
- **`lib/` is build output and is not committed.** `pnpm build` before contracts or deploy. `rm plugins/option-wizard/tsconfig.tsbuildinfo` first if a build comes back clean while `lib/` is stale.
- **Commit messages** are `<type>(<scope>): <subject>`.

---

## Evidence — the recorded 2026-09-03 runs

Retrieved from argon on 2026-09-04. Body word counts, per stored view:

| phase     | sections | body word counts                                      | coverage | headline |
| --------- | -------- | ----------------------------------------------------- | -------- | -------- |
| premarket | 11       | 222, 197, 111, 196, 187, 156, 146, 148, 210, 234, 259 | 239      | 43       |
| intraday  | 8        | 171, 189, 91, 210, 65, 53, 55, 46                     | 181      | 38       |
| close     | 7        | 83, 213, 126, 151, 236, 31, 23                        | 150      | 36       |

Real section titles (use these verbatim in fixtures): `Rates are the first cause`, `Today's largest divergence`, `Good news, priced down = pricing power exhausted`, `Reaction function`, `Layer Coverage`, `今日故事`, `今日市场`, `Verdict`, `Settlements not in the ledger, dropped`.

**Correction to the brief this plan was written from.** The 2026-09-03 premarket run did **not** have the editor. Its transcript carries exactly seven steps — `universe, gex, overnight, regime, scenarios, design, review` — and its stored view has no `edited` flag, so `applyEditor` never ran (`plugins/option-wizard/render/index.ts:1043`, `:1048`). The `edit` task was added in `b5932cb` on **2026-09-04 14:04**, the day _after_. So the ≤60-word budget at `plugins/option-wizard/team.yaml:389-394` has never been applied to a production brief at all. This makes defect A worse, not better: the budget is prompt text on a role that did not exist when the wall of prose shipped, and there is still no phase in which anything measures it.

**Defect B, from the intraday transcript.** `regime-analyst` called neither `ow_uw_headlines` nor `ow_x_posts` (zero occurrences in the transcript body). Its `Reaction function` section names only "Cleveland's Hammack and Chicago's Goolsbee … at 2026-09-03T19:00:00Z (ow_uw_calendar, asOf 2026-09-03T17:00:23.127Z)" — both _after_ the 17:00Z run — then explains the rally as "the market fading the hike-path stiffness". Governor Waller spoke that morning (federalreserve.gov/newsevents/speech/waller20260903a.htm; Reuters: "Bond yields fall, stocks rally as Fed's Waller comments curb hike bets"; hike odds ~65%→~50%) and is never named. The same section cites "the 9/16 meeting at a 60% HIKE … snapshot 2026-09-02" — a day-old snapshot presented in the same breath as live levels. The model _did_ write the snapshot date; nothing made the reader see it as stale, and nothing would have caught its omission.

## The constraint — what a gate can and cannot do

**A gate cannot reject a model output and cause a retry. There is no retry mechanism.** Verified in `packages/cli/src/runner.ts`:

- An **output** gate runs after the call, and its refusal explicitly does not discard the text: _"Output gates see what the model produced. A refusal here does NOT discard the text — the step ran and was paid for; it marks it so the tenant's renderer can route it"_ (`runner.ts:1013-1016`). The refusal becomes `failure: "gate-refused"` plus `gateRefusals` on the step (`runner.ts:1050-1052`) and nothing else.
- An **input** gate refusal `continue`s past the step entirely — no model call, no text (`runner.ts:739-748`).
- Every gate is its own audited span, zero tokens, zero cost, `tool_name = "gate:<id>"` (`runner.ts:486-503`).
- Tasks are selected by phase-label string compare only (`packages/core/src/team.ts:47-60`; `runner.ts:649-654`). There is **no predicate, no `when:`, no loop** — so "call the editor a second time only when it overran" is not expressible in a manifest. It would be either a core edit (forbidden by doctrine 2/3) or an unconditional second long-context call every run (doctrine 4 and 6).

**Therefore the mechanism is: the renderer enforces, a gate measures.**

- `plugins/option-wizard/render/index.ts` trims deterministically — word counting is arithmetic and the model never does arithmetic. This is the enforcement; it cannot be argued with and costs zero tokens.
- A new output gate `flash-budget` counts the same words and **refuses** when over, naming the exact counts. The refusal is the sensor: it puts a zero-token row in the audit table with the overage in `tool_output_bytes`/reason, and `degradationFrom` (`render/index.ts:285-303`) surfaces it as one line the reader sees. Without it, a prompt that is being ignored looks identical to a prompt that is being obeyed.

One hazard this creates, and the only renderer change that exists to absorb it: `editorDocFrom` returns `undefined` for any step with a failure — `if (step === undefined || step.failure !== undefined) return undefined;` (`render/index.ts:978`). A `flash-budget` refusal on the `edit` step would therefore throw away the entire editor document and fall back to the seven-fragment assembly. Task 1 narrows that check so an _advisory_ refusal (the gate ids listed in one constant) does not discard the document the renderer is about to trim anyway.

**Ablation, both halves.** Delete the renderer trim → the gate refuses, a degradation line appears, and the 259-word section ships anyway (the runner does not discard). Weaken the trim to a word cut → every over-budget section ends mid-clause, which reads as a delivery fault rather than an editing one, and the reader cannot tell a truncated sentence from a wrong one. Delete the gate → the reader gets a flash brief and nobody ever learns the editor is ignoring its budget, or by how much. Both earn their keep. **If `flash-budget` has not refused once in the 20 trading days after deploy, delete the renderer trim and keep the gate** — that is the doctrine-6 test, with a date.

---

## Task 0: verify before building — the Fed source and the headline feed

**Read-only. No code changes. Do this first.** Two probes; the second decides whether any new tool is built.

- [ ] **Step 1: Is federalreserve.gov reachable from the mini?** The laptop cannot reach it (curl exit 35; opencli's Chrome got `ERR_CONNECTION_CLOSED`, 2026-09-04). The mini has a Clash proxy in `HELIUM_PROXY`. Re-run and record:

```bash
ssh macmini 'P=$(grep -m1 "^HELIUM_PROXY=" ~/.config/helium/helium.env | cut -d= -f2-)
for u in https://www.federalreserve.gov/newsevents/calendar.htm https://www.federalreserve.gov/feeds/speeches.xml; do
  c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 --proxy "$P" "$u"); echo "$u -> http=$c exit=$?"; done'
```

**Result on 2026-09-04: both `http=200 exit=0`.** So reachability is not the blocker it was assumed to be, and the "unreachable ⇒ headlines rule is the whole fix" branch does not apply. Re-verify anyway — a proxy that was up yesterday is not evidence. Print the value of nothing; the `${P:+...}` form above must keep the token off the terminal.

- [ ] **Step 2: Would the headlines rule alone have found Waller?** This is the probe that decides. `ow_uw_headlines` defaults to `majorOnly: true` and 15 rows (`plugins/option-wizard/tools/index.ts:2525-2560`); the rule in Task 3 sets `majorOnly: false` with a search term. Run the tool as the rule would, from the mini, and look for a Waller row:

```bash
ssh macmini 'cd ~/projects/helium-releases/current && \
  node -e "…"  # or the simplest equivalent: curl the UW endpoint the tool wraps,
               # /api/news/headlines?limit=25&major_only=false&search_term=Waller
               # with OW_UW_API_KEY from ~/.config/helium/helium.env. Print row
               # count and each created_at + headline; never print the key.'
```

The feed is a rolling window, so a 2026-09-03 row may have aged out. That is itself the answer: **if the feed cannot be searched back to the morning of the move, the headlines rule cannot locate a cause that is hours old**, and the Fed speech feed becomes necessary rather than speculative.

**Then decide, and only then.**

- Waller (or an equivalent named-speaker row for a comparable event) is findable with `majorOnly:false` + a search term → **the Fed feed is not built.** Task 3 is the whole fix for defect B. Record the query and the row that proved it in the PR body.
- It is not findable → open `ow_fed_speeches` (over `/feeds/speeches.xml`, proxy-aware) **as its own piece of work**, not inside this branch. Record the XML's actual element names and one real row, with the date, in the PR body so the tool can be written against verified shape rather than recall.

Either way this branch ships Tasks 1-4 unchanged. Do not build the tool inside this plan.

---

## Task 1: the flash budget — renderer enforcement, gate measurement

**Files:** modify `plugins/option-wizard/render/index.ts` (`BriefView` at :123, `editorDocFrom` at :976-978, `buildView` at :1271); create `plugins/option-wizard/gates/flash-budget.ts`, `plugins/option-wizard/tests/gate-flash-budget.spec.ts`, `plugins/option-wizard/tests/render-flash-budget.spec.ts`.

**The budget, in one exported constant** so the gate and the renderer cannot drift:

```ts
// plugins/option-wizard/render/budget.ts — imported by BOTH the renderer and
// the gate. Two copies of a number that must agree is how a gate ends up
// certifying the thing it was supposed to catch.
export const FLASH_BUDGET = {
  headlineWords: 30,
  sectionCount: 5,
  sectionBodyWords: 60,
  decisionValueWords: 25,
  rationaleWords: 40,
} as const;
/** Words are whitespace-separated runs. CJK is not word-delimited, so a run of
 *  Han characters counts as one word by this rule and 今日故事 (31 words by
 *  this measure on 2026-09-03) is under budget by construction. That is a
 *  known, accepted imprecision: the defect is 259-word English paragraphs, and
 *  a character-based CJK rule would be a second budget nobody asked for. */
export function words(text: string): number;
```

**Renderer.** A pure function applied at the end of `buildView`, after `applyEditor` and after charts:

```ts
/** Deterministic trim. Sections beyond the fifth are DROPPED, not merged —
 *  merging would invent a paragraph no author wrote.
 *
 *  A body over budget is cut at the LAST SENTENCE END inside the budget — `.`,
 *  `。`, `!` or `?` — and nothing is appended. A news flash of half-sentences
 *  is worse than one that is a few words short: the reader can act on four
 *  complete sentences and cannot act on five and a fragment, and a trailing
 *  "…" only tells them something was taken without telling them what.
 *
 *  The word cut survives as the fallback for one case: the FIRST sentence
 *  alone is over budget, so there is no sentence end to cut at. Then, and only
 *  then, the body is cut at the last whole word with a trailing "…" — and the
 *  gate reports that case by name, because a single 90-word sentence is a
 *  different authoring failure from five sentences that ran long, and the fix
 *  for it is a different sentence rather than fewer of them. */
function enforceBudget(view: BriefView): BriefView;
```

`coverage` is exempt: it is a table of sources and as-ofs, it always renders last, and truncating it would delete the AS-OF strings the `as-of-verbatim` gate exists to protect.

**Gate** `plugins/option-wizard/gates/flash-budget.ts`, `phase: "output"`, `appliesTo: ["editor", "regime-analyst", "drift-watcher", "recap-writer"]` — every role that can put a `sections` array into a brief. It parses the step's own JSON with the renderer's `extractJson`, counts, and refuses with the exact numbers: `4 of 8 sections over 60 words (171, 189, 210, 91); headline 38 of 30`. A step with no parseable `sections` passes with `"no sections to measure"` — that is a step doing something else, not a violation.

**The advisory-refusal narrowing**, `render/index.ts:978`:

```ts
/** Gate refusals that must NOT discard the editor's document. `flash-budget`
 *  is a MEASUREMENT: `enforceBudget` below already cuts what it complained
 *  about, so throwing the document away would cost the reader a written brief
 *  in exchange for a seven-fragment one that is also over budget. Every other
 *  refusal still discards — a step the harness could not trust is not prose it
 *  can print. */
const ADVISORY_GATES = new Set(["flash-budget"]);
```

- [ ] **Step 1: Write the failing tests first.** In `render-flash-budget.spec.ts`, reuse the `report(overrides)` builder at `tests/render-editor.spec.ts:187` (do not write a second one). Fixtures carry the recorded 2026-09-03 bodies. Assert: an 11-section premarket view renders 5 sections; each body ≤60 words; the 43-word headline is cut to ≤30; a 53-word `Confidence` decision value is cut to ≤25; `coverage` is untouched at its recorded 239 words; a view already inside budget is returned byte-identical. Then the sentence rule, three cases from the recorded bodies: the 259-word `Reverse risk` body is cut at a sentence end, the result ends in `.` and carries **no** `…`, and it is ≤60 words but **not** exactly 60 — landing on 60 would mean the word cut ran; a body whose sentence end falls exactly on the budget keeps that whole sentence and loses nothing; and a synthetic single-sentence body of 90 words built by joining one recorded body's clauses — no sentence end before the budget — falls back to the word cut, ends in `…`, and is the one case the gate names separately. In `gate-flash-budget.spec.ts` (pattern: `tests/gate-as-of-verbatim.spec.ts`): the recorded intraday step JSON refuses and the reason names `171`, `189`, `210`; a step whose first sentence alone is over budget refuses with that named separately; an in-budget step passes; a step whose text is prose passes with `"no sections to measure"`; a `flash-budget`-only refusal on the `edit` step still yields `edited: true` from `editorDocFrom`, while a refusal from any other gate id still discards.
- [ ] **Step 2:** Run, watch fail, implement.
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts`. `core-neutrality` must stay green — nothing in this task touches core.
- [ ] **Step 4: Commit** — `feat(option-wizard): flash budget — renderer trims, flash-budget gate measures`

---

## Task 2: one author for all three daily phases

**Files:** modify `plugins/option-wizard/team.yaml` (the `edit` task at :565-567, its `dependsOn` at :568, the word-budget block at :389-394); extend `plugins/option-wizard/tests/team-manifest.spec.ts`.

Today `edit` declares `phases: [premarket]` (`team.yaml:567`). Intraday and close have **no editor at all**: `regime-analyst`'s four sections and `drift-watcher`'s or `recap-writer`'s go into the view raw, which is why intraday shipped eight sections and close seven. Trimming alone cannot fix that — capping eight sections at five _deletes_ three whole sections and cuts four mid-sentence. Selecting and rewriting is what an author does.

```yaml
- id: edit
  role: editor
  phases: [premarket, intraday, close]
  dependsOn:
    [
      universe,
      gex,
      markout,
      overnight,
      regime,
      scenarios,
      design,
      review,
      drift,
      recap,
    ]
```

Adding phase-scoped tasks to `dependsOn` is safe and already documented: a task whose phase does not match contributes no `produced` entry, and `handoff` drops dependencies with no text (`runner.ts:341-352`, `:649-654`). `ow_prior_brief` already takes a `phase` parameter (`tools/index.ts:2036-2041`), so the prompt's "call ow_prior_brief" becomes "for THIS phase".

Then change the word-budget block from a request into a statement of fact, because it now is one. **[rev 2026-09-04] It exists in TWO places** — the editor persona (`team.yaml:389-394`) and the `edit` task's own prompt (`:612-617`, "WORD BUDGET, and it is a budget, not a target"). Change both to the text below, or delete one; leaving one as a request and the other as a fact is a contradiction the model reads every run:

> These are enforced by the renderer, not by you: a section over 60 words is cut back to its last complete sentence, so a sentence you start past the budget is a sentence the reader never sees. Sections past the fifth are dropped entirely. Choose the five that matter and write them to length — the trim cannot choose for you.

**Cost, stated because doctrine 4 requires it.** This adds one long-context model call to intraday and one to close, every trading day. That is the price of the format and it must be measured, not assumed: record `SUM(cost_usd)` for `role='editor'` on the first intraday and close runs after deploy (query in _How success is measured_) and put both numbers in the PR body. **If the editor's share of a run exceeds 40% of that run's cost, stop and re-scope** — at that point the cheaper design is regime-analyst writing five short sections directly, with the Task 1 trim as the backstop.

- [ ] **Step 1: Write the failing test.** In `team-manifest.spec.ts`: `edit` runs in all three daily phases and in neither `weekly` nor `frank` (those already have a single author each and are out of scope); the manifest still parses through core's `parseTeamYaml`; every task in `dependsOn` exists.
- [ ] **Step 2:** Edit `team.yaml`, run, watch pass.
- [ ] **Step 3:** `pnpm build && pnpm test`
- [ ] **Step 4: Commit** — `feat(option-wizard): the editor writes intraday and close too`

---

## Task 3: cause-finding — the rule, and the gate that checks the citation

**Files:** modify `plugins/option-wizard/team.yaml` (the `regime-analyst` persona at :96-147 and the `regime` task prompt at :464-505); modify `plugins/option-wizard/render/index.ts` (`BriefView` at :123); create `plugins/option-wizard/gates/cause-citation.ts`, `plugins/option-wizard/tests/gate-cause-citation.spec.ts`.

**[rev 2026-09-04] The number the rule compares must come from a tool.** The rule below asks the model whether an index is "more than 0.75% from its prior close". `tape.change` is, by the regime prompt (`team.yaml:495-500`), copied from a tool and never computed — but `ow_spot` returns only `{source, close, marketTime}` (`tools/index.ts:773-777`); `prev_close` is consumed as a fallback for `close` and never returned. So for SPY/QQQ there is no tool number to compare, and the model would either compute one (the arithmetic this plan forbids) or never trigger. **Before the prompt change:** `ow_spot` returns `prevClose` and `changePct` (computed in code from `close` and `prev_close`, `changePct` rounded to two decimals, both absent when `prev_close` is missing), with a frozen fixture from the recorded 2026-09-02 response already quoted in the tool's own comment (`tools/index.ts:737`, `prev_close: "761.78"`). One test in `tests/tools-spot.spec.ts` (or the existing spot spec, if there is one — grep first): `changePct` matches the hand-checked value in the test comment; a row without `prev_close` yields neither field. The rule then says _compare `changePct` from the tool_, and the model compares two numbers it was handed.

**The rule** (intraday and close only — a premarket run at 08:45 ET has no session to explain). Added to the `regime` task prompt:

> INTRADAY AND CLOSE. Before you write the reaction function, decide whether the tape has a **notable move**: any index whose `changePct` from ow_spot is beyond ±0.75, a 5bp move at any point on the curve per ow_macro_rates, or a move beyond ±1.5% in gold or the dollar per ow_tv_commodities — compare the tool's own change figure; never derive one. If there is one and `ow_uw_calendar` lists no dated event _before the current hour_, you MUST call `ow_uw_headlines` with `majorOnly: false` and a `searchTerm` — a Fed name (Powell, Waller, Bowman, Williams, Hammack, Goolsbee), "Fed", or the ticker of the moving asset — and cite the row that explains the move: its `created_at` and its `headline` copied character-for-character. Then write the field:
> `"cause": {"located": true, "headline": "<verbatim>", "at": "<the row's created_at>", "source": "ow_uw_headlines", "searchTerm": "<what you searched>"}`
> If nothing in the feed explains it, write `{"located": false, "searched": ["<term>", "<term>"]}` and say "cause not located" in the reaction function. **A cause you cannot cite is not a cause.** The 2026-09-03 intraday run explained a curve rally from the curve itself while Governor Waller was on the wire, and named him nowhere.

`ow_x_posts` stays available and stays optional: it needs `OW_TV_ENABLED=1` and a browser bridge (`tools/index.ts:2596-2604`), so a rule that required it would fail on a machine where the headline feed alone is enough.

**The gate** `cause-citation.ts`, `phase: "output"`, `appliesTo: ["regime-analyst"]`. Same shape and same reasoning as `as-of-verbatim.ts` — read that file first; this one extends its pattern to a string that no regex can find in prose, which is exactly why the model is made to write it as a structured field.

| `cause` in the step's JSON                                                     | verdict                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| absent                                                                         | **pass** — "no cause claimed"; the rule is prompt-scoped to two phases and the gate must not fail premarket for obeying it             |
| `{"located": false, ...}`                                                      | **pass** — "cause not located, honestly"                                                                                               |
| `located: true`, `headline` is a substring of some `ctx.stepToolOutputs` entry | **pass**                                                                                                                               |
| `located: true` but this step called no tool at all                            | **refuse** — nothing to copy from, so it was written from the model's own head (`as-of-verbatim.ts` refuses on exactly this reasoning) |
| `located: true`, `headline` not found verbatim                                 | **refuse**, naming the claimed headline and the search terms                                                                           |

Read `ctx.stepToolOutputs` and not `ctx.toolOutputs`: the latter accumulates over the whole run, so an _earlier_ step's headline call would satisfy a run-wide check while this step never saw the feed. That is the `design-spot.ts:29-32` lesson, verbatim.

**Rendering.** `BriefView` gains `cause?: { located: boolean; headline?: string; at?: string; searchTerm?: string }`, filled from the regime step's JSON by the existing `extractJson` path, and rendered as the first line under the headline: _"Why it moved — <headline> (<at>)"_, or _"Cause not located."_ when `located: false`. That line is the reader-visible half of the fix; without it the gate protects a field nobody sees.

- [ ] **Step 1: Write the failing tests.** In `gate-cause-citation.spec.ts`, the fixture is the recorded 2026-09-03 intraday step: a `cause` claiming the Reuters Waller headline with **no** headlines tool output in `stepToolOutputs` must refuse; the same claim with a `stepToolOutputs` entry containing that exact string must pass; a `located:false` step passes; a step with no `cause` passes. Add one render case: `cause.located` renders the "Why it moved" line, `located:false` renders "Cause not located." Use the real headline text and the real 17:00Z run timestamps from the transcript — no invented rows.
- [ ] **Step 2:** Run, watch fail, implement gate + prompt + renderer line.
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts`
- [ ] **Step 4: Commit** — `feat(option-wizard): regime must locate and cite the cause, or say it did not`

---

## Task 4: a stale policy-path snapshot says so, in the renderer

**Files:** modify `plugins/option-wizard/render/index.ts` (`BriefView` at :123, a new reader beside `ledgerIds` at :582, `buildView` at :1271), `plugins/option-wizard/render/html.ts` and `render/text.ts`; extend `plugins/option-wizard/tests/render-newsletter.spec.ts`.

`ow_argon_policy_path` returns `{source, snapshotDate, meetings:[...]}` from a **nightly** snapshot (`tools/index.ts:2362-2392`). On 2026-09-03 the intraday run was handed the 2026-09-02 snapshot and printed "a 60% HIKE" beside live 17:00Z levels. The model happened to write "snapshot 2026-09-02" in prose that day; nothing required it to, and the reader had no reason to read it as a warning.

This is the `toolPayloads` pattern (`render/index.ts:545-570`): identify the payload **by shape**, never by tool name, because the producing tool is not recorded.

**[rev 2026-09-04] D-1 is not stale; it is the design.** Verified on the mini: `uw_scan.rates_policy_path` rows for `snapshot_date = D` have `first_seen_at = D+1 06:45 HKT` = **D 18:45 ET**, i.e. after the close, every day (2026-09-01/02/03 all identical). So premarket (08:45 ET), intraday (13:00 ET) and close (16:15 ET) _always_ see the D-1 snapshot. The first draft's `snapshotDate !== report.day` would therefore fire on every run of every phase — a constant, not a signal, and doctrine 6 would delete it inside a week. Two changes: the snapshot date is printed **always**, as an ordinary as-of row in `coverage` (`Fed path (argon) — as of 2026-09-02`), which is where every other source's date already lives; and the _stale_ line fires only when the snapshot is **more than 3 calendar days** behind `report.day` — Monday reading Friday's snapshot is 3 days and normal, anything beyond it is argon's nightly job having missed.

```ts
/** Freshness notes the renderer asserts on its own, from the run's raw tool
 *  outputs — never from a model step. A prompt can be forgotten; this cannot.
 *  Identified by shape (`snapshotDate` + a `meetings` array), same rule as
 *  `ledgerIds` and `earningsFromTools`. The snapshot is written after the ET
 *  close, so D-1 is the expected value on every phase; only a gap past a
 *  weekend is a fault. */
function stalenessFrom(report: RunReport): string[];
// day - snapshotDate > 3 calendar days  ->  "Fed path: snapshot 2026-08-28, 6 days behind"
```

Rendered as a single muted line directly under `coverage`, in both `html.ts` and `text.ts`. It is **not** folded into `degradation`: nothing failed, and `degradationFrom` (`render/index.ts:285-303`) is the line that must keep meaning "something broke".

- [ ] **Step 1: Write the failing test.** Fixture: the recorded intraday tool payload with `snapshotDate: "2026-09-02"` on a `report.day` of `"2026-09-03"` produces **nothing** from `stalenessFrom` and one coverage row `Fed path (argon) — as of 2026-09-02`; the same payload on a `report.day` of `"2026-09-07"` (Monday after Labor Day weekend, 5 days) produces exactly `Fed path: snapshot 2026-09-02, 5 days behind`; a Friday snapshot on the following Monday (3 days) produces nothing; a run with no such payload produces nothing; the stale string, when present, reaches both the HTML and the text body.
- [ ] **Step 2:** Run, watch fail, implement.
- [ ] **Step 3:** `pnpm build && pnpm test`
- [ ] **Step 4: Commit** — `fix(option-wizard): a policy-path snapshot older than the report day says so`

---

## Decisions

1. **The renderer enforces and a gate measures.** Forced, not chosen: `runner.ts:1013-1016` says an output-gate refusal does not discard the text, and `team.ts:47-60` gives tasks no predicate to hang a conditional re-run on. Anything else would be a core edit (doctrine 2, 3) or an unconditional second long-context call every run (doctrine 4, 6).
2. **The editor runs in all three daily phases.** Trimming cannot select; it can only cut. Accepted cost is one extra long-context call per phase per day, with a stated 40%-of-run-cost abort threshold (Task 2).
3. **`flash-budget` is advisory to the renderer and load-bearing to the audit.** It refuses — so the audit and the reader both see the overage — but its refusal alone does not discard the editor's document (`render/index.ts:978`, narrowed by `ADVISORY_GATES`). Delete the renderer trim if the gate has not refused in 20 trading days.
4. **No Fed-calendar tool in this branch.** federalreserve.gov answers 200 from the mini through the Clash proxy (verified 2026-09-04), so it is _possible_ — which is not a reason. Task 0 step 2 decides it on whether the headline feed alone can find a named speaker hours after the fact, and any tool that follows is its own piece of work.
5. **`coverage` is exempt from the budget.** It is the AS-OF table `as-of-verbatim` protects; a trim there would delete evidence to save words.

---

## How success is measured

**Section word counts, per run, straight from the stored view:**

```bash
curl -s "http://127.0.0.1:8400/api/agent-runs/run/<phase>/<day>?tenant=option-wizard" | python3 -c '
import json,sys
v=json.load(sys.stdin)["view"]
print("headline", len(v["headline"].split()), "(<=30)")
print("sections", len(v["sections"]), "(<=5)")
for s in v["sections"]: print(" ", len(s["body"].split()), s["title"][:50])
for r in v.get("decision") or []: print(" DEC", len(r["value"].split()), r["label"])
print("cause", v.get("cause")); print("staleness", v.get("staleness")); print("edited", v.get("edited"))'
```

Pass: headline ≤30, ≤5 sections, every body ≤60, every decision value ≤25, `edited: true`, `cause` present on intraday/close. Compare against the _Evidence_ table above — that is the before.

**Gate cost, per run, from the audit table** (`packages/core/src/audit.ts:66-77`; DB at `$HELIUM_AUDIT_DB` else `~/.helium/audit.db`, deliberately outside the deploy unit so a rollback does not take the history):

```bash
ssh macmini "sqlite3 ~/.helium/audit.db \"
  SELECT role, tool_name, COUNT(*) n, SUM(latency_ms) ms, SUM(cost_usd) usd, SUM(tool_output_bytes) bytes
    FROM span WHERE run_id='<run-id>' AND tool_name LIKE 'gate:%'
   GROUP BY role, tool_name ORDER BY ms DESC;\""
```

Want `gate:flash-budget` and `gate:cause-citation` rows present, `usd = 0`, `ms` in the single-digit milliseconds. A missing row means the gate did not load — check `gatesSkipped`, which the brief prints as a degradation line.

**The editor's share of the run** (doctrine 4, Task 2's abort threshold):

```bash
ssh macmini "sqlite3 ~/.helium/audit.db \"
  SELECT role, SUM(input_tokens) tin, SUM(output_tokens) tout, ROUND(SUM(cost_usd),4) usd
    FROM span WHERE run_id='<run-id>' GROUP BY role ORDER BY usd DESC;\""
```

`helium audit <run-id>` prints the same fold plus `code: <sha>` first; use it to confirm the run came from the sha just deployed.

**First live run to check.** **[rev 2026-09-04]** The mini's crons (`tenant.yaml:76-100`, times actually live in `launchd/`): premarket `45 20 * * *` HKT = **08:45 ET** same date (moved from 06:00 ET by PR #88); intraday `0 1 * * *` HKT = 13:00 ET the previous HKT date; close `15 4 * * *` HKT = 16:15 ET the previous HKT date. Monday 2026-09-07 is US Labor Day [COMPUTED — first Monday of September]; the crons fire on a holiday regardless, and a run on a closed session is not a format test. So whatever day this deploys, the first ET day with all three phases live is the next US session after the deploy: check premarket (20:45 HKT), then intraday (01:00 HKT next morning) and close (04:15 HKT) of that same ET date. If that is a payrolls or Fed day, so much the better for the cause rule — but do not wait for one.

Check all three phases of one ET day before calling this done: premarket exercises the editor's original path, intraday exercises the cause rule and the staleness line, close exercises the editor over `markout` and `recap`.

---

## Deploy to the mini

Production is the Mac mini (`macmini`, user `moremeds`). Design of record: `docs/superpowers/plans/2026-09-04-release-process.md`. No semver, no CHANGELOG, no tags — the deployed tree's `RELEASE` file is the provenance and is what `helium audit` prints as `code: <sha>`.

**No new environment key.** This branch adds none. `HELIUM_DEPLOYMENT=production` and `HELIUM_TENANT_DELIVERY=1` must already be in `~/.config/helium/helium.env`; confirm by count, never by value:

```bash
ssh macmini 'grep -c HELIUM_DEPLOYMENT ~/.config/helium/helium.env; grep -c HELIUM_TENANT_DELIVERY ~/.config/helium/helium.env'
```

### Ship

From the **laptop**, on a clean tree, with the PR merged:

```bash
cd /Users/chenxi/projects/helium
git checkout master && git pull
rm -f plugins/option-wizard/tsconfig.tsbuildinfo   # a stale one lets `pnpm build` pass over an old lib/
scripts/deploy.sh premarket
```

`scripts/deploy.sh` refuses a dirty tree (an uncommitted edit would make the audit table's `code_version` a lie — `deploy.sh:37-41`), runs `pnpm build` and `pnpm test` (`:45`, `:47`), writes `RELEASE` with the short sha (`:52`), tars the built tree — `node_modules` included; both machines are arm64 macOS — and pipes it over ssh into `~/.config/helium/receive-deploy.sh`. The receiver extracts to `~/projects/helium-releases/<sha>` (`receive-deploy.sh:29`, `:53`), points `current` at it (`:76`), **deletes the email counter — that IS the daily-cap reset**, reinstalls the five `com.helium.option-wizard-<phase>.plist` agents (`:35`, `:87`), `launchctl kickstart -k`s the phase named on the command line (`:102`), and keeps the newest 5 (`:110-121`). The same sha twice is a no-op (`:60`). Override the host with `HELIUM_DEPLOY_HOST=<host>`.

### Prove it

```bash
ssh macmini
~/.config/helium/run-option-wizard.sh intraday    # intraday exercises every part of this change
helium audit <run-id>
```

Want, in order: `code: <sha>` matching what `deploy.sh` sent; an `edit` step present (this is the new one); `gate:flash-budget` and `gate:cause-citation` rows at zero cost; the per-step token/cost rows still folding cleanly by role (doctrine 4 — a new gate must not have broken the one query). Then run the two view queries from _How success is measured_ against that day and phase.

### Rollback

```bash
ssh macmini
ls ~/projects/helium-releases                     # the newest 5 shas
ln -sfn ~/projects/helium-releases/<previous sha> ~/projects/helium-releases/current
launchctl kickstart -k "gui/$(id -u)/com.helium.option-wizard-intraday"
```

Each half must be independently reversible, and this is checked, not assumed: revert `edit`'s `phases` to `[premarket]` alone → intraday and close still render, now from the trimmed seven-fragment assembly; delete `gates/flash-budget.ts` → the brief still renders inside budget and one degradation line stops appearing.

**Do not push to `master` and do not change the mini during an active acceptance window.**
