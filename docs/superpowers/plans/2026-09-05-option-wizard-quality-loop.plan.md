# option-wizard Quality Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In ONE pull request, cut the settlement ceremony out of the option-wizard narrative team, gate and measure what the brief says about itself, replace the prior-brief markdown dump with a structured regime record, record every tool call so a point-in-time replay can be served from recordings instead of refusals, and add a weekly review over 5 / 10 / 21 trading-day windows.

**Architecture:** Six spec items, one branch, one PR, in dependency order. Items 3, 2 and 5 (Tasks 1–7) are the deterministic base: a manifest cut, a `meta-leak` advisory gate beside `flash-budget`, and three code-computed numbers per run landing in a new core-neutral `metric` table and one `- quality:` header line. Item 4 (Tasks 8–11) adds ONE opaque core seam — a tenant-declared `stateBlock` fence the runner lifts out of a step's text and writes to `<stateRoot>/<tenant>/<day>/<label>.<suffix>` — and the tenant then owns the schema, the advisory gate that validates it, the reader (`ow_prior_brief`) and the two personas. Item 1 (Tasks 12–14) puts a recording wrapper around every tool the runner loads, prunes by age with a caller-supplied keep-list hook, and lets `--replay-from <runId>` serve a live-only tool's recorded response instead of `{ unavailable: "as-of" }`. Item 6 (Tasks 15–16) is one new tool and one new step inside the EXISTING `weekly` phase — no sixth launchd plist. Core learns a fence name, a file suffix, a recording blob and an opaque `extensions` passthrough, and never learns what any of them mean.

**Tech Stack:** TypeScript ESM, Node 22.19+/24+, pnpm workspace, vitest (projects `unit` and `contracts`), `node:sqlite` `DatabaseSync`, `node:zlib` gzip, `node:crypto` sha256, zod 4 (already a tenant dependency).

**Spec:** `docs/superpowers/specs/2026-09-05-option-wizard-quality-loop.md` — this plan covers **all six items** (3, 2, 5, 4, 1, 6) in that order. The spec's "Delivery shape" section proposes two PRs; the user overrode that on 2026-09-05: **one branch, one worktree, one PR, all six items.** Nothing else in the spec changes.

## Global Constraints

- **Doctrine is binding** (`/Users/chenxi/projects/helium/AGENTS.md`). Read it before Task 1 if you have not.
- **Core stays domain-free.** `contracts/tests/core-neutrality.contract.spec.ts` scans every `.ts` under `packages/core/src` for the words `deepseek, claude, anthropic, codex, openai, gpt-, gemini, livewire, argon, apex, colima, postgres`, on camelCase-split word boundaries, comments included. Nothing this plan adds to core may name a market, a tenant, a phase or a provider. The two lists are at `contracts/tests/core-neutrality.contract.spec.ts:24-40`; there is no allow-list and no comment exemption (`:54-63`).
- **LLMs never do arithmetic.** Every number in this plan is computed in code, copied verbatim from a tool, or parsed off a file. No model step is asked to count, average, difference or re-express anything.
- **The renderer may not learn a phase name.** `plugins/option-wizard/tests/render.spec.ts:815-841` scans every `.ts` file directly under `plugins/option-wizard/render/` and fails on a quoted `"premarket" | "intraday" | "close" | "weekly" | "frank"` **or** on any line containing `phase` next to `=== !== == != switch case ? .includes( .startsWith( .test(`. This is why phase-ordered lookups live in `plugins/option-wizard/quality/` and `plugins/option-wizard/state/`, never under `render/`.
- **A persona is capped at 4000 characters** (`packages/core/src/team.ts:44`, `persona: z.string().max(4000)`). The `regime-analyst` persona is already **3420** characters folded (`plugins/option-wizard/team.yaml:113-167`), so item 4's addition has **580 characters of headroom and no more**. Task 11 measures it rather than trusting the eye.
- **`extensions:` stays opaque to the host.** Core may CARRY the block to the tenant's own `buildTools`; core may never read a key inside it. Task 15 adds the passthrough and nothing else.
- **Another agent is concurrently editing** `packages/core/src/tenant.ts`, `packages/cli/src/runner.ts`, `packages/cli/src/discovery.ts` and `plugins/option-wizard/tools/index.ts`. Assume `TenantSpec.calendar` exists (it does: `packages/core/src/tenant.ts:39-59, 96`). **Tasks 1–7 must not touch `plugins/option-wizard/tools/index.ts` at all**; Tasks 10, 14 and 15 do touch it, so rebase immediately before each of those commits and re-locate anchors by content, never by line number.
- **Two modules this PR imports but does not implement** land in the Outcome Ledger session's PR: `readLedger(stateRoot, tenant, { since? })` from `packages/core/src/ledger.ts` and `summarise(records, { deployment?, variant? })` from `packages/cli/src/scoreboard.ts`. `readLedger` returns empty arrays when the ledger file is absent — that absence is the coverage-note path, not an error. Task 15 imports both defensively so it builds and tests green before they land; **item 6's ledger acceptance bullet is blocked until they do.**
- **Rebase rule against the peer PR.** Both PRs edit `packages/cli/src/runner.ts` (peer: settler call at DAG start and the prompt block near the clock; this PR: the tool wrapper around `:600-690` and the post-step state strip). Whichever merges second rebases. If the peer lands first, rebase `feat/quality-loop` onto master before Task 13 and re-run `packages/cli/tests/run-*.spec.ts` and Task 8's tests, and resolve conflicts by keeping both edits — never by dropping the peer's call.
- **Commands:** `pnpm build && pnpm typecheck && pnpm test`. Single unit test: `pnpm vitest run --project unit <path>`. Contract: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`. `pnpm build` must run before any contract test (it consumes `lib/`). If `pnpm build` reports success but `lib/` is stale, `rm plugins/option-wizard/tsconfig.tsbuildinfo` first.
- **Commit messages:** `<type>(<scope>): <subject>`. No `Co-Authored-By` trailers, no emoji.
- **Branch:** ONE branch for all six items. Create `.worktrees/quality-loop/` on branch `feat/quality-loop` from master at `e503995` (PR #91 has merged; `453ea66` is inside it). Copy the spec and this plan into that worktree in the first commit.
- **Ledger dependency for item 3:** resolved 2026-09-05 — the Outcome Ledger session confirmed it reads nothing from markout, drift or recap.
- **Known duplication, accepted:** `quality/prior.ts` re-parses report markdown the same way `ow_prior_brief` does. Task 10 replaces the prior brief's PAYLOAD with a regime record but keeps its markdown fallback, so the duplicate does not go away in this PR; it is a named follow-up, not a leak.

---

## Where the existing machinery lives (read these before Task 1)

| Thing                                                    | Path and lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flash-budget` advisory gate                             | `plugins/option-wizard/gates/flash-budget.ts:29-69`; `advisory: true` at `:32`, `appliesTo` at `:34`, refusal built as one joined `reason` string at `:65`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gate interface, `advisory` semantics                     | `packages/core/src/plugins.ts:146-169`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| How a gate violation reaches the report                  | runner calls output gates at `packages/cli/src/runner.ts:1139-1150`, folds refusals onto the step at `:1172` (`refusalFields`), stored as `StepReport.gateRefusals: Array<{id, reason}>` — `packages/core/src/report.ts:20-21`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| How the renderer reads gate violations                   | `plugins/option-wizard/render/index.ts:344-356` (`degradationFrom`), and the flash-budget-only carve-out exercised at `plugins/option-wizard/tests/render-flash-budget.spec.ts:149-169`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Budget measurement, shared by gate and renderer          | `plugins/option-wizard/render/budget.ts:14-20` (`FLASH_BUDGET`), `:81-136` (`measure`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Audit DB schema                                          | `packages/core/src/audit.ts:65-79` (`SCHEMA`, one `span` table), insert at `:131-173` (`append`), open/migrate at `:99-120`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Audit rows written during a run                          | `packages/cli/src/runner.ts:1108` (`appendAll(spans)`), `:494` (gate spans), `:1240-1262` (delivery span)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Report header builder — the `- as-of:` line              | `packages/cli/src/runner.ts:1309-1369` (`deliveryBody`); the as-of / variant / pit-coverage block is `:1326-1341`, and the bullet list continues at `:1342-1354`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Renderer entry point                                     | `plugins/option-wizard/render/index.ts:1441-1463` (`buildView`) and `:1465-1483` (`export default renderReport`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RenderedReport` shape                                   | `packages/core/src/report.ts:94-119`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tenant gate loading (no core edit needed for a new gate) | `packages/cli/src/discovery.ts:179-216` — every `<tenant>/lib/gates/*.js` with a `default` export whose `check` is a function is loaded by glob; a throwing module is a recorded skip, not a failure. **A tenant contributes a gate by adding one file under `plugins/option-wizard/gates/` and nothing else.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tenant build inputs                                      | `plugins/option-wizard/tsconfig.json` (`include: ["tools","gates","render"]`) and `plugins/option-wizard/package.json` (`files`) — both need `quality` added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `markout` / `drift` / `recap` in the manifest            | `plugins/option-wizard/team.yaml`: role `markout-clerk` `:79-94`, role `drift-watcher` `:322-336`, role `recap-writer` `:338-348`; task `markout` `:440-474`, task `drift` `:765-783`, task `recap` `:785-796`; `edit.dependsOn` `:618-631`; `weekly` prompt references `steps:["markout","recap"]` at `:803`; `frank-comparator` persona says "our weekly markout" at `:372`; `flash-budget` gate lists the two dying roles at `plugins/option-wizard/gates/flash-budget.ts:34`                                                                                                                                                                                                                                                                                                                 |
| Every test that references them                          | `plugins/option-wizard/tests/team-manifest.spec.ts:69-82`, `:90-98`, `:109-113`, `:119-127`, `:129-138`, `:140-146`, `:148-170` (the `for` loop at `:153`), `:172-185`, `:237-270` (the `dependsOn` array at `:249-262`). Also `plugins/option-wizard/tenant.yaml:90` (a comment) and `plugins/option-wizard/tools/index.ts:2415, 2427, 2443` (tool doc strings) — **both deliberately left alone**, see Task 1 note. `plugins/option-wizard/tests/tools-frank.spec.ts` matches on a Substack URL slug containing `recap`; it is unrelated and must not change. `plugins/option-wizard/render/index.ts:493-560` (`settlementSections`, `ledgerIds`) stays: it is keyed on a step producing `settlements`, not on a step id, and `render.spec.ts:514` still exercises it with a synthetic report. |

### Why a new gate needs no core edit

`loadGates` (`packages/cli/src/discovery.ts:188-216`) globs `lib/gates/*.js` under the tenant directory. `flash-budget`, `cause-citation`, `as-of-verbatim`, `design-spot` and `ib-preflight` are all discovered this way. Dropping `plugins/option-wizard/gates/meta-leak.ts` into that directory, with `quality` added to the tenant `tsconfig.json` `include` so it compiles, is the whole registration.

---

## File structure

**Create**

- `plugins/option-wizard/quality/meta-leak.ts` — the pattern list and `findMetaLeaks`. Tenant-local, imported by both the gate and the metrics.
- `plugins/option-wizard/quality/similarity.ts` — `wordSet` and `jaccard`. Pure, no I/O.
- `plugins/option-wizard/quality/prior.ts` — locate the previous report on disk and pull its cause-section title. The only file that knows phase ORDER, which is why it is not under `render/`.
- `plugins/option-wizard/quality/index.ts` — `qualityMetrics(...)`, assembling the three `RunMetric` rows.
- `plugins/option-wizard/gates/meta-leak.ts` — the advisory `Gate`.
- `plugins/option-wizard/render/json.ts` — `extractJson`, moved out of `render/index.ts` so `quality/` can use it without an import cycle.
- `plugins/option-wizard/tests/gate-meta-leak.spec.ts`
- `plugins/option-wizard/tests/quality-similarity.spec.ts`
- `plugins/option-wizard/tests/quality-metrics.spec.ts`
- `packages/core/tests/audit-metric.spec.ts`

**Modify**

- `plugins/option-wizard/team.yaml` — remove three roles, three tasks, trim `edit.dependsOn`, repoint the `weekly` prompt.
- `plugins/option-wizard/gates/flash-budget.ts:34` — drop the two dead roles from `appliesTo`.
- `plugins/option-wizard/tests/team-manifest.spec.ts` — the assertions listed in the table above.
- `plugins/option-wizard/tsconfig.json`, `plugins/option-wizard/package.json` — add `quality`.
- `plugins/option-wizard/render/index.ts` — re-export `extractJson` from `./json.js`; the default export returns `metrics`.
- `packages/core/src/report.ts` — `RunMetric`, `RenderedReport.metrics`, `RunReport.metrics`.
- `packages/core/src/audit.ts` — `metric` table, `appendMetric`, `metrics`.
- `packages/core/src/index.ts` — export `RunMetric` (check whether `report.ts` types are re-exported wholesale first).
- `packages/cli/src/runner.ts` — copy metrics to audit after render; print the `- quality:` line in `deliveryBody`.
- `packages/cli/src/cli.ts` — `helium audit <run>` prints the metric rows.
- `packages/cli/src/runner.test.ts` — one new test.

---

## Task 1: Delete the settlement ceremony from the narrative team (spec item 3)

**Files:**

- Modify: `plugins/option-wizard/team.yaml` (roles `:79-94`, `:322-336`, `:338-348`; tasks `:440-474`, `:765-783`, `:785-796`; `edit.dependsOn` `:618-631`; `weekly` prompt `:803`; `frank-comparator` persona `:372`)
- Modify: `plugins/option-wizard/gates/flash-budget.ts:33-34`
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: a manifest whose task ids are exactly `universe, gex, overnight, regime, scenarios, design, review, edit, weekly, frank` and whose roles no longer include `markout-clerk`, `drift-watcher`, `recap-writer`. Later tasks rely on `flash-budget.appliesTo === ["editor", "regime-analyst"]` and on the new gate using the same two role names.

**Note on what is deliberately NOT edited.** `plugins/option-wizard/tools/index.ts:2427` and `:2443` mention `["markout","recap"]` as EXAMPLES in the `ow_reports` description and `steps` parameter doc. A concurrent agent owns that file. The `steps` parameter accepts any task id, so a stale example is inert; leave it and open a follow-up. Same for the comment at `plugins/option-wizard/tenant.yaml:90`. The tools stay registered — the spec says so explicitly.

- [ ] **Step 1: Write the failing test**

Replace the three assertions in `plugins/option-wizard/tests/team-manifest.spec.ts` that name the dying tasks, and add one that pins the cut. Delete these whole `it` blocks: `:69-82` ("close includes markout and weekly does not"), `:119-127` ("markout settles today's own calls against their own levels"), `:129-138` ("markout may settle only ids the tool returned"), `:140-146` ("close writes today's story"), `:172-185` ("markout settles by id, in four states, so the renderer can check it"). Then edit `:90-98` and `:109-113` and `:153` and `:249-262` as below, and add the new block at the end of the file.

At `:90-98`, replace the `it` body with:

```typescript
it("intraday does not design or review", () => {
  // Leaving a design step in intraday is what made the model produce a
  // fresh set of trades every run: hand it a design task and it will
  // design something, whether or not anything moved.
  expect(runsIn("design", "intraday")).toBe(false);
  expect(runsIn("review", "intraday")).toBe(false);
});
```

Delete the `it("drift reads this morning's own report", ...)` block at `:109-113` entirely.

At `:153`, narrow the loop to the tasks that still exist:

```typescript
  for (const id of ["scenarios", "weekly", "frank"]) {
```

At `:249-262`, replace the `dependsOn` expectation with:

```typescript
expect(task?.dependsOn ?? []).toEqual([
  "universe",
  "gex",
  "overnight",
  "regime",
  "scenarios",
  "design",
  "review",
]);
```

Append a new top-level block to the end of the file:

```typescript
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
```

Add the gate import at the top of the same file, next to the existing imports:

```typescript
import flashBudget from "../gates/flash-budget.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts`
Expected: FAIL — `expected [ ..., 'markout', ... ] not to contain 'markout'`, plus failures on the `dependsOn` array and on `flash-budget guards only roles that still exist`.

- [ ] **Step 3: Cut the three roles from `team.yaml`**

Delete lines `79-95` (the `markout-clerk:` block plus its trailing blank line), lines `322-337` (`drift-watcher:`), lines `338-349` (`recap-writer:`). Do the deletions from the bottom up so earlier line numbers stay valid: `recap-writer` first, then `drift-watcher`, then `markout-clerk`.

- [ ] **Step 4: Cut the three tasks from `team.yaml`**

Delete lines `785-797` (`- id: recap` through its trailing blank line), lines `765-784` (`- id: drift`), lines `440-475` (`- id: markout`). Again bottom-up.

- [ ] **Step 5: Trim `edit.dependsOn` and repoint `weekly`**

In the `- id: edit` block, replace the comment and dependency list (originally `:614-631`) with:

```yaml
# All three daily phases. Intraday shipped eight raw sections and close
# seven on 2026-09-03 because neither had an author; the renderer can cut
# but cannot choose. Phase-scoped dependencies (scenarios, design, review)
# are harmless where they do not run: no text, dropped by handoff.
phases: [premarket, intraday, close]
dependsOn: [universe, gex, overnight, regime, scenarios, design, review]
```

In the `- id: weekly` prompt, replace the first sentence (originally `:803-805`) so it reads the surviving author's step:

```yaml
Call ow_reports with days:7 phase:close steps:["edit"] and
write the week from those five reports alone. If the tool reports
```

In the `frank-comparator` persona (originally `:372`), replace the phrase so it names no dead step:

```yaml
(1) 复盘对照 — his recap of last week against our own weekly 上周总结: where
```

- [ ] **Step 6: Trim `flash-budget`'s `appliesTo`**

In `plugins/option-wizard/gates/flash-budget.ts`, replace lines `33-34` with:

```typescript
  // Every role that can put a `sections` array into a brief. `drift-watcher`
  // and `recap-writer` were removed with the settlement steps on 2026-09-05;
  // a gate naming a role the manifest does not declare guards nothing.
  appliesTo: ["editor", "regime-analyst"],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts plugins/option-wizard/tests/render.spec.ts plugins/option-wizard/tests/render-newsletter.spec.ts plugins/option-wizard/tests/gate-flash-budget.spec.ts`
Expected: PASS, all four files.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/gates/flash-budget.ts plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "refactor(option-wizard): drop markout, drift and recap steps from the narrative team"
```

---

## Task 2: The `meta-leak` pattern module and advisory gate (spec item 2)

**Files:**

- Create: `plugins/option-wizard/render/json.ts`
- Create: `plugins/option-wizard/quality/meta-leak.ts`
- Create: `plugins/option-wizard/gates/meta-leak.ts`
- Create: `plugins/option-wizard/tests/gate-meta-leak.spec.ts`
- Modify: `plugins/option-wizard/render/index.ts` (move `extractJson` out, re-export it)
- Modify: `plugins/option-wizard/tsconfig.json`, `plugins/option-wizard/package.json`

**Interfaces:**

- Consumes: `Gate`, `GateCtx` from `@helium/core` (`packages/core/src/plugins.ts:151-169`); `flash-budget`'s structure as the template.
- Produces:
  - `export function extractJson(text: string): Record<string, unknown> | null` from `plugins/option-wizard/render/json.ts`, still re-exported from `render/index.ts` so `gates/flash-budget.ts`, `gates/cause-citation.ts` and `tools/index.ts` keep compiling unchanged.
  - `export interface Leak { field: string; pattern: string; excerpt: string }`
  - `export const META_LEAK_PATTERNS: readonly string[]`
  - `export function findMetaLeaks(doc: unknown): Leak[]`
  - a default-exported `Gate` with `id: "meta-leak"`, `phase: "output"`, `advisory: true`, `appliesTo: ["editor", "regime-analyst"]`.

- [ ] **Step 1: Write the failing test**

Create `plugins/option-wizard/tests/gate-meta-leak.spec.ts`:

```typescript
/**
 * The `meta-leak` advisory gate. The editor persona already forbade
 * replay/coverage words in prose; v3 still shipped "No prior intraday brief
 * exists" as a headline (docs/evidence/pit-replays/2026-09-05/pit-v3/). A
 * persona is a request; this is a match.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-meta-leak
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/meta-leak.js";
import { findMetaLeaks } from "../quality/meta-leak.js";

const ctx = { runId: "run-1", role: "editor" } as never;

describe("findMetaLeaks", () => {
  it("finds one violation in a headline that names a missing prior brief", () => {
    const leaks = findMetaLeaks({
      headline: "No prior intraday brief exists — starting from today.",
      sections: [],
    });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.field).toBe("headline");
    expect(leaks[0]!.pattern).toBe("no prior \\w+ brief");
    expect(leaks[0]!.excerpt).toContain("No prior intraday brief");
  });

  it("does not scan the coverage block", () => {
    // The coverage block is where "unavailable" BELONGS: it is the honest
    // record of what could not be read. Gating it would push the run into
    // hiding its own gaps, which is the opposite of the point.
    const leaks = findMetaLeaks({
      headline: "A bear-steepener took the 10Y to 4.788%.",
      sections: [{ title: "Rates led", body: "The 10Y sat at 4.79%." }],
      coverage: {
        title: "Layer Coverage",
        body: "Tape — ow_spot unavailable, skipped. Events — calendar unavailable.",
      },
    });
    expect(leaks).toEqual([]);
  });

  it("names the field for a section title and a section body separately", () => {
    const leaks = findMetaLeaks({
      headline: "Clean.",
      sections: [
        { title: "This is a replay", body: "Nothing to see." },
        { title: "Fine", body: "The tape was frozen at the open." },
      ],
    });
    expect(leaks.map((leak) => leak.field)).toEqual([
      "section 1 title",
      "section 2 body",
    ]);
  });

  it("scans decision values in both the object and the row shape", () => {
    const asObject = findMetaLeaks({
      headline: "Clean.",
      sections: [],
      decision: { Call: "Nothing ships today.", Action: "Sit." },
    });
    const asRows = findMetaLeaks({
      headline: "Clean.",
      sections: [],
      decision: [
        { label: "Call", value: "Nothing ships today." },
        { label: "Action", value: "Sit." },
      ],
    });
    expect(asObject.map((leak) => leak.field)).toEqual(["decision Call"]);
    expect(asRows.map((leak) => leak.field)).toEqual(["decision Call"]);
  });

  it("is case-insensitive and matches every listed pattern once", () => {
    const leaks = findMetaLeaks({
      headline:
        "REPLAY as-of unavailable FROZEN nothing ships no prior close brief not checked",
      sections: [],
    });
    expect(leaks).toHaveLength(7);
  });
});

describe("meta-leak gate", () => {
  it("is advisory and never blocks delivery", () => {
    expect(gate.id).toBe("meta-leak");
    expect(gate.phase).toBe("output");
    expect(gate.advisory).toBe(true);
    expect(gate.appliesTo).toEqual(["editor", "regime-analyst"]);
  });

  it("refuses the v3 headline and names field, pattern and excerpt", async () => {
    const text = JSON.stringify({
      headline: "No prior intraday brief exists — starting from today.",
      sections: [],
    });
    const result = await gate.check({ text }, ctx);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("1 meta leak");
    expect(result.reason).toContain("headline");
    expect(result.reason).toContain("no prior \\w+ brief");
    expect(result.reason).toContain("No prior intraday brief");
  });

  it("passes a clean brief whose coverage block admits an unavailable source", async () => {
    const text = JSON.stringify({
      headline: "A bear-steepener took the 10Y to 4.788%.",
      sections: [{ title: "Rates led", body: "The 10Y sat at 4.79%." }],
      coverage: {
        title: "Layer Coverage",
        body: "Tape — ow_spot unavailable.",
      },
    });
    const result = await gate.check({ text }, ctx);
    expect(result.pass).toBe(true);
  });

  it("passes a step whose text is not a document at all", async () => {
    const result = await gate.check({ text: "no json here" }, ctx);
    expect(result.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/gate-meta-leak.spec.ts`
Expected: FAIL — `Cannot find module '../gates/meta-leak.js'`.

- [ ] **Step 3: Move `extractJson` into its own module**

Create `plugins/option-wizard/render/json.ts` and move the body of `extractJson` there verbatim from `plugins/option-wizard/render/index.ts:224-250`:

````typescript
/**
 * The last JSON object in a step's text, fenced or bare.
 *
 * Its own module so that `quality/` can parse a step without importing the
 * renderer: `render/index.ts` imports `quality/index.ts`, and a module that
 * imported back would be a cycle. Nothing here knows what a brief IS.
 * @module dsh-plugin-tenant-option-wizard/render/json
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  // Last resort: the widest brace span. A reviewer that forgets the fence still
  // gets read rather than costing the reader the whole brief.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first)
    candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        return parsed as Record<string, unknown>;
    } catch {
      // Not JSON. Try the next candidate.
    }
  }
  return null;
}
````

Copy the `try`/`catch` body from the original at `render/index.ts:238-250` exactly — do not retype it from this plan if the original differs; the original is authoritative. Then in `render/index.ts`, delete the `extractJson` function and add near the other imports:

```typescript
import { extractJson } from "./json.js";
```

and near the other exports at the top of the file (`render/index.ts:20-37`):

```typescript
export { extractJson } from "./json.js";
```

- [ ] **Step 4: Write the pattern module**

Create `plugins/option-wizard/quality/meta-leak.ts`:

```typescript
/**
 * Words the brief may not say about ITSELF.
 *
 * The editor persona has forbidden replay and coverage vocabulary in prose
 * since 2026-09-03, and the v3 replay still shipped "No prior intraday brief
 * exists" as a section title. A persona is a request; a pattern list is a
 * match. The list lives in the tenant because these are English words about
 * a market brief, and core knows no domain (doctrine 2).
 *
 * The `coverage` block is deliberately NOT scanned: it is the honest record
 * of what could not be read, and gating it would teach the run to hide its
 * own gaps.
 * @module dsh-plugin-tenant-option-wizard/quality/meta-leak
 */

/** Regex SOURCES, not RegExp objects: a shared `/g` RegExp carries
 *  `lastIndex` between calls, so two scans of the same text disagree. Each
 *  scan compiles its own. */
export const META_LEAK_PATTERNS: readonly string[] = [
  "\\breplay\\b",
  "\\bas-of\\b",
  "\\bunavailable\\b",
  "\\bfrozen\\b",
  "nothing ships",
  "no prior \\w+ brief",
  "not (?:checked|available|live)",
];

export interface Leak {
  /** `headline`, `decision Call`, `section 3 title`, `section 3 body`. */
  field: string;
  /** The pattern source that matched, verbatim from META_LEAK_PATTERNS. */
  pattern: string;
  /** The match with 20 characters of context on each side. */
  excerpt: string;
}

const CONTEXT_CHARS = 20;

function scan(field: string, text: unknown, out: Leak[]): void {
  if (typeof text !== "string" || text === "") return;
  for (const pattern of META_LEAK_PATTERNS) {
    const regex = new RegExp(pattern, "giu");
    for (const match of text.matchAll(regex)) {
      const at = match.index;
      out.push({
        field,
        pattern,
        excerpt: text.slice(
          Math.max(0, at - CONTEXT_CHARS),
          at + match[0].length + CONTEXT_CHARS,
        ),
      });
    }
  }
}

/**
 * Every hit over a brief-shaped document's headline, decision values and
 * section titles and bodies. Unknown or missing fields are simply not
 * scanned — a step whose JSON has no `sections` is a step doing something
 * else, the same rule `measure()` in render/budget.ts follows.
 */
export function findMetaLeaks(doc: unknown): Leak[] {
  if (doc === null || typeof doc !== "object") return [];
  const row = doc as {
    headline?: unknown;
    decision?: unknown;
    sections?: unknown;
  };
  const out: Leak[] = [];
  scan("headline", row.headline, out);
  if (Array.isArray(row.decision)) {
    for (const entry of row.decision) {
      const cell = (entry ?? {}) as { label?: unknown; value?: unknown };
      scan(
        `decision ${typeof cell.label === "string" ? cell.label : "?"}`,
        cell.value,
        out,
      );
    }
  } else if (row.decision !== null && typeof row.decision === "object") {
    for (const [label, value] of Object.entries(
      row.decision as Record<string, unknown>,
    ))
      scan(`decision ${label}`, value, out);
  }
  if (Array.isArray(row.sections)) {
    row.sections.forEach((section: unknown, i: number) => {
      const cell = (section ?? {}) as { title?: unknown; body?: unknown };
      scan(`section ${String(i + 1)} title`, cell.title, out);
      scan(`section ${String(i + 1)} body`, cell.body, out);
    });
  }
  return out;
}
```

- [ ] **Step 5: Write the gate**

Create `plugins/option-wizard/gates/meta-leak.ts`:

```typescript
/**
 * The brief may not talk about itself, MEASURED.
 *
 * Advisory for the same reason `flash-budget` is: the reader is better served
 * by a brief with a leak in it than by no brief, and a refusal here is a row
 * in the audit table plus one degradation line naming the exact field,
 * pattern and excerpt. Same mechanism, same semantics, same file shape.
 * @module dsh-plugin-tenant-option-wizard/gates/meta-leak
 */
import type { Gate, GateCtx } from "@helium/core";
import { extractJson } from "../render/json.js";
import { findMetaLeaks } from "../quality/meta-leak.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "meta-leak",
  phase: "output",
  advisory: true,
  // Every role that writes prose a reader sees.
  appliesTo: ["editor", "regime-analyst"],
  async check(
    input: unknown,
    _ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const parsed = extractJson(textOf(input));
    if (parsed === null) return { pass: true, reason: "no document to scan" };
    const leaks = findMetaLeaks(parsed);
    if (leaks.length === 0)
      return { pass: true, reason: "no meta words in the prose" };
    return {
      pass: false,
      reason:
        `${String(leaks.length)} meta leak${leaks.length === 1 ? "" : "s"}: ` +
        leaks
          .map((leak) => `${leak.field} /${leak.pattern}/ "${leak.excerpt}"`)
          .join("; "),
    };
  },
};

export default gate;
```

- [ ] **Step 6: Add `quality` to the tenant build**

In `plugins/option-wizard/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "lib", "rootDir": "." },
  "include": ["tools", "gates", "render", "quality"]
}
```

In `plugins/option-wizard/package.json`, extend `files`:

```json
  "files": ["lib", "tools", "gates", "render", "quality", "tenant.yaml", "team.yaml"],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/gate-meta-leak.spec.ts`
Expected: PASS, 8 tests.

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/`
Expected: PASS — in particular `render.spec.ts`, `render-flash-budget.spec.ts` and `gate-cause-citation.spec.ts`, which all consume `extractJson` through `render/index.js` and must be unaffected by the move.

- [ ] **Step 8: Verify the gate loads by glob, with no core edit**

Run: `pnpm build && node -e "import('./packages/cli/lib/discovery.js').then(async (m) => { const r = await m.loadGates('plugins/option-wizard'); console.log(r.gates.map((g) => g.id).sort(), r.skipped); })"`
Expected: the printed id list contains `meta-leak` alongside `as-of-verbatim`, `cause-citation`, `design-spot`, `flash-budget`, `ib-preflight`, and `skipped` is `[]`. If the CLI's built entrypoint path differs, use `packages/cli/lib/src/discovery.js` — check with `ls packages/cli/lib` first.

- [ ] **Step 9: Run the whole suite and the neutrality contract**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS — nothing was added to `packages/core/src` in this task.

- [ ] **Step 10: Commit**

```bash
git add plugins/option-wizard/render/json.ts plugins/option-wizard/render/index.ts plugins/option-wizard/quality/meta-leak.ts plugins/option-wizard/gates/meta-leak.ts plugins/option-wizard/tests/gate-meta-leak.spec.ts plugins/option-wizard/tsconfig.json plugins/option-wizard/package.json
git commit -m "feat(option-wizard): add the meta-leak advisory gate beside flash-budget"
```

---

## Task 3: A core-neutral `metric` table and the `RunMetric` seam (spec item 5, storage half)

**Files:**

- Modify: `packages/core/src/report.ts:94-119` (add `RunMetric`, `RenderedReport.metrics`, `RunReport.metrics`)
- Modify: `packages/core/src/audit.ts:65-79, 99-120` (schema, migration, `appendMetric`, `metrics`)
- Modify: `packages/core/src/index.ts` (export `RunMetric` if types are named individually)
- Test: `packages/core/tests/audit-metric.spec.ts`

**Interfaces:**

- Consumes: `AuditStore` (`packages/core/src/audit.ts:99-264`).
- Produces:
  - `export interface RunMetric { name: string; short: string; value: number | null }`
  - `RenderedReport.metrics?: RunMetric[]` and `RunReport.metrics?: RunMetric[]`
  - `export interface MetricRow { runId: string; name: string; value: number | null; ts: string; day: string; label: string }`
  - `AuditStore.appendMetric(row: MetricRow): void`
  - `AuditStore.metrics(runId: string): Array<{ name: string; value: number | null }>` — sorted by `name`.
  - `AuditStore.metricsFor(day: string, label: string): Array<{ name: string; value: number | null }>` — the NEWEST run for that `(day, label)` only, sorted by `name`.
  - `AuditStore.metricsBetween(fromDay: string, toDay: string): Array<{ day: string; label: string; name: string; value: number | null }>` — every `(day, label)`'s newest run in the inclusive range, ordered by `day`, then `label`, then `name`.

**The name collision this design used to have is removed.** `RunMetric.short` is the short DISPLAY key the header line prints (`leaks`, `budget`, `cause-sim`). `MetricRow.label` and the `metric.label` COLUMN are the RUN label — `premarket`, `intraday`, `close`, `weekly` — the same string `RunOptions.phase` carries. Task 4 writes `label: phase` onto a `MetricRow` while reading `metric.short` off a `RunMetric` two lines apart; both are correct and the comment there says so.

**Why `(day, label)` and not just `run_id`.** A run id is a UUID and nothing maps it back to a day or a run label, so a query like "how did cause-sim move over the last five sessions" was unanswerable — which pushed the weekly review (Task 15) toward parsing numbers back out of a rendered markdown header. Adding the two columns the run already has costs six characters of schema and makes the table answer the question it exists for (doctrine 4: "where did the tokens go" must be answerable in one query, and so must "is the writing getting worse").

**Neutrality note.** Every identifier added here is `metric`, `name`, `value`, `label`, `day`, `run_id`, `ts`, `metricsFor`, `metricsBetween`. None is on either forbidden list, and none names a market, a tenant, a provider or a specific phase — `label` and `day` are as opaque to core as `phase` already is in `RunOptions`. Read the words back against `contracts/tests/core-neutrality.contract.spec.ts:24-40` before committing.

**Doctrine note to write into the code comment.** `span` rows are a projection folded from the session log (`packages/core/src/audit.ts:1-15`). A metric is NOT: it is a number a tenant computed once from its own finished report. It therefore gets its own table rather than a column on `span`, and it is idempotent on `(run_id, name)` so a re-render overwrites rather than doubles.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/audit-metric.spec.ts`:

```typescript
/**
 * The `metric` table: one row per run per named number. Core never learns
 * what a name means — the whole point of the table is that a tenant can add
 * a number without a core edit.
 * @module core/tests/audit-metric
 */
import { describe, expect, it } from "vitest";
import { AuditStore } from "../src/audit.js";

const ts = "2026-09-05T20:15:00.000Z";
const day = "2026-09-04";
// The RUN label, not the display key: `metric.label` names which of the day's
// runs wrote the number.
const label = "premarket";

describe("AuditStore metrics", () => {
  it("stores and reads back one row per name", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 3,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "beta",
      value: 0.107,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([
      { name: "alpha", value: 3 },
      { name: "beta", value: 0.107 },
    ]);
    store.close();
  });

  it("stores a null value as NULL and reads it back as null", () => {
    // "not computable this run" is a real answer and must not become 0: a
    // zero similarity and a missing prior report are different facts.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "gamma",
      value: null,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "gamma", value: null }]);
    store.close();
  });

  it("is idempotent on (run_id, name), so a second write overwrites", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 3,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 4,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "alpha", value: 4 }]);
    store.close();
  });

  it("keeps runs apart", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-2",
      name: "alpha",
      value: 2,
      ts,
      day,
      label,
    });
    expect(store.metrics("run-1")).toEqual([{ name: "alpha", value: 1 }]);
    expect(store.metrics("run-2")).toEqual([{ name: "alpha", value: 2 }]);
    store.close();
  });

  it("returns nothing for a run that wrote no metric", () => {
    const store = new AuditStore(":memory:");
    expect(store.metrics("run-nothing")).toEqual([]);
    store.close();
  });
});

describe("AuditStore metricsFor", () => {
  it("reads a day and a run label back without knowing the run id", () => {
    // The whole reason the two columns exist: a UUID is not a question anyone
    // asks, and "how did premarket score on the 4th" is.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-1",
      name: "beta",
      value: null,
      ts,
      day,
      label,
    });
    expect(store.metricsFor(day, label)).toEqual([
      { name: "alpha", value: 1 },
      { name: "beta", value: null },
    ]);
    store.close();
  });

  it("returns only the NEWEST run when one (day, label) ran twice", () => {
    // A re-run of premarket is normal — a failed provider, a replay under a
    // different variant. Two runs' numbers averaged together are one number
    // that describes neither.
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-old",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day,
      label,
    });
    store.appendMetric({
      runId: "run-new",
      name: "alpha",
      value: 9,
      ts: "2026-09-04T13:00:00.000Z",
      day,
      label,
    });
    expect(store.metricsFor(day, label)).toEqual([{ name: "alpha", value: 9 }]);
    store.close();
  });

  it("keeps two run labels on one day apart", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-1",
      name: "alpha",
      value: 1,
      ts,
      day,
      label,
    });
    store.appendMetric({
      runId: "run-2",
      name: "alpha",
      value: 2,
      ts,
      day,
      label: "close",
    });
    expect(store.metricsFor(day, "close")).toEqual([
      { name: "alpha", value: 2 },
    ]);
    store.close();
  });

  it("returns nothing for a (day, label) that never ran", () => {
    const store = new AuditStore(":memory:");
    expect(store.metricsFor("2026-01-01", "premarket")).toEqual([]);
    store.close();
  });
});

describe("AuditStore metricsBetween", () => {
  function seed(store: AuditStore): void {
    for (const [d, l, v] of [
      ["2026-08-31", "premarket", 1],
      ["2026-09-01", "close", 2],
      ["2026-09-04", "premarket", 3],
      ["2026-09-04", "close", 4],
      ["2026-09-08", "premarket", 5],
    ] as Array<[string, string, number]>)
      store.appendMetric({
        runId: `run-${d}-${l}`,
        name: "alpha",
        value: v,
        ts: `${d}T12:00:00.000Z`,
        day: d,
        label: l,
      });
  }

  it("returns the range inclusively, ordered by day then label then name", () => {
    const store = new AuditStore(":memory:");
    seed(store);
    expect(
      store
        .metricsBetween("2026-08-31", "2026-09-04")
        .map((row) => [row.day, row.label, row.value]),
    ).toEqual([
      ["2026-08-31", "premarket", 1],
      ["2026-09-01", "close", 2],
      ["2026-09-04", "close", 4],
      ["2026-09-04", "premarket", 3],
    ]);
    store.close();
  });

  it("takes only the newest run of each (day, label) in the range", () => {
    const store = new AuditStore(":memory:");
    store.appendMetric({
      runId: "run-a",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    store.appendMetric({
      runId: "run-b",
      name: "alpha",
      value: 7,
      ts: "2026-09-04T14:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    expect(store.metricsBetween("2026-09-04", "2026-09-04")).toEqual([
      { day: "2026-09-04", label: "premarket", name: "alpha", value: 7 },
    ]);
    store.close();
  });

  it("returns nothing for a range with no runs in it", () => {
    const store = new AuditStore(":memory:");
    seed(store);
    expect(store.metricsBetween("2026-09-05", "2026-09-07")).toEqual([]);
    store.close();
  });

  // The mini's audit.db predates this table. AuditStore runs SCHEMA on every
  // open (packages/core/src/audit.ts constructor), so an old file must gain
  // the table on first open with its span rows untouched.
  it("adds the metric table to a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-metric-"));
    const path = join(dir, "audit.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE span (run_id TEXT NOT NULL, span_id TEXT NOT NULL, code_version TEXT NOT NULL DEFAULT 'unknown')",
    );
    old.exec("INSERT INTO span (run_id, span_id) VALUES ('legacy', 's1')");
    old.close();
    const store = new AuditStore(path);
    store.appendMetric({
      runId: "legacy",
      name: "alpha",
      value: 1,
      ts: "2026-09-04T12:00:00.000Z",
      day: "2026-09-04",
      label: "premarket",
    });
    expect(store.metrics("legacy")).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Imports for that last test: `import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { DatabaseSync } from "node:sqlite";`. If the constructor's span-column ALTER rejects the minimal span table above, add the columns `SCHEMA` at `packages/core/src/audit.ts:65-79` declares NOT NULL without a default — the test's job is the metric table, not a faithful old schema.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit packages/core/tests/audit-metric.spec.ts`
Expected: FAIL — `store.appendMetric is not a function`.

- [ ] **Step 3: Add the table and the four methods**

In `packages/core/src/audit.ts`, extend `SCHEMA` (currently `:65-79`) by appending to the template literal, after the existing `CREATE INDEX` line:

```typescript
CREATE TABLE IF NOT EXISTS metric (
  run_id TEXT NOT NULL, name TEXT NOT NULL, value REAL, ts TEXT NOT NULL,
  day TEXT NOT NULL, label TEXT NOT NULL,
  PRIMARY KEY (run_id, name));
CREATE INDEX IF NOT EXISTS metric_day_label ON metric(day, label);
```

Add, just above `export class AuditStore`:

```typescript
/**
 * One named number a run produced, stored so a `SELECT` shows the trend.
 *
 * NOT a span. A span row is a projection folded from the session log; this is
 * a number whoever produced the run's output computed from it, and core never
 * learns what any `name` means. `value` is nullable because "not computable
 * this run" is a fact worth keeping and is not the same as zero.
 *
 * `day` and `label` are the run's own two coordinates, carried so the table
 * can be asked a question a human has: a run id is a UUID, and "how did this
 * number move over the last five sessions" cannot be asked of one. Core reads
 * neither — it stores them and compares them as strings.
 *
 * `MetricRow.label` is the RUN label (`premarket`, `close`); the short
 * display key the report header prints is `RunMetric.short`, a different
 * field on a different type — no collision between the two remains.
 * The two live one function apart in packages/cli/src/runner.ts.
 */
export interface MetricRow {
  runId: string;
  name: string;
  value: number | null;
  ts: string;
  /** The run's report day, `yyyy-mm-dd` in whatever zone the run counts in. */
  day: string;
  /** The run label — the same string `RunOptions.phase` carries. */
  label: string;
}
```

Add these four methods to `AuditStore`, after `spent` (`:249-259`):

```typescript
  /**
   * Append one named number. Idempotent on `(run_id, name)` so a re-render of
   * the same run rewrites rather than doubles.
   */
  appendMetric(row: MetricRow): void {
    this.#db
      .prepare(
        `INSERT INTO metric (run_id, name, value, ts, day, label)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(run_id, name) DO UPDATE SET
           value=excluded.value, ts=excluded.ts,
           day=excluded.day, label=excluded.label`,
      )
      .run(row.runId, row.name, row.value, row.ts, row.day, row.label);
  }

  /** Every named number one run wrote, by name. */
  metrics(runId: string): Array<{ name: string; value: number | null }> {
    return (
      this.#db
        .prepare("SELECT name, value FROM metric WHERE run_id = ? ORDER BY name")
        .all(runId) as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      name: String(row.name),
      value: row.value === null ? null : Number(row.value),
    }));
  }

  /**
   * One `(day, label)`'s numbers, from its NEWEST run only.
   *
   * Newest by `ts`, not by insertion order: a `(day, label)` runs twice more
   * often than it looks — a retried provider, a replay under another variant —
   * and two runs' numbers read together describe neither of them.
   */
  metricsFor(
    day: string,
    label: string,
  ): Array<{ name: string; value: number | null }> {
    return (
      this.#db
        .prepare(
          `SELECT name, value FROM metric
           WHERE day = ? AND label = ? AND run_id = (
             SELECT run_id FROM metric WHERE day = ? AND label = ?
             ORDER BY ts DESC, run_id DESC LIMIT 1)
           ORDER BY name`,
        )
        .all(day, label, day, label) as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      name: String(row.name),
      value: row.value === null ? null : Number(row.value),
    }));
  }

  /**
   * Every `(day, label)`'s newest run over an inclusive day range, ordered by
   * day, then label, then name. This is the query the whole table exists for:
   * one call answers "what happened to these numbers over the last N
   * sessions", and the caller decides which days are sessions.
   *
   * Days are compared as STRINGS. `yyyy-mm-dd` sorts correctly that way, and a
   * date function here would need a timezone the table deliberately does not
   * have.
   */
  metricsBetween(
    fromDay: string,
    toDay: string,
  ): Array<{
    day: string;
    label: string;
    name: string;
    value: number | null;
  }> {
    return (
      this.#db
        .prepare(
          `SELECT m.day, m.label, m.name, m.value FROM metric m
           JOIN (SELECT day, label, run_id,
                        ROW_NUMBER() OVER (PARTITION BY day, label
                          ORDER BY ts DESC, run_id DESC) rn
                 FROM metric WHERE day >= ? AND day <= ?) newest
             ON newest.run_id = m.run_id AND newest.rn = 1
           WHERE m.day >= ? AND m.day <= ?
           ORDER BY m.day, m.label, m.name`,
        )
        .all(fromDay, toDay, fromDay, toDay) as unknown as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      day: String(row.day),
      label: String(row.label),
      name: String(row.name),
      value: row.value === null ? null : Number(row.value),
    }));
  }
```

**Migration note.** `audit.db` outlives releases (`packages/core/src/audit.ts:90-96`), but the `metric` table is created BY THIS PR, so no deployed database has one and `CREATE TABLE IF NOT EXISTS` with the two columns is enough. Do NOT add an `ALTER TABLE` dance like the `code_version` one at `:108-120` — there is nothing to migrate, and a migration that has never run is ceremony (doctrine 6).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit packages/core/tests/audit-metric.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the `RunMetric` seam to the report types**

In `packages/core/src/report.ts`, add above `export interface RunReport`:

```typescript
/**
 * A deterministic number one run produced, on its way to the audit table and
 * to the report header.
 *
 * Core never reads a `name` or a `short` and never computes a `value`: whoever
 * rendered the run is the only thing that knows what any of them mean, the
 * same rule that keeps `toolOutputs` a string. `value` is `null` when the run
 * could not compute the number — which is not zero.
 */
export interface RunMetric {
  /** Storage key, written to the audit table verbatim. */
  name: string;
  /** Short display key for the one-line header. */
  short: string;
  value: number | null;
}
```

Add to `RunReport` (after `pitCoverage`, `:86-91`):

```typescript
  /**
   * What the tenant's renderer measured about this run. Absent when the
   * tenant ships no renderer or its renderer computes nothing.
   */
  metrics?: RunMetric[];
```

Add to `RenderedReport` (after `data`, `:118`):

```typescript
  /**
   * Numbers the renderer computed while it built the document. The runner
   * copies them to the audit table and prints one line of them in the header;
   * it does not interpret them.
   */
  metrics?: RunMetric[];
```

- [ ] **Step 6: Export the type**

Check how `packages/core/src/index.ts` re-exports `report.ts`. If it is a wildcard (`export * from "./report.js"`), nothing to do. If types are named individually, add `RunMetric` to that list. Verify with:

Run: `grep -n "report.js" packages/core/src/index.ts`

- [ ] **Step 7: Run typecheck, the suite, and the neutrality contract**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS. If it fails, a word you added is on one of the two lists at `contracts/tests/core-neutrality.contract.spec.ts:24-40` — rename it, never add an exemption (the test has no allow-list by design, `:54-63`).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/audit.ts packages/core/src/report.ts packages/core/src/index.ts packages/core/tests/audit-metric.spec.ts
git commit -m "feat(core): add a metric table and a RunMetric seam for tenant-computed numbers"
```

---

## Task 4: The runner writes metric rows and prints the `- quality:` header line (spec item 5, plumbing half)

**Files:**

- Modify: `packages/cli/src/runner.ts:1233-1242` (after render) and `:1309-1369` (`deliveryBody`)
- Test: `packages/cli/src/runner.test.ts`

**Interfaces:**

- Consumes: `RunMetric`, `MetricRow`, `AuditStore.appendMetric`, `AuditStore.metrics`, `AuditStore.metricsFor` from Task 3.
- Produces: for every run whose renderer returned `metrics`, one audit row per metric — each carrying the run's `day` and `label`, so Task 15 can read them back without a run id — and one header line `- quality: <short>=<value> ...`, where an integer prints bare, a fraction prints `toFixed(2)`, and `null` prints `n/a`.

**No collision between the two.** `metric.short` on a `RunMetric` is the display key (`leaks`); `label` on a `MetricRow` is the RUN label (`premarket`). Step 3 writes one and Step 4 reads the other, six lines apart. Both are right, and they no longer share a name.

**Rebase warning.** A concurrent agent is editing this file for the calendar skip. `git pull --rebase` (or rebase onto their branch) immediately before Step 3, and re-locate the two anchors by content rather than by line number: the render block begins `let rendered: RenderedReport | undefined;` and the header block begins `if (report.asOf !== undefined) {` inside `deliveryBody`.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/runner.test.ts`:

```typescript
describe("run metrics", () => {
  const bodies: string[] = [];
  const capture: Channel = {
    id: "fake-mail",
    external: false,
    deliver: async (payload) => {
      bodies.push(payload.body);
      return { state: "sent" };
    },
  };

  it("writes one audit row per metric and prints one quality line", async () => {
    const audit = new AuditStore(":memory:");
    bodies.length = 0;
    const report = await runTenant({
      tenant: tenant(1, DELIVERY_YAML),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      phase: "premarket",
      modelExecutor,
      channels: [capture],
      renderer: () => ({
        text: "rendered",
        metrics: [
          { name: "metaLeakHits", short: "leaks", value: 1 },
          { name: "budgetViolations", short: "budget", value: 0 },
          { name: "causeTitleSimilarity", short: "cause-sim", value: 0.107 },
        ],
      }),
    });
    expect(audit.metrics(report.runId)).toEqual([
      { name: "budgetViolations", value: 0 },
      { name: "causeTitleSimilarity", value: 0.107 },
      { name: "metaLeakHits", value: 1 },
    ]);
    // The same three rows, reachable WITHOUT the run id. This is what Task 15
    // reads and it is the whole reason the two columns exist.
    expect(audit.metricsFor(report.day, "premarket")).toEqual([
      { name: "budgetViolations", value: 0 },
      { name: "causeTitleSimilarity", value: 0.107 },
      { name: "metaLeakHits", value: 1 },
    ]);
    expect(
      audit.metricsBetween(report.day, report.day).map((row) => row.label),
    ).toEqual(["premarket", "premarket", "premarket"]);
    expect(report.metrics).toHaveLength(3);
    expect(bodies[0]).toContain("- quality: leaks=1 budget=0 cause-sim=0.11");
    audit.close();
  });

  it("prints n/a for a metric the run could not compute", async () => {
    const audit = new AuditStore(":memory:");
    bodies.length = 0;
    const report = await runTenant({
      tenant: tenant(1, DELIVERY_YAML),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      modelExecutor,
      channels: [capture],
      renderer: () => ({
        text: "rendered",
        metrics: [
          { name: "causeTitleSimilarity", short: "cause-sim", value: null },
        ],
      }),
    });
    expect(audit.metrics(report.runId)).toEqual([
      { name: "causeTitleSimilarity", value: null },
    ]);
    expect(bodies[0]).toContain("- quality: cause-sim=n/a");
    audit.close();
  });

  it("prints no quality line when the renderer measured nothing", async () => {
    const audit = new AuditStore(":memory:");
    bodies.length = 0;
    const report = await runTenant({
      tenant: tenant(1, DELIVERY_YAML),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      modelExecutor,
      channels: [capture],
      renderer: () => ({ text: "rendered" }),
    });
    expect(audit.metrics(report.runId)).toEqual([]);
    expect(report.metrics).toBeUndefined();
    expect(bodies[0]).not.toContain("- quality:");
    audit.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts -t "run metrics"`
Expected: FAIL — `audit.metrics(...)` returns `[]` and the body has no `- quality:` line.

- [ ] **Step 3: Copy the metrics to the audit table after rendering**

In `packages/cli/src/runner.ts`, immediately after the render `try`/`catch` block (currently ending at `:1242`, before `const brake = env.HELIUM_TENANT_DELIVERY === "1";`), insert:

```typescript
// Written AFTER rendering and BEFORE delivery: the renderer is what
// computes them, and the header line the channels carry is built from
// `report.metrics`. Core stores name, value, day and label, and reads none
// of them.
//
// `label: phase` is the RUN label — premarket, close. The header's display
// key is `metric.short`, a different field on a different type, so there is
// no collision to keep straight. The row is keyed by what the run WAS; the
// header prints how the number READS. Without `day` and `label` this table
// is keyed only by a UUID, and the weekly review would have to parse its own
// numbers back out of a rendered markdown header.
if (rendered?.metrics !== undefined && rendered.metrics.length > 0) {
  report.metrics = rendered.metrics;
  const measuredAt = new Date().toISOString();
  for (const metric of rendered.metrics)
    options.audit.appendMetric({
      runId,
      name: metric.name,
      value: metric.value,
      ts: measuredAt,
      day: report.day,
      label: phase,
    });
}
```

- [ ] **Step 4: Print the header line**

In `deliveryBody`, immediately after the closing brace of the `if (report.asOf !== undefined) { ... }` block (currently `:1341`) and before `for (const skip of report.providersSkipped)` (`:1342`), insert:

```typescript
// One line, on every run, not only on a replay: a number nobody sees on an
// ordinary day is a number nobody notices moving.
if (report.metrics !== undefined && report.metrics.length > 0) {
  lines.push(
    `- quality: ${report.metrics
      .map((metric) => `${metric.short}=${formatMetric(metric.value)}`)
      .join(" ")}`,
  );
}
```

And add, next to `deliveryBody` (below it, above `summariseToolLines`):

```typescript
/**
 * An integer prints bare, a fraction to two places, an uncomputed number as
 * `n/a`. Two places because the header is scanned, not computed from; the
 * audit table keeps the full value.
 */
function formatMetric(value: number | null): string {
  if (value === null) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts`
Expected: PASS, including the three new cases and every pre-existing delivery test.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/runner.ts packages/cli/src/runner.test.ts
git commit -m "feat(cli): write tenant metrics to the audit table and print a quality header line"
```

---

## Task 5: Jaccard similarity over cause titles (spec item 5, arithmetic)

**Files:**

- Create: `plugins/option-wizard/quality/similarity.ts`
- Test: `plugins/option-wizard/tests/quality-similarity.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export const STOPWORDS: ReadonlySet<string>`
  - `export function wordSet(title: string): Set<string>` — lowercase, split on whitespace, strip leading and trailing characters that are neither letters, digits nor `%`, drop empties and stopwords.
  - `export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number` — `|a ∩ b| / |a ∪ b|`, and `0` when both are empty.

### The pinned value, computed by hand

Two real cause-section titles from `docs/evidence/pit-replays/2026-09-05/pit-v3/`:

**Title A** — `option-wizard-2026-09-01-intraday.md`, the `edit` step's first section title:
`A hawkish front end: futures put 64% on a September hike while the 10Y sits at 4.75%, its highest August close`

**Title B** — `option-wizard-2026-09-04-premarket.md`, the `edit` step's first section title:
`August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give the labor market`

Stopwords removed (the spec's list, verbatim): `the, a, an, of, to, in, and, not, is, at, on, for`.

Word set A (16 members) — `a`, `on`, `the`, `at` dropped as stopwords; `end:` loses its colon, `4.75%,` loses its comma:

```
hawkish, front, end, futures, put, 64%, september, hike, while, 10y, sits, 4.75%, its, highest, august, close
```

Word set B (15 members) — `in`, `to`, `the` (x2) dropped; `+55k` loses its `+`; the em dash reduces to an empty token and is dropped; `back-revisions` keeps its internal hyphen:

```
august, payrolls, printed, 162k, with, 55k, back-revisions, front, end, has, no, cut, give, labor, market
```

Intersection = `{august, front, end}` → **3**
Union = 16 + 15 − 3 = **28**
Jaccard = **3 / 28 = 0.10714285714285714**, which the header prints as `cause-sim=0.11`.

- [ ] **Step 1: Write the failing test**

Create `plugins/option-wizard/tests/quality-similarity.spec.ts`:

```typescript
/**
 * Jaccard over cause-section titles. The model never computes it; this file
 * is the arithmetic, pinned on two real titles from the 2026-09-05 pit-v3
 * replay (docs/evidence/pit-replays/2026-09-05/pit-v3/).
 * @module dsh-plugin-tenant-option-wizard/tests/quality-similarity
 */
import { describe, expect, it } from "vitest";
import { jaccard, wordSet } from "../quality/similarity.js";

// option-wizard-2026-09-01-intraday.md, the edit step's first section title.
const TITLE_A =
  "A hawkish front end: futures put 64% on a September hike while the 10Y sits at 4.75%, its highest August close";
// option-wizard-2026-09-04-premarket.md, the edit step's first section title.
const TITLE_B =
  "August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give the labor market";

describe("wordSet", () => {
  it("drops the stopword list and strips edge punctuation", () => {
    expect([...wordSet(TITLE_A)].sort()).toEqual(
      [
        "10y",
        "4.75%",
        "64%",
        "august",
        "close",
        "end",
        "front",
        "futures",
        "hawkish",
        "highest",
        "hike",
        "its",
        "put",
        "september",
        "sits",
        "while",
      ].sort(),
    );
    expect(wordSet(TITLE_A).size).toBe(16);
  });

  it("keeps an internal hyphen and strips a leading plus and an em dash", () => {
    expect([...wordSet(TITLE_B)].sort()).toEqual(
      [
        "162k",
        "55k",
        "august",
        "back-revisions",
        "cut",
        "end",
        "front",
        "give",
        "has",
        "labor",
        "market",
        "no",
        "payrolls",
        "printed",
        "with",
      ].sort(),
    );
    expect(wordSet(TITLE_B).size).toBe(15);
  });
});

describe("jaccard", () => {
  it("is 3/28 on the two recorded pit-v3 cause titles", () => {
    // Intersection {august, front, end} = 3; union 16 + 15 - 3 = 28.
    const value = jaccard(wordSet(TITLE_A), wordSet(TITLE_B));
    expect(value).toBeCloseTo(3 / 28, 12);
    expect(value.toFixed(2)).toBe("0.11");
  });

  it("is 1 for a title compared with itself", () => {
    expect(jaccard(wordSet(TITLE_A), wordSet(TITLE_A))).toBe(1);
  });

  it("is 0 for two titles that share no word", () => {
    expect(jaccard(wordSet("Rates led"), wordSet("Payrolls printed"))).toBe(0);
  });

  it("is 0 when both titles are empty, never NaN", () => {
    // 0/0 is the case that would put NaN into the audit table.
    expect(jaccard(wordSet(""), wordSet("the a of to"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/quality-similarity.spec.ts`
Expected: FAIL — `Cannot find module '../quality/similarity.js'`.

- [ ] **Step 3: Write the module**

Create `plugins/option-wizard/quality/similarity.ts`:

```typescript
/**
 * How much this run's cause title repeats the previous one's.
 *
 * A brief that re-tells yesterday's cause in yesterday's words is the defect
 * this number measures, and the model must never be the one measuring it —
 * doctrine 4 and the standing rule that numbers come from code.
 * @module dsh-plugin-tenant-option-wizard/quality/similarity
 */

/** The spec's list, verbatim. Short and closed on purpose: a long stopword
 *  list would make two unrelated titles look similar by deletion. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "and",
  "not",
  "is",
  "at",
  "on",
  "for",
]);

/**
 * Lowercased words, split on whitespace, with leading and trailing characters
 * that are neither letters, digits nor `%` removed.
 *
 * Whitespace rather than a character class, so `4.75%` and `back-revisions`
 * survive as one token each: splitting on punctuation would turn one number
 * into two words and inflate every union.
 */
export function wordSet(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/\s+/u)
      .map((token) =>
        token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}%]+$/u, ""),
      )
      .filter((token) => token !== "" && !STOPWORDS.has(token)),
  );
}

/** |a ∩ b| / |a ∪ b|. Two empty sets are 0, never NaN. */
export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/quality-similarity.spec.ts`
Expected: PASS, 6 tests. If the two `wordSet` assertions fail, print the actual sets and fix the module — the plan's hand-computed sets are the specification.

- [ ] **Step 5: Commit**

```bash
git add plugins/option-wizard/quality/similarity.ts plugins/option-wizard/tests/quality-similarity.spec.ts
git commit -m "feat(option-wizard): add stopword-filtered Jaccard over cause titles"
```

---

## Task 6: Assemble the three metrics and return them from the renderer (spec item 5)

**Files:**

- Create: `plugins/option-wizard/quality/prior.ts`
- Create: `plugins/option-wizard/quality/index.ts`
- Create: `plugins/option-wizard/tests/quality-metrics.spec.ts`
- Modify: `plugins/option-wizard/render/index.ts:1465-1483` (`renderReport`)

**Interfaces:**

- Consumes: `findMetaLeaks` (Task 2), `wordSet`/`jaccard` (Task 5), `RunMetric` (Task 3), `FLASH_BUDGET`/`measure` (`plugins/option-wizard/render/budget.ts:14-20, 81-136`), `extractJson` (`plugins/option-wizard/render/json.ts`), `BriefView` (`plugins/option-wizard/render/index.ts:136-219`).
- Produces:
  - `export function reportsDir(env?: NodeJS.ProcessEnv): string`
  - `export function priorCauseTitle(args: { dir: string; day: string; label: string }): string | null`
  - `export function budgetViolations(report: RunReport): number`
  - `export function qualityMetrics(args: { view: BriefViewLike; report: RunReport; dir?: string }): RunMetric[]` returning exactly, in this order: `{ name: "metaLeakHits", short: "leaks" }`, `{ name: "budgetViolations", short: "budget" }`, `{ name: "causeTitleSimilarity", short: "cause-sim" }`.

**Two definitions this task fixes, and why.**

1. **"The cause-section title" is the FIRST section of the rendered brief.** The editor's style exemplar (`plugins/option-wizard/team.yaml`, the `edit` prompt) makes the lead section the day's named cause; the structured `cause` field (`plugins/option-wizard/render/index.ts:196-207`) is often `{located: false}` and carries no title at all, so it cannot serve. Using `view.sections[0].title` is always present, always the reader's first line, and needs no phase branching.

2. **`metaLeakHits` counts the DELIVERED brief, not the gate's refusal string.** The gate and the metric call one function over one pattern list, so they can never disagree about what a leak is. They deliberately measure different documents: the gate measures what the model wrote, the metric measures what the reader receives after `enforceBudget` has trimmed it. The reader-visible count is the one worth trending.

**Placement note.** `quality/prior.ts` names phases (`premarket`, `intraday`, …) to order reports across days. That is exactly what `plugins/option-wizard/tests/render.spec.ts:815-841` forbids inside `plugins/option-wizard/render/`, which is why this file lives in `quality/`. `render/index.ts` may call `qualityMetrics(...)`: that line contains no quoted phase name and no comparison against anything called `phase`.

- [ ] **Step 1: Write the failing test**

Create `plugins/option-wizard/tests/quality-metrics.spec.ts`:

```typescript
/**
 * The three deterministic numbers every run writes. No LLM judge.
 * @module dsh-plugin-tenant-option-wizard/tests/quality-metrics
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunReport } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  budgetViolations,
  priorCauseTitle,
  qualityMetrics,
} from "../quality/index.js";

const TITLE_A =
  "A hawkish front end: futures put 64% on a September hike while the 10Y sits at 4.75%, its highest August close";
const TITLE_B =
  "August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give the labor market";

function reportFile(dir: string, day: string, label: string, title: string) {
  writeFileSync(
    join(dir, `option-wizard-${day}-${label}.md`),
    `# [TEST] ${label} ${day}\n\n## edit — editor\n\n${JSON.stringify({
      headline: "h",
      sections: [{ title, body: "b" }],
    })}\n`,
    "utf8",
  );
}

function report(steps: RunReport["steps"] = []): RunReport {
  return {
    runId: "run-q",
    tenant: "option-wizard",
    phase: "premarket",
    day: "2026-09-04",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps,
  } as RunReport;
}

describe("priorCauseTitle", () => {
  it("takes the newest report strictly before this run, across days", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-01", "intraday", TITLE_A);
    reportFile(dir, "2026-09-04", "premarket", "today's own, must not be read");
    expect(
      priorCauseTitle({ dir, day: "2026-09-04", label: "premarket" }),
    ).toBe(TITLE_A);
  });

  it("orders two reports on the same day by their place in the day", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-04", "premarket", TITLE_A);
    reportFile(dir, "2026-09-04", "intraday", TITLE_B);
    expect(priorCauseTitle({ dir, day: "2026-09-04", label: "close" })).toBe(
      TITLE_B,
    );
    expect(priorCauseTitle({ dir, day: "2026-09-04", label: "intraday" })).toBe(
      TITLE_A,
    );
  });

  it("returns null when there is no earlier report, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    expect(
      priorCauseTitle({ dir, day: "2026-09-04", label: "premarket" }),
    ).toBe(null);
    expect(
      priorCauseTitle({
        dir: join(dir, "nope"),
        day: "2026-09-04",
        label: "premarket",
      }),
    ).toBe(null);
  });
});

describe("budgetViolations", () => {
  it("counts every overage the flash budget measures across the run's steps", () => {
    const long = Array.from({ length: 61 }, () => "w").join(" ");
    const doc = {
      headline: Array.from({ length: 31 }, () => "h").join(" "),
      sections: [
        { title: "one", body: long },
        { title: "two", body: long },
      ],
    };
    // headline over 30, two bodies over 60 = 3.
    expect(
      budgetViolations(
        report([
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(doc),
          },
        ]),
      ),
    ).toBe(3);
  });

  it("counts a section-count overflow as one more violation", () => {
    const doc = {
      headline: "short",
      sections: Array.from({ length: 6 }, (_x, i) => ({
        title: `s${String(i)}`,
        body: "fine",
      })),
    };
    expect(
      budgetViolations(
        report([
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(doc),
          },
        ]),
      ),
    ).toBe(1);
  });

  it("is zero for a step that produced no sections", () => {
    expect(
      budgetViolations(
        report([{ task: "one", role: "prober", mode: "model", text: "hello" }]),
      ),
    ).toBe(0);
  });
});

describe("qualityMetrics", () => {
  it("returns the three rows in order, with the pinned Jaccard", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    reportFile(dir, "2026-09-01", "intraday", TITLE_A);
    const metrics = qualityMetrics({
      view: {
        headline: "No prior premarket brief exists — starting from today.",
        sections: [{ title: TITLE_B, body: "The front end has no cut." }],
      },
      report: report(),
      dir,
    });
    expect(metrics.map((metric) => [metric.name, metric.short])).toEqual([
      ["metaLeakHits", "leaks"],
      ["budgetViolations", "budget"],
      ["causeTitleSimilarity", "cause-sim"],
    ]);
    expect(metrics[0]!.value).toBe(1);
    expect(metrics[1]!.value).toBe(0);
    expect(metrics[2]!.value).toBeCloseTo(3 / 28, 12);
  });

  it("reports a null similarity when there is no prior report", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-q-"));
    const metrics = qualityMetrics({
      view: { headline: "Clean.", sections: [{ title: TITLE_A, body: "b" }] },
      report: report(),
      dir,
    });
    expect(metrics[2]!.value).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/quality-metrics.spec.ts`
Expected: FAIL — `Cannot find module '../quality/index.js'`.

- [ ] **Step 3: Write the prior-report lookup**

Create `plugins/option-wizard/quality/prior.ts`:

```typescript
/**
 * The previous report on disk, and the cause title it led with.
 *
 * Reads the same `<stateRoot>/reports/option-wizard-<day>-<label>.md` files
 * delivery-markdown writes (plugins/delivery-markdown/src/channel.ts:48-62)
 * and ow_prior_brief reads. STRICTLY BEFORE this run's own (day, label): the
 * run's report is written after rendering, so it cannot read itself — but a
 * re-render of a day already on disk would, and would score 1.00 forever.
 *
 * This file is under `quality/`, not `render/`, because ordering two reports
 * within one day needs the ORDER of the day's labels, and
 * plugins/option-wizard/tests/render.spec.ts:815-841 forbids a phase name in
 * any file directly under render/.
 * @module dsh-plugin-tenant-option-wizard/quality/prior
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractJson } from "../render/json.js";

/** The order the day's runs happen in. A label not listed sorts last within
 *  its day — it is a run this list has not been taught about, and putting it
 *  after the ones it knows is the answer that cannot reorder a known pair. */
const LABEL_ORDER = ["premarket", "intraday", "close", "weekly", "frank"];

const REPORT_FILE = /^option-wizard-(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/u;
const STEP_HEADING = /^## ([a-z0-9-]+) — .*$/gmu;

/** Same resolution as the markdown channel and the CLI: HELIUM_STATE_ROOT,
 *  else `.helium-state` beside the working directory. */
export function reportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state"),
    "reports",
  );
}

function rank(label: string): number {
  const at = LABEL_ORDER.indexOf(label);
  return at === -1 ? LABEL_ORDER.length : at;
}

function stepsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const found = [...markdown.matchAll(STEP_HEADING)];
  for (let i = 0; i < found.length; i += 1) {
    const here = found[i]!;
    const start = here.index + here[0].length;
    const end = i + 1 < found.length ? found[i + 1]!.index : markdown.length;
    out.set(here[1]!, markdown.slice(start, end).trim());
  }
  return out;
}

/**
 * The lead section title of the newest report strictly before (day, label).
 * `null` for anything that is not there or cannot be parsed — a missing
 * number is a fact, and a renderer that throws costs the reader the email.
 */
export function priorCauseTitle(args: {
  dir: string;
  day: string;
  label: string;
}): string | null {
  const here = [args.day, rank(args.label)] as const;
  let best: { day: string; rank: number; file: string } | null = null;
  try {
    for (const name of readdirSync(args.dir)) {
      const match = REPORT_FILE.exec(name);
      if (match === null) continue;
      const day = match[1]!;
      const at = rank(match[2]!);
      const earlier = day < here[0] || (day === here[0] && at < here[1]);
      if (!earlier) continue;
      if (
        best === null ||
        day > best.day ||
        (day === best.day && at > best.rank)
      )
        best = { day, rank: at, file: name };
    }
  } catch {
    return null;
  }
  if (best === null) return null;
  try {
    const byStep = stepsOf(readFileSync(join(args.dir, best.file), "utf8"));
    const source = byStep.get("edit") ?? byStep.get("regime") ?? "";
    const parsed = extractJson(source);
    if (parsed === null || !Array.isArray(parsed.sections)) return null;
    const first = (parsed.sections[0] ?? {}) as { title?: unknown };
    return typeof first.title === "string" && first.title !== ""
      ? first.title
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Write the metric assembly**

Create `plugins/option-wizard/quality/index.ts`:

```typescript
/**
 * Three numbers per run, computed in code, written to the report header and
 * to the audit table so a SELECT shows the trend. No LLM judge: eight of
 * eleven model-computed numbers audited on 2026-09-03 were wrong.
 * @module dsh-plugin-tenant-option-wizard/quality
 */
import type { RunMetric, RunReport } from "@helium/core";
import { FLASH_BUDGET, measure } from "../render/budget.js";
import { extractJson } from "../render/json.js";
import { findMetaLeaks } from "./meta-leak.js";
import { priorCauseTitle, reportsDir } from "./prior.js";
import { jaccard, wordSet } from "./similarity.js";

export { reportsDir, priorCauseTitle };

/** Only what the metrics read. Keeps this module off the BriefView type and
 *  therefore out of an import cycle with the renderer. */
export interface BriefViewLike {
  headline?: unknown;
  decision?: unknown;
  sections: Array<{ title: string; body: string }>;
}

/**
 * What `flash-budget` would refuse over, counted: one per overage the same
 * `measure()` reports, plus one if the run wrote more sections than the
 * budget allows. Read off every step whose text parses to a document with
 * `sections` — which is exactly the gate's own guard
 * (plugins/option-wizard/gates/flash-budget.ts:40-41), so the two cannot
 * disagree about what counts.
 */
export function budgetViolations(report: RunReport): number {
  let total = 0;
  for (const step of report.steps) {
    const parsed = extractJson(step.text);
    if (parsed === null || !Array.isArray(parsed.sections)) continue;
    const { overages, sectionCount } = measure(parsed);
    total += overages.length;
    if ((sectionCount ?? 0) > FLASH_BUDGET.sectionCount) total += 1;
  }
  return total;
}

/**
 * The three rows, always in this order and always all three.
 *
 * `metaLeakHits` measures the DELIVERED brief, not the gate's refusal string:
 * the gate measures what the model wrote and this measures what the reader
 * receives after the budget trim. One pattern list, one function, two
 * documents — they cannot disagree about what a leak IS.
 */
export function qualityMetrics(args: {
  view: BriefViewLike;
  report: RunReport;
  /** Injected in tests; the state root's reports directory otherwise. */
  dir?: string;
}): RunMetric[] {
  const causeTitle = args.view.sections[0]?.title ?? "";
  const prior = priorCauseTitle({
    dir: args.dir ?? reportsDir(),
    day: args.report.day,
    label: args.report.phase,
  });
  return [
    {
      name: "metaLeakHits",
      short: "leaks",
      value: findMetaLeaks(args.view).length,
    },
    {
      name: "budgetViolations",
      short: "budget",
      value: budgetViolations(args.report),
    },
    {
      name: "causeTitleSimilarity",
      short: "cause-sim",
      value:
        prior === null ? null : jaccard(wordSet(causeTitle), wordSet(prior)),
    },
  ];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/quality-metrics.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Return the metrics from the renderer**

In `plugins/option-wizard/render/index.ts`, add to the imports:

```typescript
import { qualityMetrics } from "../quality/index.js";
```

and replace the body of `renderReport` (`:1465-1483`) so it returns the metrics:

```typescript
export default function renderReport(
  report: RunReport,
  cfg: TenantSpec,
): RenderedReport {
  const view = buildView(report, cfg);
  // NO SUBJECT. The renderer does not know the phase — render.spec.ts forbids
  // it naming one — so every subject it could mint reads `option-wizard
  // 2026-09-03`, and the day's five mails arrive indistinguishable. The runner
  // already builds `[TEST] intraday 2026-09-03`; omitting the field is how the
  // channel gets to use it.
  return {
    text: renderText(view),
    html: renderHtml(view),
    // The same document the prose was rendered FROM, for a channel that stores
    // the data instead of mailing the rendering. Core never reads inside it.
    data: view as unknown as Record<string, unknown>,
    // Measured over the document the READER gets, after the budget trim. The
    // runner writes these to the audit table and prints one header line.
    metrics: qualityMetrics({ view, report }),
  };
}
```

- [ ] **Step 7: Verify the renderer still names no phase**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts -t "never branches on phase"`
Expected: PASS with `offenders` empty. If it fails, the offending line is in a file directly under `render/` — move it to `quality/`.

- [ ] **Step 8: Run the whole suite and the neutrality contract**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/option-wizard/quality/prior.ts plugins/option-wizard/quality/index.ts plugins/option-wizard/render/index.ts plugins/option-wizard/tests/quality-metrics.spec.ts
git commit -m "feat(option-wizard): compute leaks, budget violations and cause similarity per run"
```

---

## Task 7: `helium audit` prints the metric rows, and end-to-end acceptance

**Files:**

- Modify: `packages/cli/src/cli.ts:95-130` (`printAudit`)
- Test: manual acceptance against a replay, plus the full suite

**Interfaces:**

- Consumes: `AuditStore.metrics` (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Print the metrics under the cost table**

In `packages/cli/src/cli.ts`, at the end of `printAudit` (after the table is printed and before its `return 0`), add:

```typescript
const measured = store.metrics(runId);
if (measured.length > 0) {
  console.log("");
  for (const row of measured)
    console.log(
      `${row.name}: ${row.value === null ? "n/a" : String(row.value)}`,
    );
}
```

- [ ] **Step 2: Verify by hand against an in-memory store**

Run:

```bash
pnpm build && node -e "
import('./packages/core/lib/audit.js').then((m) => {
  const s = new m.AuditStore(':memory:');
  const row = { runId: 'r', ts: 'x', day: '2026-09-03', label: 'close' };
  s.appendMetric({ ...row, name: 'metaLeakHits', value: 1 });
  s.appendMetric({ ...row, name: 'causeTitleSimilarity', value: null });
  console.log(s.metrics('r'));
  console.log(s.metricsFor('2026-09-03', 'close'));
  console.log(s.metricsBetween('2026-09-01', '2026-09-03'));
});"
```

Expected: the first two lines both print `[ { name: 'causeTitleSimilarity', value: null }, { name: 'metaLeakHits', value: 1 } ]`, and the third the same two rows each carrying `day: '2026-09-03'` and `label: 'close'`. If the built path differs, `ls packages/core/lib` first.

- [ ] **Step 3: Run the acceptance replay for spec items 3 and 5**

Run a `--as-of` replay of the 2026-09-03 close, following whatever invocation `docs/evidence/pit-replays/2026-09-05/README.md` documents. Then check, against the written report under `<stateRoot>/reports/option-wizard-2026-09-03-close.md`:

1. There is no `## markout — …`, no `## drift — …` and no `## recap — …` heading. (spec item 3)
2. No section title in the delivered brief contains a CJK character: `grep -c '"title":"[^"]*[一-龥]' <report>` returns `0`. (spec item 3)
3. The header carries one line matching `^- quality: leaks=\d+ budget=\d+ cause-sim=(\d\.\d\d|n/a)$`. (spec item 5)
4. `helium audit <runId>` prints `metaLeakHits`, `budgetViolations` and `causeTitleSimilarity`, and both raw queries return three rows — the second WITHOUT the run id, which is what makes the weekly review possible:
   ```bash
   sqlite3 "${HELIUM_AUDIT_DB:-$HOME/.helium/audit.db}" \
     "SELECT name, value, day, label FROM metric WHERE run_id = '<runId>';"
   sqlite3 "${HELIUM_AUDIT_DB:-$HOME/.helium/audit.db}" \
     "SELECT day, label, name, value FROM metric
      WHERE day = '2026-09-03' AND label = 'close' ORDER BY name;"
   ```
5. If the run produced a `meta-leak` refusal, it appears in the report as `- gate \`meta-leak\` refused: …`(written by`deliveryBody`, `packages/cli/src/runner.ts:1353-1354`) and the run still delivered — the gate is advisory. (spec item 2)

- [ ] **Step 4: Run everything**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm test:contracts`
Expected: PASS. If time is short, at minimum `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): print a run's metric rows under helium audit"
```

---

## Where the item 4, 1 and 6 machinery lives (read these before Task 8)

| Thing                                                                  | Path and lines                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The PIT registry the runner hands to `buildTools`                      | `packages/cli/src/runner.ts:687-692` (`pitUnavailable` map + `pit.markUnavailable`), passed at `:693-702` in the `loadTenantTools` call                                                                                                                                                                                   |
| Where a tool is CALLED on the deterministic path                       | `packages/cli/src/runner.ts:916-949` — `value = await tool.run(args)` at `:918`, span appended at `:942`                                                                                                                                                                                                                  |
| Where tool IMPLEMENTATIONS reach the model path                        | `packages/cli/src/runner.ts:1050-1059` — the provider gets the objects out of `toolsByName` through `selection.options.tools`. **Both paths therefore run whatever `toolsByName` holds: one wrapper installed at `:693-703` covers the whole run.**                                                                       |
| `pitCoverage` computation                                              | `packages/cli/src/runner.ts:1229-1237`; the shape is `packages/core/src/report.ts:96-101`; printed at `packages/cli/src/runner.ts:1410-1418` and `packages/cli/src/cli.ts:38-45`                                                                                                                                          |
| `parseRunArgs`                                                         | `packages/cli/src/args.ts:18-66`; usage strings at `packages/cli/src/cli.ts:175` and `:237-240`; the `runTenant` call at `packages/cli/src/cli.ts:209-226`                                                                                                                                                                |
| State root resolution                                                  | `packages/cli/src/cli.ts:27-29` — `HELIUM_STATE_ROOT ?? resolve(cwd, ".helium-state")`                                                                                                                                                                                                                                    |
| `TenantToolConfig` and the `buildTools` call                           | `packages/cli/src/discovery.ts:112-153` — every field the tenant's tools receive; the inline structural type at `:135-143` must be extended in step with the interface or the call stops type-checking                                                                                                                    |
| The AS_OF_BLIND replacement wrapper                                    | `plugins/option-wizard/tools/index.ts:3617-3638` — one `built.map(...)` replaces a live-only tool's `run` with a constant refusal payload and calls `cfg.pit?.markUnavailable` eagerly at `:3626`. The 14-entry map is `:1314-1336`. **This is where item 1's serving goes.**                                             |
| `ow_prior_brief`                                                       | `plugins/option-wizard/tools/index.ts:2545-2638`; its params schema at `:1046`, `pickBriefProse` at `:1060`, `stepsOf` at `:1161`, `REPORT_NAME` at `:1175`, the 2 KB ceiling at `:1039`                                                                                                                                  |
| `priorOpenDay` (already exported, calendar-aware, bounded at 14 steps) | `plugins/option-wizard/tools/index.ts:1378-1392`                                                                                                                                                                                                                                                                          |
| Where step text is kept                                                | model path `packages/cli/src/runner.ts:1145-1180` (gates at `:1145`, `produced.set(taskId, result.text)` at `:1158`, `text: result.text` at `:1170`); deterministic path `:965-990` (`produced.set(taskId, text)` at `:983`, `text` at `:988`). `mkdirSync`, `writeFileSync` and `join` are already imported at `:22-23`. |
| `TenantSpec`, its zod shape and its builder                            | `packages/core/src/tenant.ts` — `TenantCalendar` `:39-59`, `extensions` field `:97-98`, calendar zod `:157-166`, `extensions` zod `:170`, `parseTenantYaml` `:203-245` (the spread-builder is `:216-244`)                                                                                                                 |
| Persona cap                                                            | `packages/core/src/team.ts:44` — `persona: z.string().max(4000)`                                                                                                                                                                                                                                                          |
| `regime-analyst` persona and the `regime` task                         | `plugins/option-wizard/team.yaml:96-167` (persona `:112-167`, last line `:167`), task `:492-551` (the reply-shape line is `:548-549`)                                                                                                                                                                                     |
| `editor` persona                                                       | `plugins/option-wizard/team.yaml:381-421`; the `ow_prior_brief` paragraph is `:400-403`                                                                                                                                                                                                                                   |
| The `weekly` task and its role                                         | `plugins/option-wizard/team.yaml:798-812`; `weekly-analyst` role `:351-363`. **Task 1 Step 5 already repoints the weekly prompt to `steps:["edit"]`.**                                                                                                                                                                    |
| The weekly schedule, in the two places it lives                        | `launchd/com.helium.option-wizard-weekly.plist` (`Weekday 0`, `Hour 20`, `Minute 0` — Sunday 20:00 HKT = Sunday 08:00 ET) and `plugins/option-wizard/tenant.yaml:124-128`                                                                                                                                                 |
| Why the calendar does not delete the weekly run                        | `plugins/option-wizard/tenant.yaml:76-83` — `appliesTo: [premarket, intraday, close]`, deliberately excluding `weekly` and `frank`                                                                                                                                                                                        |
| The daily mail cap and its arithmetic                                  | `plugins/option-wizard/tenant.yaml:150-166` — `maxPerDay: 5`, peak is 4, and the comment ends "WHOEVER ADDS A SIXTH must first work out its ET date"                                                                                                                                                                      |

### Decision: the regime block is stripped by the RUNNER, not by the renderer

The spec leaves this open ("Runner (or the tenant's render hook, whichever already post-processes step output)"). It goes in the runner, driven by a fence name the tenant declares, for three reasons that are all about WHERE the two facts live. First, nothing post-processes step output today: the model path writes `result.text` straight into `produced` and into `report.steps` (`packages/cli/src/runner.ts:1158, 1170`), so there is no render hook to extend — the choice is between adding one to the runner and adding one to the renderer. Second, the renderer cannot do the writing half at all: `renderReport(report, cfg)` is a pure function handed a `RunReport` and a `TenantSpec`, and neither carries `stateRoot`; it also may not name a phase (`plugins/option-wizard/tests/render.spec.ts:815-841`) while the record's filename IS the phase. Third, and decisively, stripping in the renderer would fix only the mail: `report.steps[].text` is what the markdown channel writes to `<stateRoot>/reports/option-wizard-<day>-<phase>.md`, and what `ow_reports` and `ow_prior_brief` read back — so the fence would still reach the reader through the report file and still poison every downstream parse. There is a real cost: core gains one optional `TenantSpec.stateBlock` field. It is paid because a step handing structured state to the NEXT run is harness machinery, not a market fact (doctrine 1 — helium-self wants exactly this), and because core learns only two strings, `fence` and `suffix`, and never opens the JSON. A tenant-side alternative — a mutating `ow_note_regime` tool the model calls with the fields as arguments — was rejected: `sandbox: none` is this tenant's structural guarantee (`plugins/option-wizard/tenant.yaml:10-13`), and the day and phase in the path would become model-supplied strings, which is both a fabrication and a traversal risk.

### Decision: item 6 extends the EXISTING `weekly` phase; it does not add a sixth

The spec asks this to be checked ("check whether the existing `weekly` plist can carry it before adding a sixth"), and the answer is that it can and should. `weekly` already fires Sunday 08:00 ET (`launchd/com.helium.option-wizard-weekly.plist`, `Weekday 0` / `Hour 20` HKT), which is after Friday's close and is already the "read the week that just ended" run; the tenant calendar deliberately does not govern it (`plugins/option-wizard/tenant.yaml:76-83`), so it fires on a holiday week too. Against that, a sixth phase costs a sixth plist installed by `receive-deploy.sh` on the mini, a sixth `triggers:` entry, a sixth `kinds:` entry in the argon delivery config, and — the hard one — a recount of the daily mail cap, which the tenant file itself flags as the trap (`plugins/option-wizard/tenant.yaml:160-166`: peak 4 of `maxPerDay: 5`, "WHOEVER ADDS A SIXTH must first work out its ET date"). None of that ceremony buys anything the weekly run does not already have (doctrine 6). So item 6 ships as a new TASK — `week-review`, role `week-reviewer` — with `phases: [weekly]`, alongside the existing `weekly` task. **One deviation from the spec follows and is deliberate:** the acceptance replay is `--phase weekly`, not `--phase review`, and the review is read on Sunday rather than Friday 17:00 ET. The window arithmetic is unaffected — the tool counts trading days backwards from the run's report day with `spec.calendar`, and a Sunday report day walks back to Friday on its first step.

---

## File structure — items 4, 1 and 6

**Create**

- `plugins/option-wizard/state/regime.ts` — the zod schema for the `regime-state` record plus `parseRegimeState`. Its own directory, not `quality/`, because it is a data contract between two runs and not a measurement.
- `plugins/option-wizard/gates/regime-state.ts` — the advisory gate that validates the block the regime step wrote.
- `plugins/option-wizard/tests/state-regime.spec.ts`
- `plugins/option-wizard/tests/gate-regime-state.spec.ts`
- `plugins/option-wizard/tests/tools-review-window.spec.ts`
- `packages/core/tests/tenant-state-block.spec.ts`
- `packages/cli/src/tool-io.ts` — record one tool call, index a run's recordings, prune by age with a keep-list hook.
- `packages/cli/src/tool-io.test.ts`

**Modify**

- `packages/core/src/tenant.ts` — `TenantStateBlock`, `TenantSpec.stateBlock`, its zod shape and its line in `parseTenantYaml`.
- `packages/cli/src/runner.ts` — `splitStateBlock` + `writeStateBlock` + the `liftState` closure on both step paths; the recording wrapper around `toolsByName`; the prune at run start; `replayFrom` in `RunOptions`; `recordings` into `loadTenantTools`; `served` in `pitCoverage`.
- `packages/cli/src/args.ts` — `--replay-from`.
- `packages/cli/src/cli.ts` — pass `replayFrom`, print `served`, extend both usage strings.
- `packages/cli/src/discovery.ts` — `recordings` and `extensions` on `TenantToolConfig` and on the inline `buildTools` structural type.
- `packages/core/src/report.ts` — `pitCoverage.served`.
- `plugins/option-wizard/tools/index.ts` — `ow_prior_brief` returns the structured record; the AS_OF_BLIND wrapper consults recordings; the new `ow_review_window` tool and its `VOCABULARY` entry.
- `plugins/option-wizard/tenant.yaml` — `stateBlock:` and `extensions.review.windows`.
- `plugins/option-wizard/team.yaml` — the `regime-analyst` and `editor` persona edits; the `week-reviewer` role and the `week-review` task.
- `plugins/option-wizard/tsconfig.json`, `plugins/option-wizard/package.json` — add `state`.
- `plugins/option-wizard/tests/team-manifest.spec.ts` — the new role and task.
- `packages/cli/src/runner.test.ts` — state-block and recording cases.

---

## Task 8: A tenant-declared state block the runner lifts out and writes (spec item 4, plumbing)

**Files:**

- Modify: `packages/core/src/tenant.ts` (interface near `:39-59`, `TenantSpec` at `:97-98`, zod at `:157-171`, `parseTenantYaml` at `:216-244`)
- Modify: `packages/cli/src/runner.ts` (new helpers; `:965-990` and `:1145-1180`)
- Modify: `plugins/option-wizard/tenant.yaml`
- Test: `packages/core/tests/tenant-state-block.spec.ts`
- Test: `packages/cli/src/runner.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface TenantStateBlock { fence: string; suffix: string }` and `TenantSpec.stateBlock?: TenantStateBlock` from `@helium/core`.
  - `export function splitStateBlock(text: string, fence: string): { text: string; block?: string }` from `packages/cli/src/runner.ts`.
  - The file `<stateRoot>/<tenant>/<day>/<label>.<suffix>`, pretty-printed JSON with a trailing newline. Tasks 10 and 11 read `<stateRoot>/option-wizard/<day>/<phase>.regime.json`.

**Neutrality note.** The identifiers added to core are `stateBlock`, `fence`, `suffix`, `TenantStateBlock`. None is on either list at `contracts/tests/core-neutrality.contract.spec.ts:24-40`, and none names a market, a tenant or a phase. The word `regime` appears only in `plugins/`.

- [ ] **Step 1: Write the failing core test**

Create `packages/core/tests/tenant-state-block.spec.ts`:

```typescript
/**
 * `stateBlock`: two strings that let a tenant hand structured state from one
 * run to the next without core learning what the state IS.
 * @module core/tests/tenant-state-block
 */
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "../src/tenant.js";

const BASE = `tenant: t
enabled: true
team: team.yaml
sandbox: none
budget: { usd: 1, tokens: 1000 }
triggers: [{ kind: cron, schedule: "0 0 * * *", timezone: UTC, phase: p }]
delivery: []
`;

describe("tenant stateBlock", () => {
  it("is absent when the tenant does not declare one", () => {
    expect(parseTenantYaml(BASE, "t.yaml").stateBlock).toBeUndefined();
  });

  it("carries the fence and the file suffix verbatim", () => {
    const spec = parseTenantYaml(
      `${BASE}stateBlock:\n  fence: regime-state\n  suffix: regime.json\n`,
      "t.yaml",
    );
    expect(spec.stateBlock).toEqual({
      fence: "regime-state",
      suffix: "regime.json",
    });
  });

  it("refuses a fence or a suffix that could escape the state directory", () => {
    // The suffix becomes a path segment. `../` in it would write anywhere the
    // process can reach, from a string a tenant file supplies.
    expect(() =>
      parseTenantYaml(
        `${BASE}stateBlock:\n  fence: ok\n  suffix: ../../etc/passwd\n`,
        "t.yaml",
      ),
    ).toThrow(/suffix/u);
    expect(() =>
      parseTenantYaml(
        `${BASE}stateBlock:\n  fence: "a b"\n  suffix: x.json\n`,
        "t.yaml",
      ),
    ).toThrow(/fence/u);
  });

  it("refuses a stateBlock missing either half", () => {
    expect(() =>
      parseTenantYaml(`${BASE}stateBlock:\n  fence: ok\n`, "t.yaml"),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/core/tests/tenant-state-block.spec.ts`
Expected: FAIL — `stateBlock` is not a key `TenantShape` accepts, so the second case throws `unrecognized key`.

- [ ] **Step 3: Add the field to core**

In `packages/core/src/tenant.ts`, add above `export interface TenantSpec`:

````typescript
/**
 * One fenced block a step may end its output with, lifted out of the delivered
 * text and kept as this run's state for the next run to read.
 *
 * Core learns TWO STRINGS and nothing else: the fence's info string and the
 * file suffix. It never opens the block, never validates its contents beyond
 * "this is a JSON object", and never learns why one run would want to tell the
 * next one anything. A tenant that declares none is unaffected, which is every
 * tenant that existed before this field.
 */
export interface TenantStateBlock {
  /** The info string after the opening ``` of the block to lift. */
  fence: string;
  /** Trailing half of the file name under
   *  `<stateRoot>/<tenant>/<day>/<label>.<suffix>`. */
  suffix: string;
}
````

Add to `TenantSpec`, after `calendar?: TenantCalendar;` (`:96`):

```typescript
  /**
   * The fenced block this tenant's steps may end their output with. Absent
   * means no step output is post-processed at all.
   */
  stateBlock?: TenantStateBlock;
```

Add to `TenantShape`, next to the `calendar` entry (before the `extensions` entry at `:170`):

```typescript
  // Both halves are regex-validated because BOTH become part of a path the
  // runner writes to. A suffix carrying `../` would let a tenant file choose
  // any file on the machine, and a fence carrying regex metacharacters would
  // let it choose which of a step's text to delete.
  stateBlock: z
    .strictObject({
      fence: z.string().regex(/^[a-z0-9-]{1,32}$/, "fence: [a-z0-9-]{1,32}"),
      suffix: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, "suffix: [a-z0-9.-]{1,32}"),
    })
    .optional(),
```

Add to the object `parseTenantYaml` returns, next to the `calendar` spread (`:236-244`):

```typescript
    ...(raw.stateBlock === undefined
      ? {}
      : { stateBlock: { ...raw.stateBlock } }),
```

- [ ] **Step 4: Run the core test to verify it passes**

Run: `pnpm vitest run --project unit packages/core/tests/tenant-state-block.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing runner test**

Append to `packages/cli/src/runner.test.ts`:

````typescript
describe("state block", () => {
  it("splits a fenced block off the end of a step's text", () => {
    const text = [
      '{"headline":"h","sections":[]}',
      "",
      "```regime-state",
      '{"cause":"payrolls","ust10y":4.79}',
      "```",
      "",
    ].join("\n");
    const split = splitStateBlock(text, "regime-state");
    expect(split.text).toBe('{"headline":"h","sections":[]}');
    expect(split.block).toBe('{"cause":"payrolls","ust10y":4.79}');
  });

  it("leaves text with no such fence exactly as it was", () => {
    const text = '{"headline":"h"}\n\n```json\n{"a":1}\n```';
    expect(splitStateBlock(text, "regime-state")).toEqual({ text });
  });

  it("treats a fence name as a literal, never as a pattern", () => {
    // A tenant file supplies the fence. If it reached `new RegExp` unescaped,
    // `.*` in it would delete the whole step.
    const text = "kept\n```a.c\n{}\n```";
    expect(splitStateBlock(text, "abc").block).toBeUndefined();
  });

  it("writes the block to <stateRoot>/<tenant>/<day>/<label>.<suffix>", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-state-"));
    const audit = new AuditStore(":memory:");
    const spec = tenant(1, DELIVERY_YAML);
    spec.tenant.spec.stateBlock = { fence: "regime-state", suffix: "s.json" };
    const report = await runTenant({
      tenant: spec.tenant,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot,
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      phase: "premarket",
      modelExecutor: {
        run: async () => ({
          text: 'said it\n\n```regime-state\n{"cause":"payrolls"}\n```',
          events: [],
        }),
      },
      channels: [],
      renderer: null,
    });
    const written = join(
      stateRoot,
      report.tenant,
      report.day,
      "premarket.s.json",
    );
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual({
      cause: "payrolls",
    });
    // And the reader never sees the block.
    expect(report.steps[0]!.text).toBe("said it");
    audit.close();
  });

  it("keeps the text and writes nothing when the block is not JSON", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-state-"));
    const audit = new AuditStore(":memory:");
    const spec = tenant(1, DELIVERY_YAML);
    spec.tenant.spec.stateBlock = { fence: "regime-state", suffix: "s.json" };
    const report = await runTenant({
      tenant: spec.tenant,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot,
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      phase: "premarket",
      modelExecutor: {
        run: async () => ({
          text: "said it\n\n```regime-state\nnot json at all\n```",
          events: [],
        }),
      },
      channels: [],
      renderer: null,
    });
    expect(report.steps[0]!.text).toBe("said it");
    expect(
      existsSync(
        join(stateRoot, report.tenant, report.day, "premarket.s.json"),
      ),
    ).toBe(false);
    audit.close();
  });
});
````

Add whatever of `mkdtempSync`, `readFileSync`, `existsSync`, `tmpdir`, `join` and `splitStateBlock` the file does not already import; `splitStateBlock` comes from `./runner.js`. Check the top of the file first and add only what is missing. If the helpers `tenant(...)`, `DELIVERY_YAML`, `provider`, `echo` and `catalogFor(...)` are named differently in this file, use the file's own names — the pre-existing delivery tests are the template.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts -t "state block"`
Expected: FAIL — `splitStateBlock is not exported`.

- [ ] **Step 7: Write the two runner helpers**

In `packages/cli/src/runner.ts`, add above `export async function runTenant` (`:615`):

```typescript
/**
 * A tenant-declared fenced block, lifted out of a step's text.
 *
 * Exported because the escaping is the whole risk: `fence` comes out of a YAML
 * file, and an unescaped `.*` in `new RegExp` would delete the step instead of
 * the block. Returns the text unchanged, and no `block`, when the fence is not
 * there — which is every step of every tenant that declares none.
 */
export function splitStateBlock(
  text: string,
  fence: string,
): { text: string; block?: string } {
  const escaped = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(
    `\\n?[ \\t]*\`\`\`${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\`\`\`[ \\t]*(?=\\r?\\n|$)`,
    "u",
  ).exec(text);
  if (found === null) return { text };
  return {
    text: `${text.slice(0, found.index)}${text.slice(
      found.index + found[0].length,
    )}`.trim(),
    block: found[1]!.trim(),
  };
}

/**
 * The block on disk, or nothing. A block that is not a JSON OBJECT is dropped
 * silently HERE — the tenant's own gate is what tells the reader it was
 * malformed, because only the tenant knows what a well-formed one contains.
 * Core's whole test is "can this be stored at all".
 */
function writeStateBlock(args: {
  stateRoot: string;
  tenant: string;
  day: string;
  label: string;
  suffix: string;
  block: string;
}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.block);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return;
  const dir = join(args.stateRoot, args.tenant, args.day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${args.label}.${args.suffix}`),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
}
```

- [ ] **Step 8: Lift the block on both step paths**

In `runTenant`, immediately before `const signal = options.signal ?? new AbortController().signal;` (`:767`), add:

```typescript
// Applied AFTER the output gates and BEFORE anything keeps the text: the
// gate still sees exactly what the model wrote, and the report file, the
// renderer, the channels and every later run see it without the block.
// Stripping later would leave the fence in the markdown report, which is
// what the tenant's own tools read back.
const liftState = (text: string): string => {
  if (spec.stateBlock === undefined) return text;
  const split = splitStateBlock(text, spec.stateBlock.fence);
  if (split.block === undefined) return text;
  writeStateBlock({
    stateRoot: options.stateRoot,
    tenant: spec.tenant,
    day: reportDay,
    label: phase,
    suffix: spec.stateBlock.suffix,
    block: split.block,
  });
  return split.text;
};
```

On the deterministic path, replace `:983-989`:

```typescript
const kept = liftState(text);
produced.set(taskId, kept);
report.steps.push({
  task: taskId,
  role: task.role,
  mode: deterministic ? "deterministic" : "tool-only",
  text: kept,
  ...refusalFields(out.refusals),
});
```

On the model path, replace `produced.set(taskId, result.text);` (`:1158`) with:

```typescript
const kept = liftState(result.text);
produced.set(taskId, kept);
```

and, in the `report.steps.push({...})` that follows, replace `text: result.text,` (`:1170`) with `text: kept,`.

- [ ] **Step 9: Run the runner tests to verify they pass**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts`
Expected: PASS, including the five new cases and every pre-existing one — a tenant with no `stateBlock` takes the `return text` branch on the first line of `liftState`.

- [ ] **Step 10: Declare the block in the tenant**

In `plugins/option-wizard/tenant.yaml`, add immediately after the `calendar:` block (after `:90`) and before the `# DECLARATIVE ONLY.` comment at `:92`:

````yaml
# The regime step ends its reply with one ```regime-state fence. The runner
# lifts it out before anything keeps the text and writes it to
# <stateRoot>/option-wizard/<day>/<phase>.regime.json; ow_prior_brief reads
# that record instead of re-reading yesterday's whole markdown brief, which is
# how intraday used to re-tell premarket's cause in premarket's words.
# The host validates only that the block is a JSON object; the SHAPE is
# plugins/option-wizard/state/regime.ts and the gate that enforces it is
# plugins/option-wizard/gates/regime-state.ts.
stateBlock:
  fence: regime-state
  suffix: regime.json
````

- [ ] **Step 11: Run the whole suite and the neutrality contract**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/tenant.ts packages/core/tests/tenant-state-block.spec.ts packages/cli/src/runner.ts packages/cli/src/runner.test.ts plugins/option-wizard/tenant.yaml
git commit -m "feat(core): lift a tenant-declared state block out of step output and store it"
```

---

## Task 9: The `regime-state` schema and its advisory gate (spec item 4, validation)

**Files:**

- Create: `plugins/option-wizard/state/regime.ts`
- Create: `plugins/option-wizard/gates/regime-state.ts`
- Create: `plugins/option-wizard/tests/state-regime.spec.ts`
- Create: `plugins/option-wizard/tests/gate-regime-state.spec.ts`
- Modify: `plugins/option-wizard/tsconfig.json`, `plugins/option-wizard/package.json`

**Interfaces:**

- Consumes: `splitStateBlock` is NOT importable here (it lives in `@helium/cli`, which the tenant does not depend on); this task re-finds the fence with its own two-line regex, deliberately — the gate reads the RAW step text, before the runner lifted anything.
- Produces:
  - `export const RegimeState` (a zod schema) and `export type RegimeState`
  - `export function parseRegimeState(value: unknown): RegimeState | null`
  - `export function findStateBlock(text: string): string | null`
  - a default-exported `Gate` with `id: "regime-state"`, `phase: "output"`, `advisory: true`, `appliesTo: ["regime-analyst"]`.

**Why a gate and not a core validation.** The spec wants "invalid or missing → the record is not written and the run's coverage notes `regime-state: missing`". Core already declines to write anything that is not a JSON object (Task 8). The NOTE is the other half, and the mechanism for it already exists: an advisory gate refusal lands in `StepReport.gateRefusals` (`packages/core/src/report.ts:20-21`) and the renderer surfaces it through `degradationFrom` (`plugins/option-wizard/render/index.ts:344-356`) — the same path `flash-budget` and `meta-leak` use. No new report field, no new core surface.

- [ ] **Step 1: Write the failing schema test**

Create `plugins/option-wizard/tests/state-regime.spec.ts`:

````typescript
/**
 * The record one run hands the next. Six fields, all copied from a tool by the
 * model and none computed by it.
 * @module dsh-plugin-tenant-option-wizard/tests/state-regime
 */
import { describe, expect, it } from "vitest";
import { findStateBlock, parseRegimeState } from "../state/regime.js";

const GOOD = {
  cause: "August payrolls printed 162k",
  ust2y: 4.02,
  ust10y: 4.79,
  s2s10: 77,
  tide: "up",
  thesis: "The front end has no cut to give the labor market.",
};

describe("parseRegimeState", () => {
  it("accepts the recorded shape", () => {
    expect(parseRegimeState(GOOD)).toEqual(GOOD);
  });

  it("accepts a record whose optional numbers are missing", () => {
    // A day the rates tools were skipped still has a cause and a thesis, and
    // half a record beats none: the next run compares CAUSES first.
    expect(parseRegimeState({ cause: "x", tide: "flat", thesis: "y" })).toEqual(
      {
        cause: "x",
        tide: "flat",
        thesis: "y",
      },
    );
  });

  it("rejects a missing cause, a missing thesis and an unknown tide", () => {
    expect(parseRegimeState({ tide: "up", thesis: "y" })).toBe(null);
    expect(parseRegimeState({ cause: "x", tide: "up" })).toBe(null);
    expect(
      parseRegimeState({ cause: "x", tide: "sideways", thesis: "y" }),
    ).toBe(null);
  });

  it("rejects a number that arrived as a string", () => {
    // "4.79" is what a model writes when it is re-typing rather than copying,
    // and it is the tell that the number was not read off a tool.
    expect(parseRegimeState({ ...GOOD, ust10y: "4.79" })).toBe(null);
  });

  it("rejects anything that is not an object", () => {
    expect(parseRegimeState(null)).toBe(null);
    expect(parseRegimeState([GOOD])).toBe(null);
    expect(parseRegimeState("cause")).toBe(null);
  });
});

describe("findStateBlock", () => {
  it("returns the block's body", () => {
    expect(
      findStateBlock('{"sections":[]}\n\n```regime-state\n{"cause":"x"}\n```'),
    ).toBe('{"cause":"x"}');
  });

  it("returns null when there is no such fence", () => {
    expect(findStateBlock('{"sections":[]}\n\n```json\n{"a":1}\n```')).toBe(
      null,
    );
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/state-regime.spec.ts`
Expected: FAIL — `Cannot find module '../state/regime.js'`.

- [ ] **Step 3: Write the schema module**

Create `plugins/option-wizard/state/regime.ts`:

````typescript
/**
 * What one run tells the next about the regime.
 *
 * `ow_prior_brief` used to hand the editor the previous phase's WHOLE markdown
 * brief, and intraday duly re-told premarket's cause in premarket's words. Six
 * fields instead: the next run compares them and writes the delta.
 *
 * Every number here is COPIED from a tool by the model, never computed by it
 * (eight of eleven model-computed numbers audited on 2026-09-03 were wrong),
 * which is why they are `z.number()` and not `z.coerce.number()`: a figure that
 * arrived as the string "4.79" was retyped, and a retyped number is exactly the
 * one worth refusing.
 * @module dsh-plugin-tenant-option-wizard/state/regime
 */
import { z } from "zod";

export const RegimeState = z.strictObject({
  /** The one input that moved the tape, in the analyst's own words. */
  cause: z.string().min(1).max(200),
  /** 2Y UST level, copied from ow_macro_rates. */
  ust2y: z.number().optional(),
  /** 10Y UST level, copied from ow_macro_rates. */
  ust10y: z.number().optional(),
  /** 2s10s in basis points, as the tool reported it. */
  s2s10: z.number().optional(),
  tide: z.enum(["up", "down", "flat"]),
  thesis: z.string().min(1).max(400),
});

export type RegimeState = z.infer<typeof RegimeState>;

/** The record, or `null` for anything that is not one. Never throws: a bad
 *  record is a fact the gate reports, not an error that costs the run. */
export function parseRegimeState(value: unknown): RegimeState | null {
  const parsed = RegimeState.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The body of the ```regime-state fence in a raw step text.
 *
 * The gate needs this because it runs BEFORE the runner lifts the block
 * (packages/cli/src/runner.ts), so the fence is still there. The fence name is
 * a literal here and a declaration in tenant.yaml; the two must agree, and the
 * gate test is what keeps them agreeing.
 */
export function findStateBlock(text: string): string | null {
  const found = /```regime-state[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/u.exec(
    text,
  );
  return found === null ? null : found[1]!.trim();
}
````

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/state-regime.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing gate test**

Create `plugins/option-wizard/tests/gate-regime-state.spec.ts`:

````typescript
/**
 * The advisory gate that tells the reader the regime record did not survive.
 * Advisory for the same reason flash-budget and meta-leak are: a brief with no
 * state record is still a brief worth sending.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-regime-state
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/regime-state.js";

const ctx = { runId: "run-1", role: "regime-analyst" } as never;
const BLOCK =
  '```regime-state\n{"cause":"August payrolls printed 162k","ust2y":4.02,' +
  '"ust10y":4.79,"s2s10":77,"tide":"up","thesis":"No cut to give."}\n```';

describe("regime-state gate", () => {
  it("is advisory, output-phase, and guards one role", () => {
    expect(gate.id).toBe("regime-state");
    expect(gate.phase).toBe("output");
    expect(gate.advisory).toBe(true);
    expect(gate.appliesTo).toEqual(["regime-analyst"]);
  });

  it("passes a step that ends with a valid block", async () => {
    const result = await gate.check(
      { text: `{"headline":"h","sections":[]}\n\n${BLOCK}` },
      ctx,
    );
    expect(result.pass).toBe(true);
  });

  it("refuses with `regime-state: missing` when there is no block", async () => {
    const result = await gate.check(
      { text: '{"headline":"h","sections":[]}' },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("regime-state: missing");
  });

  it("refuses with `regime-state: missing` and the reason when it is malformed", async () => {
    const result = await gate.check(
      { text: '```regime-state\n{"cause":"x","tide":"sideways"}\n```' },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("regime-state: missing");
    expect(result.reason).toContain("tide");
  });

  it("refuses when the block is not JSON at all", async () => {
    const result = await gate.check(
      { text: "```regime-state\nnot json\n```" },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("regime-state: missing");
  });
});
````

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/gate-regime-state.spec.ts`
Expected: FAIL — `Cannot find module '../gates/regime-state.js'`.

- [ ] **Step 7: Write the gate**

Create `plugins/option-wizard/gates/regime-state.ts`:

```typescript
/**
 * "The record for tomorrow did not get written", said in the brief.
 *
 * The runner declines to store a block that is not a JSON object, and the
 * schema declines the rest — but neither of them can TELL the reader, and a
 * missing record is invisible until the next run silently falls back to
 * markdown. An advisory refusal reaches the report through the same path
 * flash-budget's does: StepReport.gateRefusals -> the renderer's
 * degradationFrom (plugins/option-wizard/render/index.ts:344-356).
 *
 * The refusal string starts with the exact words the spec asks for,
 * `regime-state: missing`, so a reader and a grep agree.
 * @module dsh-plugin-tenant-option-wizard/gates/regime-state
 */
import type { Gate, GateCtx } from "@helium/core";
import { RegimeState, findStateBlock } from "../state/regime.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "regime-state",
  phase: "output",
  advisory: true,
  // Only the step that is asked for the record can fail to produce one.
  appliesTo: ["regime-analyst"],
  async check(
    input: unknown,
    _ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const block = findStateBlock(textOf(input));
    if (block === null)
      return { pass: false, reason: "regime-state: missing (no block)" };
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch {
      return { pass: false, reason: "regime-state: missing (not JSON)" };
    }
    const parsed = RegimeState.safeParse(value);
    if (parsed.success) return { pass: true, reason: "regime-state: written" };
    return {
      pass: false,
      reason: `regime-state: missing (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")})`,
    };
  },
};

export default gate;
```

- [ ] **Step 8: Add `state` to the tenant build**

In `plugins/option-wizard/tsconfig.json`, extend `include` (Task 2 already added `quality`):

```json
  "include": ["tools", "gates", "render", "quality", "state"]
```

In `plugins/option-wizard/package.json`, extend `files`:

```json
  "files": ["lib", "tools", "gates", "render", "quality", "state", "tenant.yaml", "team.yaml"],
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/gate-regime-state.spec.ts plugins/option-wizard/tests/state-regime.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 10: Verify the gate loads by glob, with no core edit**

Run: `pnpm build && node -e "import('./packages/cli/lib/discovery.js').then(async (m) => { const r = await m.loadGates('plugins/option-wizard'); console.log(r.gates.map((g) => g.id).sort(), r.skipped); })"`
Expected: the id list contains `regime-state` and `meta-leak` alongside `as-of-verbatim`, `cause-citation`, `design-spot`, `flash-budget`, `ib-preflight`, and `skipped` is `[]`. If the built entrypoint path differs, `ls packages/cli/lib` first.

- [ ] **Step 11: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add plugins/option-wizard/state/regime.ts plugins/option-wizard/gates/regime-state.ts plugins/option-wizard/tests/state-regime.spec.ts plugins/option-wizard/tests/gate-regime-state.spec.ts plugins/option-wizard/tsconfig.json plugins/option-wizard/package.json
git commit -m "feat(option-wizard): add the regime-state record schema and its advisory gate"
```

---

## Task 10: `ow_prior_brief` serves the structured record (spec item 4, reader)

**Files:**

- Modify: `plugins/option-wizard/tools/index.ts:2545-2638` (the whole `ow_prior_brief` entry) and its params schema at `:1046-1058`
- Test: `plugins/option-wizard/tests/state-regime.spec.ts` (extended) — or the tenant's existing tools spec if one already covers `ow_prior_brief`; check with `grep -rn "ow_prior_brief" plugins/option-wizard/tests/` first and extend that file instead of creating a second one.

**Interfaces:**

- Consumes: `parseRegimeState` (Task 9); the file layout Task 8 writes, `<stateRoot>/<tenant>/<day>/<label>.regime.json`; `REPORT_NAME` (`:1175`), `stepsOf` (`:1161`), `pickBriefProse` (`:1060`), `extractJson`, `PRIOR_BRIEF_CEILING_CHARS` (`:1039`) — all already in this file.
- Produces: `ow_prior_brief` returns `{ dir, prior: { day, phase, headline, regimeState } | null, fallback?: "markdown", reason?, note }`.

**Rebase warning.** A concurrent agent owns `plugins/option-wizard/tools/index.ts`. `git pull --rebase` immediately before Step 3 and re-locate the entry by its `name: "ow_prior_brief",` line, never by line number.

**Semantics change, stated plainly.** Today the `phase` argument means "which phase's brief to look back at, on an earlier DAY". It now means "the run label I am writing for", and the tool returns the most recent record STRICTLY BEFORE this run in (day, label) order — which is what "the previous phase" means to a reader and what the spec asks for. Calendar-awareness comes for free and needs no calendar: a closed day produced no run, so it has no files, so it cannot be selected.

- [ ] **Step 1: Write the failing test**

Append to `plugins/option-wizard/tests/state-regime.spec.ts` (add `mkdtempSync`, `mkdirSync`, `writeFileSync`, `tmpdir`, `join` and `buildTools` to its imports):

```typescript
function toolNamed(stateRoot: string, name: string) {
  const built = buildTools({ stateRoot, env: {}, variant: "live" });
  return built.find((tool) => tool.name === name)!;
}

function stateFile(
  stateRoot: string,
  day: string,
  label: string,
  body: Record<string, unknown>,
): void {
  const dir = join(stateRoot, "option-wizard", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${label}.regime.json`),
    JSON.stringify(body),
    "utf8",
  );
}

function briefFile(stateRoot: string, day: string, label: string): void {
  const dir = join(stateRoot, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `option-wizard-${day}-${label}.md`),
    `# [TEST] ${label} ${day}\n\n## edit — editor\n\n${JSON.stringify({
      headline: "markdown headline",
      sections: [{ title: "t", body: "b" }],
    })}\n`,
    "utf8",
  );
}

const RECORD = {
  cause: "August payrolls printed 162k",
  ust2y: 4.02,
  ust10y: 4.79,
  s2s10: 77,
  tide: "up",
  thesis: "No cut to give.",
};

describe("ow_prior_brief", () => {
  it("returns the newest record strictly before this run, across days", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    stateFile(stateRoot, "2026-09-03", "close", RECORD);
    stateFile(stateRoot, "2026-09-04", "premarket", {
      ...RECORD,
      cause: "own",
    });
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "premarket",
        today: "2026-09-04",
      }),
    );
    expect(out.prior.day).toBe("2026-09-03");
    expect(out.prior.phase).toBe("close");
    expect(out.prior.regimeState).toEqual(RECORD);
    expect(out.fallback).toBeUndefined();
  });

  it("orders two records on the same day by their place in the day", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    stateFile(stateRoot, "2026-09-04", "premarket", RECORD);
    stateFile(stateRoot, "2026-09-04", "intraday", { ...RECORD, cause: "mid" });
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "close",
        today: "2026-09-04",
      }),
    );
    expect(out.prior.phase).toBe("intraday");
    expect(out.prior.regimeState.cause).toBe("mid");
  });

  it("carries the prior report's headline beside the record", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    stateFile(stateRoot, "2026-09-03", "close", RECORD);
    briefFile(stateRoot, "2026-09-03", "close");
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "premarket",
        today: "2026-09-04",
      }),
    );
    expect(out.prior.headline).toBe("markdown headline");
  });

  it("falls back to the markdown brief when no record exists", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    briefFile(stateRoot, "2026-09-03", "close");
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "premarket",
        today: "2026-09-04",
      }),
    );
    expect(out.fallback).toBe("markdown");
    expect(out.prior.day).toBe("2026-09-03");
    expect(typeof out.prior.text).toBe("string");
  });

  it("ignores a record that no longer matches the schema", async () => {
    // A record written by an older build, or by a model that drifted, is not a
    // record: falling through to markdown is the honest answer.
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    stateFile(stateRoot, "2026-09-03", "close", { cause: "x" });
    briefFile(stateRoot, "2026-09-03", "close");
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "premarket",
        today: "2026-09-04",
      }),
    );
    expect(out.fallback).toBe("markdown");
  });

  it("says so, and never throws, when there is nothing at all", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-"));
    const out = JSON.parse(
      await toolNamed(stateRoot, "ow_prior_brief").run({
        phase: "premarket",
        today: "2026-09-04",
      }),
    );
    expect(out.prior).toBe(null);
    expect(typeof out.reason).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/state-regime.spec.ts -t "ow_prior_brief"`
Expected: FAIL — the current tool returns `{ prior: { text } }` keyed on the SAME phase, so `out.prior.phase` is `premarket` and `out.prior.regimeState` is undefined.

- [ ] **Step 3: Rewrite the tool body**

In `plugins/option-wizard/tools/index.ts`, add near the other module-level constants (beside `REPORT_NAME` at `:1175`):

```typescript
/** The order the day's runs happen in, for walking BACKWARDS from one of them.
 *  A label not listed sorts last within its day: it is a run this list has not
 *  been taught about, and putting it after the known ones is the answer that
 *  cannot reorder a known pair. */
const PHASE_ORDER = ["premarket", "frank", "intraday", "close", "weekly"];

function phaseRank(label: string): number {
  const at = PHASE_ORDER.indexOf(label);
  return at === -1 ? PHASE_ORDER.length : at;
}

const STATE_FILE = /^([a-z0-9-]+)\.regime\.json$/u;
```

Add the import at the top of the file, next to the other local imports:

```typescript
import { parseRegimeState } from "../state/regime.js";
```

Then replace the whole `async run(...)` body of `ow_prior_brief` (`:2577-2637`) with:

```typescript
      async run(args: Record<string, unknown>): Promise<string> {
        const { phase, today } = PriorBriefParams.parse(args);
        const wanted = phase ?? "premarket";
        // The report day in the zone the filenames are stamped in. Same
        // reasoning as ow_reports' date counting: a cutoff taken from this
        // process's clock disagrees with the filenames by a whole day for a
        // HK-scheduled run reading ET-dated files. In a replay the replayed
        // day replaces "today"; an explicit `today` argument still wins.
        const cutoff =
          today ??
          asOfDay ??
          new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_ZONE }).format(
            new Date(),
          );
        const here = phaseRank(wanted);
        const earlier = (day: string, label: string): boolean =>
          day < cutoff || (day === cutoff && phaseRank(label) < here);
        const stateDir = join(cfg.stateRoot, "option-wizard");
        // 1. The newest STATE RECORD strictly before this run. Calendar-aware
        //    for free: a closed day produced no run, so it wrote no file.
        let best: { day: string; label: string; state: unknown } | null = null;
        try {
          for (const day of await readdir(stateDir)) {
            if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) continue;
            for (const file of await readdir(join(stateDir, day))) {
              const match = STATE_FILE.exec(file);
              if (match === null) continue;
              const label = match[1]!;
              if (!earlier(day, label)) continue;
              if (
                best !== null &&
                (day < best.day ||
                  (day === best.day &&
                    phaseRank(label) < phaseRank(best.label)))
              )
                continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(
                  await readFile(join(stateDir, day, file), "utf8"),
                );
              } catch {
                continue;
              }
              const state = parseRegimeState(parsed);
              // A record that no longer matches the schema is not a record.
              if (state === null) continue;
              best = { day, label, state };
            }
          }
        } catch {
          // No state directory yet. The markdown fallback below is the answer.
        }
        // 2. The prior REPORT, for its headline and for the fallback text.
        const dir = join(cfg.stateRoot, "reports");
        let names: string[] = [];
        try {
          names = await readdir(dir);
        } catch {
          names = [];
        }
        const found = names
          .map((name) => ({ name, match: REPORT_NAME.exec(name) }))
          .filter(
            (row) => row.match !== null && earlier(row.match[1]!, row.match[2]!),
          )
          .sort((a, b) => {
            const byDay = b.match![1]!.localeCompare(a.match![1]!);
            return byDay !== 0
              ? byDay
              : phaseRank(b.match![2]!) - phaseRank(a.match![2]!);
          })[0];
        const doc =
          found === undefined
            ? null
            : extractJson(
                stepsOf(await readFile(join(dir, found.name), "utf8")).get(
                  "edit",
                ) ??
                  stepsOf(
                    await readFile(join(dir, found.name), "utf8"),
                  ).get("regime") ??
                  "",
              );
        const headline =
          doc !== null && typeof doc.headline === "string" ? doc.headline : "";
        if (best !== null) {
          return JSON.stringify({
            dir: stateDir,
            prior: {
              day: best.day,
              phase: best.label,
              headline,
              regimeState: best.state,
            },
            note: "The previous run's own state record. Compare it with today's; if the cause has not changed, keep the title and write only the delta. Every number about TODAY still comes from a live tool.",
          });
        }
        // 3. No record: the markdown brief, exactly as this tool used to serve
        //    it. A run before this feature existed, or one whose regime step
        //    did not produce a valid block, must still get something.
        if (found === undefined) {
          return JSON.stringify({
            dir,
            prior: null,
            reason: `no report or state record on disk before ${cutoff}`,
          });
        }
        const source =
          stepsOf(await readFile(join(dir, found.name), "utf8")).get("edit") ??
          "";
        const text = (
          doc === null ? source : JSON.stringify(pickBriefProse(doc))
        ).slice(0, PRIOR_BRIEF_CEILING_CHARS);
        return JSON.stringify({
          dir,
          fallback: "markdown",
          prior: {
            day: found.match![1]!,
            phase: found.match![2]!,
            file: found.name,
            headline,
            text,
          },
          note: "No state record for the previous run; this is its prose. Quote it only to say what changed.",
        });
      },
```

Update the tool's `description` and its `phase` param doc in the same entry:

```typescript
      description:
        "The previous run's regime state record — its cause, the 2Y/10Y/2s10s levels it copied, its tide and its one-sentence thesis — plus that run's headline. Falls back to the previous brief's prose (`fallback: \"markdown\"`) when no record exists. Read it to say what CHANGED; it is never evidence about today's tape.",
```

```typescript
        phase: {
          type: "string",
          description:
            "The run label you are writing FOR (premarket | intraday | close | weekly | frank). The tool returns the most recent record strictly before it.",
        },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/state-regime.spec.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS. If `pnpm build` says nothing changed but `lib/` is stale, `rm plugins/option-wizard/tsconfig.tsbuildinfo` and build again.

- [ ] **Step 6: Commit**

```bash
git add plugins/option-wizard/tools/index.ts plugins/option-wizard/tests/state-regime.spec.ts
git commit -m "feat(option-wizard): serve the prior run's regime record from ow_prior_brief"
```

---

## Task 11: The two personas that write and read the record (spec item 4, prompts)

**Files:**

- Modify: `plugins/option-wizard/team.yaml:167` (the `regime-analyst` persona's last line) and `:400-403` (the `editor` persona's `ow_prior_brief` paragraph)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**Interfaces:**

- Consumes: the fence name declared in `plugins/option-wizard/tenant.yaml` (Task 8) and the schema in `plugins/option-wizard/state/regime.ts` (Task 9). All three must agree on the six field names.
- Produces: nothing later tasks depend on.

**The cap is the risk.** `regime-analyst`'s persona is 3420 characters folded and the limit is 4000 (`packages/core/src/team.ts:44`). The text below is 437 characters, which lands at 3857. Step 4 measures it rather than trusting that.

- [ ] **Step 1: Write the failing test**

Append to `plugins/option-wizard/tests/team-manifest.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts -t "regime-state"`
Expected: FAIL — the persona does not contain `regime-state`.

- [ ] **Step 3: Extend the `regime-analyst` persona**

In `plugins/option-wizard/team.yaml`, the persona's last line is currently exactly:

```yaml
You do not propose trades.
```

Replace that one line with:

```yaml
      You do not propose trades.
      AFTER the JSON, end your reply with one fenced block whose info string is
      regime-state, containing one JSON object and nothing else:
      {"cause":"<the cause you named, under twelve words>","ust2y":<2Y level>,
      "ust10y":<10Y level>,"s2s10":<the 2s10s figure you were given>,
      "tide":"up"|"down"|"flat","thesis":"<one sentence>"}. Every number is
      COPIED from ow_macro_rates; omit a key you have no tool number for. It is
      state for the next run, never prose the reader sees.
```

- [ ] **Step 4: Measure the persona against the cap**

Run:

```bash
node -e "
const {readFileSync}=require('fs');
const y=readFileSync('plugins/option-wizard/team.yaml','utf8').split('\n');
const s=y.indexOf('  regime-analyst:');
const e=y.indexOf('  scenario-analyst:');
console.log(y.slice(s,e).join('\n').split('persona: >-')[1].split('\n').map(l=>l.trim()).filter(Boolean).join(' ').length);"
```

Expected: a number under 4000 (about 3860). If it is over, cut from the persona's LENGTH paragraph — which restates what the renderer enforces anyway — never from the regime-state instruction.

- [ ] **Step 5: Repoint the `editor` persona**

The four lines currently at `:400-403` are exactly:

```yaml
Your one tool is ow_prior_brief. Call it once. The first paragraph of the
macro read answers "what changed since yesterday's brief" — and if the
tool has no prior brief, that is one line saying so and then straight on
to today.
```

Replace them with:

```yaml
      Your one tool is ow_prior_brief. Call it once. It returns the previous
      run's `regimeState` — its cause, its rate levels, its tide, its thesis.
      Compare that record with what you were handed today. If the cause has NOT
      changed, keep the prior title and write only the delta; if it has, say
      what replaced it in the first paragraph of the macro read. When the tool
      returns `fallback: "markdown"` or no prior at all, that is one line and
      then straight on to today — never a headline, a title or a section about
      it.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Acceptance for spec item 4**

The spec's acceptance is "a unit test round-trips a regime block through parse → write → `ow_prior_brief`" and "a replay of 2026-09-03 intraday shows the JSON in the tool call, not the markdown".

The round-trip is Task 8 Step 5 (write) plus Task 10 Step 1 (read); run both together to prove they agree on the layout:

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts -t "state block" && pnpm vitest run --project unit plugins/option-wizard/tests/state-regime.spec.ts -t "ow_prior_brief"`
Expected: PASS, both.

Then the replay. Following the invocation in `docs/evidence/pit-replays/2026-09-05/README.md`, run 2026-09-03 premarket first (it writes the record) and then 2026-09-03 intraday:

```bash
helium run option-wizard --phase premarket --as-of 2026-09-03T12:45:00Z --variant item4
helium run option-wizard --phase intraday --as-of 2026-09-03T17:00:00Z --variant item4
```

Check:

1. `<stateRoot>/option-wizard/2026-09-03/premarket.regime.json` exists and parses as the six-field record.
2. The premarket report file contains no ` ```regime-state ` fence: `grep -c 'regime-state' <stateRoot>/reports/option-wizard-2026-09-03-premarket.md` returns `0`.
3. The intraday report's `ow_prior_brief` tool output contains `"regimeState"` and does NOT contain `"fallback":"markdown"`.

- [ ] **Step 9: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "feat(option-wizard): write and read the regime record from the two personas"
```

---

## Task 12: Record, index and prune tool I/O (spec item 1, storage)

**Files:**

- Create: `packages/cli/src/tool-io.ts`
- Create: `packages/cli/src/tool-io.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface ToolCallRecord { tool: string; args: Record<string, unknown>; at: string; raw: string | null; rawSha256: string | null; rawBytes: number; context: string | null; error?: string }`
  - `export function recordingsDir(stateRoot: string, runId: string): string` — `<stateRoot>/runs/<runId>/tool-io`
  - `export function argsKey(tool: string, args: Record<string, unknown>): string`
  - `export function writeRecording(dir: string, seq: number, record: ToolCallRecord): void`
  - `export interface RecordingIndex { has(tool: string): boolean; lookup(tool: string, args: Record<string, unknown>): string | undefined; served(): string[]; size: number }`
  - `export function loadRecordings(dir: string): RecordingIndex`
  - `export function pruneRecordings(stateRoot: string, options?: { now?: Date; days?: number; keep?: (runId: string) => boolean }): string[]` — returns the run ids removed.

**Two things the coordinator added to the spec on 2026-09-05, both folded in here.** (a) A record stores the RAW response with its `rawSha256` and `rawBytes`, plus `context` — the text that actually entered the model context when it differs from raw. There is no summariser today (`packages/cli/src/runner.ts:356-359` says so, and every span is written `summarised: false`), so `context` is written `null` and the field exists for the day one lands. (b) Pruning honours a caller-supplied keep-list: `pruneRecordings` takes `keep: (runId) => boolean` and skips whatever it returns true for. Core and the CLI never read a ledger; the caller that wants runs kept passes a predicate.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/tool-io.test.ts`:

```typescript
/**
 * Tool I/O recordings: what makes a live-only tool replayable at all.
 * @module @helium/cli/tool-io.test
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  argsKey,
  loadRecordings,
  pruneRecordings,
  recordingsDir,
  writeRecording,
} from "./tool-io.js";

const AT = "2026-09-05T13:45:00.000Z";

function record(tool: string, args: Record<string, unknown>, raw: string) {
  return {
    tool,
    args,
    at: AT,
    raw,
    rawSha256: "unused-by-lookup",
    rawBytes: Buffer.byteLength(raw, "utf8"),
    context: null,
  };
}

describe("argsKey", () => {
  it("does not depend on key order", () => {
    expect(argsKey("ow_spot", { b: 2, a: 1 })).toBe(
      argsKey("ow_spot", { a: 1, b: 2 }),
    );
  });

  it("separates two tools called with the same arguments", () => {
    expect(argsKey("ow_spot", { t: ["SPY"] })).not.toBe(
      argsKey("ow_uw_chain", { t: ["SPY"] }),
    );
  });

  it("separates two argument sets for one tool", () => {
    expect(argsKey("ow_spot", { tickers: ["SPY"] })).not.toBe(
      argsKey("ow_spot", { tickers: ["QQQ"] }),
    );
  });

  it("sorts nested keys too", () => {
    expect(argsKey("t", { o: { b: 1, a: 2 } })).toBe(
      argsKey("t", { o: { a: 2, b: 1 } }),
    );
  });
});

describe("writeRecording and loadRecordings", () => {
  it("round-trips a response through gzip and serves it by tool and args", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(
      dir,
      1,
      record("ow_spot", { tickers: ["SPY"] }, '{"close":661}'),
    );
    const index = loadRecordings(dir);
    expect(index.size).toBe(1);
    expect(index.has("ow_spot")).toBe(true);
    expect(index.has("ow_uw_gex")).toBe(false);
    expect(index.lookup("ow_spot", { tickers: ["SPY"] })).toBe('{"close":661}');
    expect(index.lookup("ow_spot", { tickers: ["QQQ"] })).toBeUndefined();
  });

  it("counts a tool as served only once it has actually answered", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, record("ow_spot", {}, "x"));
    writeRecording(dir, 2, record("ow_uw_gex", {}, "y"));
    const index = loadRecordings(dir);
    expect(index.served()).toEqual([]);
    index.lookup("ow_spot", {});
    index.lookup("ow_uw_gex", { nope: 1 });
    expect(index.served()).toEqual(["ow_spot"]);
  });

  it("keeps the last recording when one tool answered twice for the same args", () => {
    // A tool called twice in a run is normal. The later answer is the one a
    // replay of the whole run should see.
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, record("ow_spot", {}, "first"));
    writeRecording(dir, 12, record("ow_spot", {}, "second"));
    expect(loadRecordings(dir).lookup("ow_spot", {})).toBe("second");
  });

  it("serves nothing, and does not throw, for a directory that is not there", () => {
    const index = loadRecordings(join(tmpdir(), "helium-io-absent-xyz"));
    expect(index.size).toBe(0);
    expect(index.lookup("ow_spot", {})).toBeUndefined();
  });

  it("never serves an error record as if it were a response", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, {
      tool: "ow_spot",
      args: {},
      at: AT,
      raw: null,
      rawSha256: null,
      rawBytes: 0,
      context: null,
      error: "ECONNREFUSED",
    });
    const index = loadRecordings(dir);
    expect(index.has("ow_spot")).toBe(false);
    expect(index.lookup("ow_spot", {})).toBeUndefined();
  });
});

describe("pruneRecordings", () => {
  function runDir(root: string, runId: string, ageDays: number): void {
    const dir = join(root, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker"), "x", "utf8");
    const when = new Date(Date.UTC(2026, 8, 5) - ageDays * 86_400_000);
    utimesSync(dir, when, when);
  }

  it("removes runs older than 30 natural days and keeps the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    runDir(root, "old", 31);
    runDir(root, "edge", 29);
    runDir(root, "new", 0);
    const removed = pruneRecordings(root, {
      now: new Date("2026-09-05T00:00:00Z"),
    });
    expect(removed).toEqual(["old"]);
    expect(readdirSync(join(root, "runs")).sort()).toEqual(["edge", "new"]);
  });

  it("honours a keep-list and removes nothing it names", () => {
    // The caller — not this module — decides what is worth keeping. Nothing
    // here reads a ledger, a database or a config file.
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    runDir(root, "old-a", 40);
    runDir(root, "old-b", 40);
    const removed = pruneRecordings(root, {
      now: new Date("2026-09-05T00:00:00Z"),
      keep: (runId) => runId === "old-b",
    });
    expect(removed).toEqual(["old-a"]);
    expect(readdirSync(join(root, "runs")).sort()).toEqual(["old-b"]);
  });

  it("returns nothing, and does not throw, when there is no runs directory", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    expect(pruneRecordings(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/cli/src/tool-io.test.ts`
Expected: FAIL — `Cannot find module './tool-io.js'`.

- [ ] **Step 3: Write the module**

Create `packages/cli/src/tool-io.ts`:

```typescript
/**
 * Every tool call a run made, on disk, so the next replay can be served from
 * them instead of refused.
 *
 * The audit table stores `toolOutputBytes` and nothing else, which is why
 * fourteen live-only tools could never be replayed and pit coverage sat at
 * 10/24. A byte count is not history. This is: args, the instant, the raw
 * response, its sha256 and its length.
 *
 * `context` is the text that actually entered the model context when it
 * differs from `raw` — the summariser doctrine 4 calls for does not exist yet
 * (see packages/cli/src/runner.ts, where every span is written
 * `summarised: false`), so today it is always `null` and the field is here so
 * that a recording made after the summariser lands is still self-describing.
 *
 * Nothing in this file knows what a tool IS. It stores strings under a name.
 * @module @helium/cli/tool-io
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  /** ISO instant the call was made at — real time, not the replayed clock. */
  at: string;
  /** The tool's return, verbatim. `null` when the call threw. */
  raw: string | null;
  rawSha256: string | null;
  rawBytes: number;
  /** What entered the model context, when it is not `raw`. */
  context: string | null;
  /** Present instead of a response when the call threw. */
  error?: string;
}

/** `<stateRoot>/runs/<runId>/tool-io`. */
export function recordingsDir(stateRoot: string, runId: string): string {
  return join(stateRoot, "runs", runId, "tool-io");
}

/** Key order must not decide whether a replay hits. Recursive because a
 *  tool's arguments nest — `{ window: { days: 5 } }` is one call, however the
 *  two keys happened to be serialised. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort())
    out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

export function argsKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${createHash("sha256")
    .update(JSON.stringify(canonical(args)))
    .digest("hex")}`;
}

/** File-name-safe, and it does not have to round-trip: the record inside
 *  carries the real tool name, and the name in the file is for a human
 *  reading `ls`. */
function safeName(tool: string): string {
  return tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

export function writeRecording(
  dir: string,
  seq: number,
  record: ToolCallRecord,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(
      dir,
      `${String(seq).padStart(5, "0")}-${safeName(record.tool)}.json.gz`,
    ),
    gzipSync(Buffer.from(JSON.stringify(record), "utf8")),
  );
}

/** The sha256 of a response, for the record. Exported so a caller can compare
 *  a served answer against the one that was recorded without decompressing
 *  twice. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface RecordingIndex {
  /** Whether this run recorded ANY successful call to the tool. */
  has(tool: string): boolean;
  lookup(tool: string, args: Record<string, unknown>): string | undefined;
  /** Tool names that have actually answered from this index, sorted. */
  served(): string[];
  size: number;
}

/**
 * Every recording in one directory, keyed by tool and canonical args.
 *
 * File name order IS call order (a zero-padded sequence), so a later call
 * overwrites an earlier one for the same key: a tool called twice in a run
 * should replay as its last answer, which is the state the rest of the run
 * saw. An ERROR record is not indexed — replaying a failure as if it were a
 * response is the one outcome worse than refusing.
 */
export function loadRecordings(dir: string): RecordingIndex {
  const byKey = new Map<string, string>();
  const tools = new Set<string>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json.gz")) continue;
      let record: ToolCallRecord;
      try {
        record = JSON.parse(
          gunzipSync(readFileSync(join(dir, name))).toString("utf8"),
        ) as ToolCallRecord;
      } catch {
        continue;
      }
      if (typeof record.raw !== "string") continue;
      byKey.set(argsKey(record.tool, record.args ?? {}), record.raw);
      tools.add(record.tool);
    }
  }
  const hit = new Set<string>();
  return {
    has: (tool) => tools.has(tool),
    lookup(tool, args) {
      const found = byKey.get(argsKey(tool, args));
      if (found !== undefined) hit.add(tool);
      return found;
    },
    served: () => [...hit].sort((a, b) => a.localeCompare(b, "en")),
    size: byKey.size,
  };
}

/**
 * Delete run directories older than `days` natural days.
 *
 * Thirty by default: a 21-trading-day lookback plus holidays. One directory
 * walk and no index — an index of what is on disk is a second source of truth
 * about what is on disk.
 *
 * `keep` is the caller's, and it is the only way anything survives its age.
 * This module reads no ledger, no database and no config: whoever knows that a
 * run is still cited passes a predicate that says so.
 */
export function pruneRecordings(
  stateRoot: string,
  options: {
    now?: Date;
    days?: number;
    keep?: (runId: string) => boolean;
  } = {},
): string[] {
  const root = join(stateRoot, "runs");
  if (!existsSync(root)) return [];
  const cutoff =
    (options.now ?? new Date()).getTime() -
    (options.days ?? 30) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const runId of readdirSync(root).sort()) {
    if (options.keep?.(runId) === true) continue;
    const dir = join(root, runId);
    try {
      if (statSync(dir).mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(runId);
    } catch {
      // A directory that vanished under us, or one we may not stat, is not a
      // reason to abandon the rest of the prune.
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit packages/cli/src/tool-io.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Confirm no recorded `args` can carry a credential**

Recordings persist `args` and `raw` to disk for 30 days. Tool args are
model-supplied through each tool's dsh parameter spec; credentials enter via
`cfg.env`, never args. Verify that, do not assume it:

```bash
grep -nEi "(key|token|secret|password|dsn)" plugins/option-wizard/tools/index.ts \
  | grep -Ei "parameters|properties|z\.object" | head
```

Expected: no line where a parameter spec names a credential. If any does,
add that parameter name to a `REDACT` set in `tool-io.ts` and replace its
value with `"[redacted]"` inside `record()` before serialising, plus one test.
Paste the grep output (or its emptiness) into the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/tool-io.ts packages/cli/src/tool-io.test.ts
git commit -m "feat(cli): record, index and prune every tool call's raw response"
```

---

## Task 13: The runner records every call, and `--replay-from` reaches the tenant (spec item 1, wiring)

**Files:**

- Modify: `packages/cli/src/args.ts:10-66`
- Modify: `packages/cli/src/cli.ts:175`, `:209-226`, `:237-240`
- Modify: `packages/cli/src/discovery.ts:112-153`
- Modify: `packages/cli/src/runner.ts:180-200` (`RunOptions`), `:687-703` (the wrapper), `:1229-1237` (`pitCoverage`), `:1410-1418` (the header line)
- Modify: `packages/core/src/report.ts:96-101`
- Test: `packages/cli/src/args.test.ts` (create if absent — check with `ls packages/cli/src/args.test.ts`), `packages/cli/src/runner.test.ts`

**Interfaces:**

- Consumes: everything Task 12 produced.
- Produces:
  - `RunArgs.replayFrom?: string` and `RunOptions.replayFrom?: string`
  - `TenantToolConfig.recordings?: { has(tool: string): boolean; lookup(tool: string, args: Record<string, unknown>): string | undefined }` — the exact object Task 14's tenant code reads.
  - `RunReport.pitCoverage.served?: string[]`
  - Files at `<stateRoot>/runs/<runId>/tool-io/<seq>-<tool>.json.gz` for every run.

**Rebase warning.** A concurrent agent edits `runner.ts` and `discovery.ts`. `git pull --rebase` immediately before Step 5 and locate the two runner anchors by content: the wrapper goes between `const tools = ... );` and `const toolsByName = new Map(...)` (`:693-703`); the coverage block begins `if (options.asOf !== undefined) {` followed by `report.pitCoverage = {`.

- [ ] **Step 1: Write the failing flag test**

Create `packages/cli/src/args.test.ts` (if the file exists, append the `describe` block instead):

```typescript
/**
 * `helium run` flags. `--replay-from` names the run whose recordings serve
 * this one's live-only tools.
 * @module @helium/cli/args.test
 */
import { describe, expect, it } from "vitest";
import { parseRunArgs } from "./args.js";

describe("--replay-from", () => {
  it("is absent by default", () => {
    expect(parseRunArgs([])).toEqual({ phase: "premarket", variant: "live" });
  });

  it("carries the run id", () => {
    expect(
      parseRunArgs([
        "--as-of",
        "2026-09-03T17:00:00Z",
        "--replay-from",
        "run-abc",
      ]),
    ).toMatchObject({ replayFrom: "run-abc" });
  });

  it("refuses a run id that could climb out of the state root", () => {
    // The value becomes a path segment under <stateRoot>/runs.
    expect(parseRunArgs(["--replay-from", "../../etc"])).toEqual({
      error: "--replay-from is not a run id: ../../etc",
    });
    expect(parseRunArgs(["--replay-from", "a/b"])).toEqual({
      error: "--replay-from is not a run id: a/b",
    });
  });

  it("refuses a missing value", () => {
    expect(parseRunArgs(["--replay-from"])).toEqual({
      error: "--replay-from needs a run id, e.g. --replay-from run-abc123",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/cli/src/args.test.ts`
Expected: FAIL — `unknown argument: --replay-from`.

- [ ] **Step 3: Add the flag**

In `packages/cli/src/args.ts`, add to `RunArgs` after `variant`:

```typescript
  /**
   * A previous run whose recorded tool responses serve this one. Only a tool
   * that has NO history for `asOf` consults them; everything else runs as it
   * always did.
   */
  replayFrom?: string;
```

Add `let replayFrom: string | undefined;` beside the other declarations, and this branch before the final `return { error: ... }`:

```typescript
if (flag === "--replay-from") {
  const bad = needsValue();
  if (bad !== undefined)
    return {
      error: "--replay-from needs a run id, e.g. --replay-from run-abc123",
    };
  // It becomes a path segment under <stateRoot>/runs. A run id is what
  // `randomUUID()` produces with a `run-` in front of it; anything with a
  // separator or a dot in it is not one, and refusing here is cheaper than
  // discovering it as a read of some other directory.
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(value!))
    return { error: `--replay-from is not a run id: ${value!}` };
  replayFrom = value!;
  i += 1;
  continue;
}
```

and extend the return:

```typescript
return {
  phase,
  variant,
  ...(asOf === undefined ? {} : { asOf }),
  ...(replayFrom === undefined ? {} : { replayFrom }),
};
```

- [ ] **Step 4: Run the flag test to verify it passes**

Run: `pnpm vitest run --project unit packages/cli/src/args.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing runner test**

Append to `packages/cli/src/runner.test.ts`:

```typescript
describe("tool I/O recording", () => {
  it("writes one recording per tool call, and a replay serves it back", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-io-run-"));
    const audit = new AuditStore(":memory:");
    const live = await runTenant({
      tenant: tenant(1, DELIVERY_YAML).tenant,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot,
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      modelExecutor,
      channels: [],
      renderer: null,
    });
    const index = loadRecordings(recordingsDir(stateRoot, live.runId));
    expect(index.size).toBeGreaterThan(0);
    expect(index.has(echo.name)).toBe(true);
    audit.close();
  });

  it("records a throwing tool as an error and never serves it", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-io-run-"));
    const audit = new AuditStore(":memory:");
    const boom = {
      ...echo,
      name: "boom",
      run: async (): Promise<string> => {
        throw new Error("ECONNREFUSED");
      },
    };
    const report = await runTenant({
      tenant: tenant(1, DELIVERY_YAML).tenant,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot,
      env: {},
      providers: [provider],
      tools: [boom],
      catalog: catalogFor([provider]),
      modelExecutor,
      channels: [],
      renderer: null,
    });
    expect(
      loadRecordings(recordingsDir(stateRoot, report.runId)).has("boom"),
    ).toBe(false);
    audit.close();
  });

  it("prunes runs older than 30 days at the start of a run", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-io-run-"));
    const stale = join(stateRoot, "runs", "run-ancient");
    mkdirSync(stale, { recursive: true });
    const when = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(stale, when, when);
    const audit = new AuditStore(":memory:");
    await runTenant({
      tenant: tenant(1, DELIVERY_YAML).tenant,
      audit,
      pluginsDir: "/nonexistent",
      stateRoot,
      env: {},
      providers: [provider],
      tools: [echo],
      catalog: catalogFor([provider]),
      modelExecutor,
      channels: [],
      renderer: null,
    });
    expect(existsSync(stale)).toBe(false);
    audit.close();
  });
});
```

Add `loadRecordings` and `recordingsDir` (from `./tool-io.js`) plus whichever of `mkdirSync`, `utimesSync`, `existsSync`, `mkdtempSync`, `tmpdir`, `join` the file does not already import. Use the file's own fixture names for `tenant(...)`, `provider`, `echo`, `modelExecutor` and `catalogFor(...)`.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts -t "tool I/O recording"`
Expected: FAIL — nothing is written under `<stateRoot>/runs`.

- [ ] **Step 7: Wrap every tool the runner loaded**

In `packages/cli/src/runner.ts`, add to the imports:

```typescript
import {
  loadRecordings,
  pruneRecordings,
  recordingsDir,
  sha256,
  writeRecording,
  type RecordingIndex,
} from "./tool-io.js";
```

Add to `RunOptions`, after `variant`:

```typescript
  /**
   * A previous run whose recorded tool responses may serve this one's. Core
   * hands the tenant a lookup and never decides which tools want it — a tool
   * knows what is behind it and the runner does not (doctrine 2).
   */
  replayFrom?: string;
```

Then, between the `const tools = ...` assignment and `const toolsByName = ...` (`:693-703`), insert:

```typescript
// Prune BEFORE recording, so a run cannot be pruned by the run that is
// writing it, and so the walk happens once per run rather than per call.
// No keep-list here: `pruneRecordings` takes one, and the caller that knows
// a run is still cited is the one that will pass it.
pruneRecordings(options.stateRoot);
const replayIndex: RecordingIndex | undefined =
  options.replayFrom === undefined
    ? undefined
    : loadRecordings(recordingsDir(options.stateRoot, options.replayFrom));
// ONE wrapper, installed once, covering both paths a tool can be called on:
// the deterministic path calls `tool.run` directly and the model path hands
// these same objects to the provider through `selection.options.tools`.
// Wrapping at either call site would record half a run.
const ioDir = recordingsDir(options.stateRoot, runId);
let ioSeq = 0;
const recorded = tools.map((tool) => ({
  ...tool,
  run: async (args: Record<string, unknown>): Promise<string> => {
    const at = new Date().toISOString();
    ioSeq += 1;
    const seq = ioSeq;
    try {
      const raw = await tool.run(args);
      try {
        writeRecording(ioDir, seq, {
          tool: tool.name,
          args,
          at,
          raw,
          rawSha256: sha256(raw),
          rawBytes: Buffer.byteLength(raw, "utf8"),
          // Null until a summariser exists: nothing between a tool and a
          // context rewrites the text today. The field is written anyway so
          // a recording made after one lands is still self-describing.
          context: null,
        });
      } catch {
        // A recording that cannot be written must never cost the run the
        // answer it already has.
      }
      return raw;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        writeRecording(ioDir, seq, {
          tool: tool.name,
          args,
          at,
          raw: null,
          rawSha256: null,
          rawBytes: 0,
          context: null,
          error: message,
        });
      } catch {
        // Same rule.
      }
      throw error;
    }
  },
}));
const toolsByName = new Map(recorded.map((tool) => [tool.name, tool]));
```

Delete the original `const toolsByName = new Map(tools.map(...))` line it replaces. `tools.length` is still the right denominator for `pitCoverage` — `recorded` has exactly the same members.

- [ ] **Step 8: Pass the recordings to the tenant's tools**

Still in `runner.ts`, extend the `loadTenantTools` call (`:693-702`) with:

```typescript
      ...(replayIndex === undefined ? {} : { recordings: replayIndex }),
```

In `packages/cli/src/discovery.ts`, add to `TenantToolConfig` (after the `calendar` field at `:126`):

```typescript
  /** Recorded responses from an earlier run, when the operator named one with
   *  `--replay-from`. A tool with no history for `asOf` may answer from here
   *  instead of refusing. The host supplies the lookup and never decides which
   *  tools want it. */
  recordings?: {
    has: (tool: string) => boolean;
    lookup: (
      tool: string,
      args: Record<string, unknown>,
    ) => string | undefined;
  };
```

Add the same two members to the inline `buildTools` structural type at `:135-143`, and the passthrough to the call at `:146-153`:

```typescript
    ...(cfg.recordings === undefined ? {} : { recordings: cfg.recordings }),
```

- [ ] **Step 9: Count the served tools in `pitCoverage`**

In `packages/core/src/report.ts`, add to the `pitCoverage` object (`:96-101`):

```typescript
    /** Names answered from a stored response rather than by their source.
     *  Absent when nothing was. Core stores the names and reads none. */
    served?: string[];
```

In `packages/cli/src/runner.ts`, replace the `report.pitCoverage = {...}` assignment (`:1230-1236`) with:

```typescript
const served = replayIndex?.served() ?? [];
report.pitCoverage = {
  total: tools.length,
  // A tool that answered from a recording is available. It marked itself
  // unavailable only if the recording missed too, so the two sets cannot
  // both claim it.
  available: Math.max(0, tools.length - pitUnavailable.size),
  unavailable: [...pitUnavailable.keys()].sort((a, b) =>
    a.localeCompare(b, "en"),
  ),
  ...(served.length === 0 ? {} : { served }),
};
```

Extend the header line in `deliveryBody` (`:1410-1418`):

```typescript
if (report.pitCoverage !== undefined) {
  const { available, total, unavailable, served } = report.pitCoverage;
  lines.push(
    `- pit coverage: ${String(available)}/${String(total)}` +
      (served === undefined || served.length === 0
        ? ""
        : ` (from recordings: ${served.join(", ")})`) +
      (unavailable.length === 0
        ? ""
        : ` (unavailable: ${unavailable.join(", ")})`),
  );
}
```

- [ ] **Step 10: Pass the flag through the CLI**

In `packages/cli/src/cli.ts`, change the destructure at `:184` to `const { phase, asOf, variant, replayFrom } = parsed;`, add to the `runTenant` call (`:209-226`):

```typescript
        ...(replayFrom === undefined ? {} : { replayFrom }),
```

and extend both usage strings (`:175` and `:237-240`) to end with `[--replay-from <runId>]`, plus one help line:

```typescript
      "      --replay-from serves a live-only tool's recorded response from an",
      "      earlier run instead of refusing it. Recordings live under",
      "      <stateRoot>/runs/<runId>/tool-io and are pruned after 30 days.",
```

Extend `printRun`'s coverage line (`:38-45`) the same way `deliveryBody`'s was.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts packages/cli/src/args.test.ts packages/cli/src/tool-io.test.ts`
Expected: PASS.

- [ ] **Step 12: Run the whole suite and the neutrality contract**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS — the only core edit here is `served?: string[]` on `pitCoverage`.

- [ ] **Step 13: Commit**

```bash
git add packages/cli/src/args.ts packages/cli/src/args.test.ts packages/cli/src/cli.ts packages/cli/src/discovery.ts packages/cli/src/runner.ts packages/cli/src/runner.test.ts packages/core/src/report.ts
git commit -m "feat(cli): record every tool call and add --replay-from to serve one from a recording"
```

---

## Task 14: The tenant answers a live-only tool from a recording (spec item 1, serving)

**Files:**

- Modify: `plugins/option-wizard/tools/index.ts:1394-1395` (`AS_OF_BLIND_SENTENCE`), `:1397-1409` (the `buildTools` cfg type), `:3617-3638` (the wrapper)
- Test: `plugins/option-wizard/tests/tools-as-of.spec.ts` — check `grep -rln "AS_OF_BLIND\|unavailable" plugins/option-wizard/tests/` first and extend the file that already covers the as-of wrapper rather than creating a second one.

**Interfaces:**

- Consumes: `TenantToolConfig.recordings` (Task 13) — `{ has(tool), lookup(tool, args) }`.
- Produces: an `AS_OF_BLIND` tool that returns its recorded response when one exists for the same arguments, and the unchanged `{ unavailable: "as-of" }` payload otherwise.

**One behaviour change, deliberate.** `markUnavailable` moves from build time (`:3626`) to call time, but ONLY for a tool the recordings have. With no `--replay-from`, `cfg.recordings` is undefined and the eager path is byte-for-byte what it is today — which is what keeps the existing pit-coverage tests meaningful.

**Rebase warning.** A concurrent agent owns this file. `git pull --rebase` immediately before Step 3; locate the wrapper by `const source = AS_OF_BLIND.get(tool.name);`.

- [ ] **Step 1: Write the failing test**

Add to the tenant's as-of spec (creating `plugins/option-wizard/tests/tools-as-of.spec.ts` only if no such file exists):

```typescript
/**
 * Serving a live-only tool from a recording. Fourteen tools refuse a replayed
 * instant because their sources have no history (tools/index.ts:1314-1336) —
 * but a recording of one of OUR OWN earlier runs IS history.
 * @module dsh-plugin-tenant-option-wizard/tests/tools-as-of
 */
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

const AS_OF = new Date("2026-09-03T17:00:00Z");

function toolNamed(cfg: Parameters<typeof buildTools>[0], name: string) {
  return buildTools(cfg).find((tool) => tool.name === name)!;
}

describe("as-of tools with recordings", () => {
  it("refuses as before when the operator named no recording", async () => {
    const marked: string[] = [];
    const tool = toolNamed(
      {
        stateRoot: "/tmp/none",
        env: {},
        variant: "live",
        asOf: AS_OF,
        pit: { markUnavailable: (name) => marked.push(name) },
      },
      "ow_spot",
    );
    expect(JSON.parse(await tool.run({ tickers: ["SPY"] })).unavailable).toBe(
      "as-of",
    );
    expect(marked).toContain("ow_spot");
  });

  it("returns the recorded response, and marks nothing unavailable", async () => {
    const marked: string[] = [];
    const tool = toolNamed(
      {
        stateRoot: "/tmp/none",
        env: {},
        variant: "live",
        asOf: AS_OF,
        pit: { markUnavailable: (name) => marked.push(name) },
        recordings: {
          has: (name) => name === "ow_spot",
          lookup: (name, args) =>
            name === "ow_spot" &&
            JSON.stringify(args) === JSON.stringify({ tickers: ["SPY"] })
              ? '{"rows":[{"ticker":"SPY","close":661.02}]}'
              : undefined,
        },
      },
      "ow_spot",
    );
    expect(await tool.run({ tickers: ["SPY"] })).toBe(
      '{"rows":[{"ticker":"SPY","close":661.02}]}',
    );
    expect(marked).toEqual([]);
  });

  it("falls back to the refusal, lazily, when the arguments do not match", async () => {
    const marked: string[] = [];
    const tool = toolNamed(
      {
        stateRoot: "/tmp/none",
        env: {},
        variant: "live",
        asOf: AS_OF,
        pit: { markUnavailable: (name) => marked.push(name) },
        recordings: { has: () => true, lookup: () => undefined },
      },
      "ow_spot",
    );
    // Nothing is marked until the tool is actually CALLED and misses.
    expect(marked).toEqual([]);
    expect(JSON.parse(await tool.run({ tickers: ["QQQ"] })).unavailable).toBe(
      "as-of",
    );
    expect(marked).toContain("ow_spot");
  });

  it("leaves a tool that is not live-only alone", async () => {
    const tool = toolNamed(
      {
        stateRoot: "/tmp/none",
        env: {},
        variant: "live",
        asOf: AS_OF,
        recordings: { has: () => true, lookup: () => "should not be used" },
      },
      "ow_macro_rates",
    );
    expect(tool.description).not.toContain("Unavailable in an as-of replay");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/tools-as-of.spec.ts`
Expected: FAIL — `recordings` is not a property `buildTools`'s cfg type accepts, and the second case returns the refusal payload.

- [ ] **Step 3: Extend the cfg type and the wrapper**

In `plugins/option-wizard/tools/index.ts`, add to the `buildTools` parameter type (`:1397-1409`):

```typescript
  /** Responses recorded by an earlier run of this tenant, when the operator
   *  passed `--replay-from`. Our OWN past call is history even where the
   *  source has none, which is the whole reason pit coverage was stuck. */
  recordings?: {
    has: (tool: string) => boolean;
    lookup: (
      tool: string,
      args: Record<string, unknown>,
    ) => string | undefined;
  };
```

Add beside `AS_OF_BLIND_SENTENCE` (`:1394`):

```typescript
const AS_OF_REPLAYED_SENTENCE =
  "In this as-of replay the answer comes from a recording of an earlier live run of this tenant, not from the source. Treat it exactly as a live answer; the report's own header says which tools were served this way.";
```

Replace the `built.map(...)` body (`:3622-3637`) with:

```typescript
return built.map((tool) => {
  const source = AS_OF_BLIND.get(tool.name);
  if (source === undefined) return tool;
  const reason = `${source} has no history`;
  const payload = JSON.stringify({
    unavailable: "as-of",
    asOf: asOfIso,
    reason,
  });
  // A recording of one of our own earlier runs IS history for this tool.
  // Marked unavailable LAZILY on this branch: a tool that never got called,
  // or that got called with arguments the recording covers, is not a gap.
  if (cfg.recordings?.has(tool.name) === true) {
    const recordings = cfg.recordings;
    return {
      ...tool,
      description: `${tool.description} ${AS_OF_REPLAYED_SENTENCE}`,
      run: async (args: Record<string, unknown>): Promise<string> => {
        const recorded = recordings.lookup(tool.name, args);
        if (recorded !== undefined) return recorded;
        cfg.pit?.markUnavailable(
          tool.name,
          `${reason}, and no recording for these arguments`,
        );
        return payload;
      },
    };
  }
  cfg.pit?.markUnavailable(tool.name, reason);
  return {
    ...tool,
    description: `${tool.description} ${AS_OF_BLIND_SENTENCE}`,
    run: async (): Promise<string> => payload,
  };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/`
Expected: PASS — in particular any pre-existing as-of / pit-coverage test, which takes the unchanged eager branch because it passes no `recordings`.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Acceptance for spec item 1**

Record one live run, then replay it:

```bash
# 1. A live run. It records every tool call under <stateRoot>/runs/<runId>/tool-io.
helium run option-wizard --phase premarket
# note the run id it prints

# 2. How much it recorded, and of what.
ls "${HELIUM_STATE_ROOT:-$PWD/.helium-state}/runs/<runId>/tool-io" | wc -l

# 3. The same instant, replayed, served from that run.
helium run option-wizard --phase premarket \
  --as-of <the ISO instant of step 1> --variant recorded \
  --replay-from <runId>
```

Check:

1. The replay prints `pit coverage: N/24` with `N` strictly greater than the 10/24 the 2026-09-05 replays recorded, and a `(from recordings: …)` list.
2. For every tool named in that list, the two reports' tool lines agree byte for byte:
   ```bash
   diff <(grep -F 'ow_spot ->' <live report>) <(grep -F 'ow_spot ->' <replay report>)
   ```
   Expected: no output.
3. `<stateRoot>/runs/<runId>/tool-io/00001-*.json.gz` decompresses to a record carrying `tool`, `args`, `at`, `raw`, `rawSha256`, `rawBytes` and `context: null`:
   ```bash
   gunzip -c "<stateRoot>/runs/<runId>/tool-io/00001-"*.json.gz | head -c 400
   ```

**On the spec's "24/24".** It is reachable only if every one of the fourteen live-only tools was called in the live run WITH THE SAME ARGUMENTS in the replay — and several take arguments derived from that run's own universe step, which a model may not reproduce exactly. If `N < 24`, read the header's `unavailable:` list: each entry is a tool whose args differed, not a tool with no recording. Record the number and the list in the PR description; do not chase 24/24 by loosening the args key, which would serve one ticker's answer for another's.

- [ ] **Step 7: Commit**

```bash
git add plugins/option-wizard/tools/index.ts plugins/option-wizard/tests/tools-as-of.spec.ts
git commit -m "feat(option-wizard): answer a live-only tool from a recording during a replay"
```

---

## Task 15: `ow_review_window` and the `extensions` passthrough (spec item 6, data)

**Files:**

- Modify: `packages/cli/src/discovery.ts:112-153` (`extensions` on `TenantToolConfig` and the inline type)
- Modify: `packages/cli/src/runner.ts:693-702` (pass `spec.extensions`)
- Modify: `plugins/option-wizard/tenant.yaml:187-201` (`extensions:`)
- Modify: `plugins/option-wizard/tools/index.ts` (`isClosedDay`, the new tool, its `VOCABULARY` entry)
- Test: `plugins/option-wizard/tests/tools-review-window.spec.ts`

**Interfaces:**

- Consumes: `priorOpenDay` (`plugins/option-wizard/tools/index.ts:1378-1392`), the report files the markdown channel writes, the regime records Task 8 writes, and `AuditStore.metricsBetween` (Task 3).
- Produces:
  - `TenantToolConfig.extensions?: Record<string, unknown>`
  - `export function isClosedDay(day: string, calendar?: { weekdaysOnly: boolean; closed: string[] }): boolean`
  - `export function openDaysBack(from: string, count: number, calendar?): string[]` — oldest first, length exactly `count`.
  - the tool `ow_review_window`, returning `{ cutoff, windows: [{ days, from, to, sessions: [...], ledger, coverage: [...] }] }`.

**Where the three metrics come from: the audit table, by `(day, label)`.** Task 3 gives `metric` a `day` and a `label` column and `metricsBetween(fromDay, toDay)`, so this tool asks the database the question directly — one call per window, newest run per `(day, label)`, no join through the filesystem and no re-parsing of a rendered header. **How the tool gets a handle:** `AuditStore.open(cfg.env)` (`packages/core/src/audit.ts:120-122`), which resolves `HELIUM_AUDIT_DB` or `~/.helium/audit.db` through the already-exported `auditDbPath(env)` (`:94-96`). `@helium/core` is already a runtime dependency of this tenant (`plugins/option-wizard/package.json`), so nothing new is added to the dependency graph. The store is opened once per call and CLOSED in a `finally` — a tool that leaks a SQLite handle per run leaks one per day forever. The open is wrapped in `try`/`catch`: a missing or unreadable database is a coverage note (`quality unavailable: …`), never a failed review.

**Read-only?** `node:sqlite`'s `DatabaseSync` is opened read-write by `AuditStore`, and there is no read-only constructor to reach for. That is acceptable here: the tool issues one `SELECT` and the alternative — a second connection class in core, or a raw `DatabaseSync` inside a tenant duplicating the schema — is more surface than the risk it removes. If a read-only handle is ever wanted, it belongs on `AuditStore` as `openReadOnly(env)`, not in this file.

**Blocked, and shipped anyway.** `readLedger` (`packages/core/src/ledger.ts`) and `summarise` (`packages/cli/src/scoreboard.ts`) come from the Outcome Ledger session's PR and do not exist yet. Both are imported dynamically inside a `try`; their absence produces the coverage note `ledger scoreboard unavailable: <reason>`, which is exactly the behaviour the spec asks for when the ledger is absent. **`@helium/cli` is not currently a dependency of this tenant** (`plugins/option-wizard/package.json`), so `summarise` will not resolve until whoever lands the ledger adds `"@helium/cli": "file:../../packages/cli"` there. Until then the ledger half of item 6's acceptance is blocked; everything else in this task is not.

- [ ] **Step 1: Write the failing test**

Create `plugins/option-wizard/tests/tools-review-window.spec.ts`:

```typescript
/**
 * The weekly review's data. Every number in it is read off a file or off the
 * audit table; the model that reads the result computes nothing.
 * @module dsh-plugin-tenant-option-wizard/tests/tools-review-window
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "@helium/core";
import { describe, expect, it } from "vitest";
import { buildTools, isClosedDay, openDaysBack } from "../tools/index.js";

// Labor Day 2026 and the NYSE list this tenant declares.
const CALENDAR = { weekdaysOnly: true, closed: ["2026-09-07"] };

/** A throwaway audit database the tool will find through cfg.env. */
function auditDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ow-review-db-")), "audit.db");
}

function seedMetrics(
  dbPath: string,
  day: string,
  label: string,
  values: Record<string, number | null>,
): void {
  const store = new AuditStore(dbPath);
  for (const [name, value] of Object.entries(values))
    store.appendMetric({
      runId: `run-${day}-${label}`,
      name,
      value,
      ts: `${day}T20:00:00.000Z`,
      day,
      label,
    });
  store.close();
}

function report(
  stateRoot: string,
  day: string,
  label: string,
  title: string,
): void {
  const dir = join(stateRoot, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `option-wizard-${day}-${label}.md`),
    [
      `# [TEST] ${label} ${day}`,
      "",
      "## edit — editor",
      "",
      JSON.stringify({
        headline: "h",
        sections: [{ title, body: "b" }],
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}

function state(stateRoot: string, day: string, label: string, cause: string) {
  const dir = join(stateRoot, "option-wizard", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${label}.regime.json`),
    JSON.stringify({ cause, tide: "up", thesis: "t" }),
    "utf8",
  );
}

describe("openDaysBack", () => {
  it("counts trading days, oldest first, skipping the weekend", () => {
    expect(openDaysBack("2026-09-04", 5, CALENDAR)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("starts from the previous open day when the run day is closed", () => {
    // Sunday 2026-09-06: the weekly run's own day is not a session.
    expect(openDaysBack("2026-09-06", 2, CALENDAR)).toEqual([
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("skips a declared holiday", () => {
    expect(isClosedDay("2026-09-07", CALENDAR)).toBe(true);
    expect(openDaysBack("2026-09-08", 2, CALENDAR)).toEqual([
      "2026-09-04",
      "2026-09-08",
    ]);
  });
});

describe("ow_review_window", () => {
  function tool(stateRoot: string, dbPath = auditDb()) {
    return buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: dbPath },
      variant: "live",
      calendar: CALENDAR,
      extensions: { review: { windows: [5, 10, 21] } },
    }).find((entry) => entry.name === "ow_review_window")!;
  }

  it("returns one block per declared window, with the 5-day window naming exactly 08-31..09-04", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows.map((w: { days: number }) => w.days)).toEqual([
      5, 10, 21,
    ]);
    expect(out.windows[0].sessions.map((s: { day: string }) => s.day)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    expect(out.windows[0].from).toBe("2026-08-31");
    expect(out.windows[0].to).toBe("2026-09-04");
  });

  it("carries each session's cause titles, regime record and quality numbers", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const dbPath = auditDb();
    report(stateRoot, "2026-09-04", "close", "August payrolls printed 162k");
    state(stateRoot, "2026-09-04", "close", "August payrolls printed 162k");
    seedMetrics(dbPath, "2026-09-04", "close", {
      metaLeakHits: 1,
      budgetViolations: 0,
      causeTitleSimilarity: 0.107,
    });
    const out = JSON.parse(
      await tool(stateRoot, dbPath).run({ today: "2026-09-04" }),
    );
    const friday = out.windows[0].sessions.find(
      (s: { day: string }) => s.day === "2026-09-04",
    );
    expect(friday.causeTitles.close).toBe("August payrolls printed 162k");
    expect(friday.regime.close.cause).toBe("August payrolls printed 162k");
    // Straight out of the metric table, keyed by (day, label) — not parsed
    // back out of the rendered report header.
    expect(friday.quality.close).toEqual({
      metaLeakHits: 1,
      budgetViolations: 0,
      causeTitleSimilarity: 0.107,
    });
  });

  it("reads only the newest run when a (day, label) ran twice", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const dbPath = auditDb();
    const store = new AuditStore(dbPath);
    store.appendMetric({
      runId: "run-first",
      name: "metaLeakHits",
      value: 4,
      ts: "2026-09-04T18:00:00.000Z",
      day: "2026-09-04",
      label: "close",
    });
    store.appendMetric({
      runId: "run-second",
      name: "metaLeakHits",
      value: 0,
      ts: "2026-09-04T21:00:00.000Z",
      day: "2026-09-04",
      label: "close",
    });
    store.close();
    const out = JSON.parse(
      await tool(stateRoot, dbPath).run({ today: "2026-09-04" }),
    );
    const friday = out.windows[0].sessions.find(
      (s: { day: string }) => s.day === "2026-09-04",
    );
    expect(friday.quality.close).toEqual({ metaLeakHits: 0 });
  });

  it("names a session with nothing recorded rather than dropping it", async () => {
    // A day with no report is a day the run did not produce one, and that is
    // the finding. Dropping it would make a broken week look like a short one.
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows[0].sessions[0]).toEqual({
      day: "2026-08-31",
      causeTitles: {},
      regime: {},
      quality: {},
    });
  });

  it("notes the ledger as unavailable rather than failing", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const out = JSON.parse(await tool(stateRoot).run({ today: "2026-09-04" }));
    expect(out.windows[0].ledger).toBe(null);
    expect(out.windows[0].coverage.join(" ")).toContain("ledger");
  });

  it("notes an unreadable audit database rather than failing", async () => {
    // A laptop with no audit.db, or a path the process cannot open, still gets
    // its cause titles and its regime records. A review that refuses to run
    // because one of its three inputs is missing is a review that never runs.
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const bad = buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: join(stateRoot, "no-such-dir", "x", "audit.db") },
      variant: "live",
      calendar: CALENDAR,
    }).find((entry) => entry.name === "ow_review_window")!;
    const out = JSON.parse(await bad.run({ today: "2026-09-04" }));
    expect(out.windows[0].sessions).toHaveLength(5);
    expect(out.windows[0].coverage.join(" ")).toContain("quality unavailable");
  });

  it("falls back to 5/10/21 when the tenant declares no windows", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-review-"));
    const bare = buildTools({
      stateRoot,
      env: { HELIUM_AUDIT_DB: auditDb() },
      variant: "live",
      calendar: CALENDAR,
    }).find((entry) => entry.name === "ow_review_window")!;
    const out = JSON.parse(await bare.run({ today: "2026-09-04" }));
    expect(out.windows.map((w: { days: number }) => w.days)).toEqual([
      5, 10, 21,
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/tools-review-window.spec.ts`
Expected: FAIL — `openDaysBack` and `isClosedDay` are not exported and no tool is named `ow_review_window`.

- [ ] **Step 3: Carry `extensions` to the tenant's tools**

In `packages/cli/src/discovery.ts`, add to `TenantToolConfig`:

```typescript
  /** The tenant's own opaque block, CARRIED and never read. `extensions` is
   *  the tenant's word about itself; handing it back to the tenant's own
   *  `buildTools` is not the host reading inside it. */
  extensions?: Record<string, unknown>;
```

Add `extensions?: Record<string, unknown>;` to the inline `buildTools` structural type, and the passthrough to the call:

```typescript
    ...(cfg.extensions === undefined ? {} : { extensions: cfg.extensions }),
```

In `packages/cli/src/runner.ts`, add to the `loadTenantTools` call:

```typescript
      ...(Object.keys(spec.extensions).length === 0
        ? {}
        : { extensions: spec.extensions }),
```

- [ ] **Step 4: Declare the windows**

In `plugins/option-wizard/tenant.yaml`, replace `extensions: {}` (`:201`) with:

```yaml
extensions:
  # The weekly review's lookback windows, in TRADING days — counted with the
  # `calendar` block above, never with a subtraction from a date. 5 is the week
  # just ended, 10 the fortnight, 21 the month. Read only by this tenant's own
  # ow_review_window tool; the host carries this block and never opens it.
  review:
    windows: [5, 10, 21]
```

- [ ] **Step 5: Export the calendar helpers and write the tool**

In `plugins/option-wizard/tools/index.ts`, replace the body of `priorOpenDay` (`:1378-1392`) so the predicate has a name, and add the walker:

```typescript
/** Whether the market this tenant writes about is shut on `day`. The tenant's
 *  own calendar declaration is the only authority; there is no derivation. */
export function isClosedDay(
  day: string,
  calendar?: { weekdaysOnly: boolean; closed: string[] },
): boolean {
  const weekends = calendar === undefined || calendar.weekdaysOnly;
  return (
    (calendar?.closed ?? []).includes(day) ||
    // 0 Sunday, 6 Saturday — the two the modulo picks out.
    (weekends && new Date(`${day}T00:00:00Z`).getUTCDay() % 6 === 0)
  );
}

export function priorOpenDay(
  day: string,
  calendar?: { weekdaysOnly: boolean; closed: string[] },
): string {
  let out = priorDay(day);
  // Bounded: a run of closed days longer than a fortnight is a broken
  // declaration, not a holiday, and looping forever on it would hang the run.
  for (let step = 0; step < 14 && isClosedDay(out, calendar); step += 1)
    out = priorDay(out);
  return out;
}

/**
 * The last `count` OPEN days ending at `from`, oldest first.
 *
 * `from` itself is included when it is open — a Friday close review counts
 * Friday — and replaced by the previous open day when it is not, which is the
 * Sunday case the weekly run actually runs on. Never a subtraction: 21 trading
 * days is 29 to 31 calendar days depending on which holidays fall inside, and
 * a date arithmetic that guesses is a window that silently moves.
 */
export function openDaysBack(
  from: string,
  count: number,
  calendar?: { weekdaysOnly: boolean; closed: string[] },
): string[] {
  const out: string[] = [];
  let day = isClosedDay(from, calendar) ? priorOpenDay(from, calendar) : from;
  out.push(day);
  while (out.length < count) {
    day = priorOpenDay(day, calendar);
    out.push(day);
  }
  return out.reverse();
}
```

Add the params schema beside the other schemas near `:1046`:

```typescript
const ReviewWindowParams = z.object({
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

/**
 * Every run's quality numbers over a day range, as `day -> label -> name ->
 * value`, straight out of the audit table.
 *
 * `metricsBetween` already takes the newest run of each `(day, label)`, so
 * this only shapes the rows. A `null` value — "not computable that run" — is
 * DROPPED here rather than written as 0: the reviewer is asked which numbers
 * moved, and a zero that means "we could not tell" is the one reading that
 * would make it lie.
 *
 * The store is opened per call and closed in a `finally`. A tool that leaks a
 * SQLite handle leaks one per run, forever.
 */
function qualityByDay(
  env: NodeJS.ProcessEnv,
  fromDay: string,
  toDay: string,
): {
  rows: Map<string, Record<string, Record<string, number>>>;
  note?: string;
} {
  const rows = new Map<string, Record<string, Record<string, number>>>();
  let store: AuditStore | undefined;
  try {
    store = AuditStore.open(env);
    for (const row of store.metricsBetween(fromDay, toDay)) {
      if (row.value === null) continue;
      const byLabel = rows.get(row.day) ?? {};
      byLabel[row.label] = {
        ...(byLabel[row.label] ?? {}),
        [row.name]: row.value,
      };
      rows.set(row.day, byLabel);
    }
  } catch (error: unknown) {
    return {
      rows,
      note: `quality unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    store?.close();
  }
  return { rows };
}
```

Add the import at the top of `plugins/option-wizard/tools/index.ts`, next to the other `@helium/core` usage (it is already a runtime dependency, `plugins/option-wizard/package.json`):

```typescript
import { AuditStore } from "@helium/core";
```

Add this entry to the array `buildTools` returns, next to `ow_reports`:

```typescript
    {
      // The weekly review's whole input, gathered deterministically. The model
      // that reads this READS numbers; it computes none of them, which is the
      // standing rule after eight of eleven model-computed numbers audited on
      // 2026-09-03 came back wrong.
      //
      // Windows are TRADING days, counted with the tenant's own calendar.
      name: "ow_review_window",
      description:
        "This tenant's own last 5 / 10 / 21 TRADING days, per window: each session's cause-section titles, its regime state records, the run's own quality numbers (`metaLeakHits`, `budgetViolations`, `causeTitleSimilarity`, straight from the audit table), and the Outcome Ledger scoreboard when one exists. Everything here is read off disk or out of the audit table; nothing is estimated.",
      paramsSchema: ReviewWindowParams,
      mutating: false,
      dshParams: {
        today: {
          type: "string",
          description:
            "YYYY-MM-DD day to count back FROM, inclusive when it is a session. Omit for this run's own report day.",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { today } = ReviewWindowParams.parse(args);
        const cutoff =
          today ??
          asOfDay ??
          new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_ZONE }).format(
            new Date(),
          );
        const declared = (
          cfg.extensions as { review?: { windows?: unknown } } | undefined
        )?.review?.windows;
        const windows = (
          Array.isArray(declared) &&
          declared.every((n) => typeof n === "number" && n > 0 && n <= 60)
            ? declared
            : [5, 10, 21]
        ) as number[];
        const dir = join(cfg.stateRoot, "reports");
        let names: string[] = [];
        try {
          names = await readdir(dir);
        } catch {
          names = [];
        }
        const byDay = new Map<string, Array<{ label: string; file: string }>>();
        for (const name of names) {
          const match = REPORT_NAME.exec(name);
          if (match === null) continue;
          const list = byDay.get(match[1]!) ?? [];
          list.push({ label: match[2]!, file: name });
          byDay.set(match[1]!, list);
        }
        const out = [];
        for (const days of windows) {
          const span = openDaysBack(cutoff, days, cfg.calendar);
          // ONE query per window, not one per session: the metric table is
          // asked for the range and the rows are handed out by day below.
          const measured = qualityByDay(
            cfg.env,
            span[0] ?? cutoff,
            span[span.length - 1] ?? cutoff,
          );
          const sessions = [];
          for (const day of span) {
            const causeTitles: Record<string, string> = {};
            const quality = measured.rows.get(day) ?? {};
            const regime: Record<string, unknown> = {};
            for (const entry of byDay.get(day) ?? []) {
              let markdown: string;
              try {
                markdown = await readFile(join(dir, entry.file), "utf8");
              } catch {
                continue;
              }
              const doc = extractJson(stepsOf(markdown).get("edit") ?? "");
              const first = Array.isArray(doc?.sections)
                ? ((doc.sections[0] ?? {}) as { title?: unknown })
                : {};
              if (typeof first.title === "string" && first.title !== "")
                causeTitles[entry.label] = first.title;
            }
            try {
              const stateDir = join(cfg.stateRoot, "option-wizard", day);
              for (const file of await readdir(stateDir)) {
                const match = STATE_FILE.exec(file);
                if (match === null) continue;
                const parsed = parseRegimeState(
                  JSON.parse(await readFile(join(stateDir, file), "utf8")),
                );
                if (parsed !== null) regime[match[1]!] = parsed;
              }
            } catch {
              // No records for that day. The empty object says so.
            }
            sessions.push({ day, causeTitles, regime, quality });
          }
          // The Outcome Ledger is a peer session's module and may not be
          // installed. Absent is a COVERAGE NOTE, never an error: a review
          // that refuses to run because the scoreboard is missing is a review
          // that never runs.
          let ledger: unknown = null;
          const coverage: string[] = [];
          // An audit database that would not open is one input missing, not a
          // failed review: the cause titles and the regime records still went
          // out above.
          if (measured.note !== undefined) coverage.push(measured.note);
          try {
            const core = (await import("@helium/core")) as {
              readLedger?: (
                stateRoot: string,
                tenant: string,
                options?: { since?: string },
              ) => unknown[];
            };
            const cli = (await import("@helium/cli")) as {
              summarise?: (
                records: unknown[],
                options: { deployment?: string; variant?: string },
              ) => unknown;
            };
            if (core.readLedger === undefined || cli.summarise === undefined)
              throw new Error("readLedger/summarise not installed");
            ledger = cli.summarise(
              core.readLedger(cfg.stateRoot, "option-wizard", {
                since: sessions[0]?.day ?? cutoff,
              }),
              {},
            );
          } catch (error: unknown) {
            coverage.push(
              `ledger scoreboard unavailable: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          out.push({
            days,
            from: sessions[0]?.day ?? cutoff,
            to: sessions[sessions.length - 1]?.day ?? cutoff,
            sessions,
            ledger,
            coverage,
          });
        }
        return JSON.stringify({ cutoff, windows: out });
      },
    },
```

Add `["ow_review_window", { mutating: false }]` to `VOCABULARY` beside the `ow_reports` entry (near `:66`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/tools-review-window.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS — the `extensions` passthrough is in `packages/cli`, not in core.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/discovery.ts packages/cli/src/runner.ts plugins/option-wizard/tenant.yaml plugins/option-wizard/tools/index.ts plugins/option-wizard/tests/tools-review-window.spec.ts
git commit -m "feat(option-wizard): add ow_review_window over 5/10/21 trading-day windows"
```

---

## Task 16: The `week-review` step inside the weekly phase (spec item 6, prompt)

**Files:**

- Modify: `plugins/option-wizard/team.yaml` (a `week-reviewer` role beside `weekly-analyst` at `:351-363`; a `week-review` task beside `weekly` at `:798-812`)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts`

**Interfaces:**

- Consumes: `ow_review_window` (Task 15).
- Produces: nothing later tasks depend on.

**The task is named `week-review`, not `review`.** `review` is already a task id in this manifest (`plugins/option-wizard/team.yaml:591-611`, the pre-flight design review that runs in premarket and close). A duplicate id makes `parseTeamYaml` throw `duplicate task id` (`packages/core/src/team.ts:75-77`) and the tenant is skipped for the whole day.

- [ ] **Step 1: Write the failing test**

Append to `plugins/option-wizard/tests/team-manifest.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts -t "weekly review"`
Expected: FAIL — there is no `week-review` task.

- [ ] **Step 3: Add the role**

In `plugins/option-wizard/team.yaml`, insert immediately after the `weekly-analyst` role block (after `:363`, before `frank-comparator:`):

```yaml
week-reviewer:
  requires: [reason.deep, long.context, tool.use]
  permissions:
    mutations: forbidden
    tools: [ow_review_window]
  persona: >-
    You review THIS DESK'S OWN OUTPUT over three windows — the last 5, 10 and
    21 trading days — and nothing else. You have one tool and no live data:
    every title, record and number you write is copied out of what it
    returned, and you never compute, average or re-derive one.
    Per window, three answers and no more:
    (1) WHICH CAUSES HELD — a cause named on more than one day whose later
    sessions did not contradict it. Name the days.
    (2) WHICH DID NOT — a cause that appeared once and was replaced, or one
    the ledger settled against. Say what replaced it.
    (3) WHAT TO CHANGE NEXT WEEK — one concrete change to how the desk
    writes, sourced from the numbers: a rising `metaLeakHits`, a
    `causeTitleSimilarity` that stays high (the brief is re-telling itself), a
    `budgetViolations` count that will not come down, a window with sessions
    missing entirely.
    A window whose sessions are empty is reported as empty, in one line. A
    missing ledger is one line in the same place. You do not fill a gap with
    a plausible sentence: an unwritten week is the finding.
```

- [ ] **Step 4: Add the task**

Insert immediately after the `weekly` task block (after `:812`, before `- id: frank`):

```yaml
- id: week-review
  role: week-reviewer
  phases: [weekly]
  requires: [reason.deep, long.context]
  prompt: >-
    Call ow_review_window once, with no arguments, and write one page from
    what it returns. It gives you three windows — 5, 10 and 21 TRADING days,
    counted with this tenant's own calendar — and for each one every
    session's cause titles, its regime state records, that run's quality
    numbers (`metaLeakHits`, `budgetViolations`, `causeTitleSimilarity`) and the Outcome Ledger
    scoreboard when there is one.
    One section per window, in the order the tool returned them, titled with
    the window's own dates ("5 sessions, 2026-08-31 to 2026-09-04"). In each:
    which causes held, which did not, and the one change to make next week.
    Copy every number and every date from the tool; never compute one, and
    never estimate a figure the tool did not give you. Where a window's
    `coverage` names something unavailable, say it in ONE clause at the end
    of that section and move on.
    Reply as ONE JSON object and nothing else: {"sections":[{"title","body"}]}
    — one entry per window, in that order, no prose outside the JSON. Your
    working notes are not a section.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Acceptance for spec item 6**

The spec's acceptance is "a replay `--as-of 2026-09-04T21:00Z --phase review` produces three window blocks; the 5-day block lists exactly the five days 08-31..09-04". The phase is `weekly`, not `review`, for the reason argued above; everything else stands.

Run:

```bash
helium run option-wizard --phase weekly \
  --as-of 2026-09-04T21:00Z --variant item6
```

Check, against `<stateRoot>/reports/option-wizard-2026-09-04-weekly.md`:

1. The report carries a `## week-review — week-reviewer` step.
2. Its JSON has exactly three `sections`, one per window.
3. The first section's title names `2026-08-31` and `2026-09-04`.
4. The tool output in that step lists exactly these five days for the 5-day window:
   ```bash
   grep -o '"day":"2026-0[89]-[0-9][0-9]"' <report> | head -5
   ```
   Expected: `2026-08-31`, `2026-09-01`, `2026-09-02`, `2026-09-03`, `2026-09-04`.
5. **Blocked:** the ledger block reads `"ledger":null` with a `ledger scoreboard unavailable` coverage note until the Outcome Ledger session's `packages/core/src/ledger.ts` and `packages/cli/src/scoreboard.ts` land and `@helium/cli` is added to the tenant's dependencies. Record that in the PR description; it is expected, not a failure.

- [ ] **Step 8: Commit**

```bash
git add plugins/option-wizard/team.yaml plugins/option-wizard/tests/team-manifest.spec.ts
git commit -m "feat(option-wizard): add the week-review step to the weekly phase"
```

---

## Before opening the PR

- **Run everything, once, from a clean build.**
  ```bash
  rm -f plugins/option-wizard/tsconfig.tsbuildinfo
  pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts
  ```
  All four must pass. `pnpm test:contracts` is serialized and slow; run it anyway — `core-neutrality`, `topology-boundary` and `claims-register` are the three this PR could plausibly break.
- **Confirm with the Outcome Ledger session** that the ledger does not read the `markout`, `drift` or `recap` steps' output. The spec makes this a merge blocker (item 3, last bullet). The `weekly` prompt's dependency on those step ids is repaired in Task 1 Step 5; the ledger is a separate consumer this repo cannot check. (Recorded as resolved on 2026-09-05 — re-confirm before merging, since this PR is larger than the one that answer was given about.)
- **State the two known-blocked items in the PR description**, so a reviewer does not read them as defects:
  1. Item 6's ledger scoreboard is `null` with a coverage note until `readLedger` (`packages/core/src/ledger.ts`) and `summarise` (`packages/cli/src/scoreboard.ts`) land and `"@helium/cli": "file:../../packages/cli"` is added to `plugins/option-wizard/package.json`.
  2. Item 1's pit coverage will read `N/24` with `N < 24` whenever a live-only tool was called with different arguments in the live run and the replay. Record the number and the tool list; do not widen the args key to reach 24.
- **State the two deliberate deviations from the spec:**
  1. Item 6 runs as the `week-review` TASK inside the existing `weekly` phase, not as a sixth phase, and its acceptance replay is `--phase weekly`. The reasoning is in "Decision: item 6 extends the EXISTING `weekly` phase" above.
  2. `ow_prior_brief`'s `phase` argument changed meaning — it now names the run label you are writing FOR, and the tool returns the most recent record strictly before it. Nothing else calls this tool.
- **Do not deploy during an acceptance window** (`AGENTS.md`, Release and ops). This PR changes `launchd/` not at all, which is the point of the item 6 decision, but `receive-deploy.sh` still reinstalls plists and kickstarts on every deploy.
- **Follow-ups to open, not to do here:**
  - Stale `["markout","recap"]` examples in the `ow_reports` description at `plugins/option-wizard/tools/index.ts:2427` and `:2443`, and the stale `markout` comment at `plugins/option-wizard/tenant.yaml:118-119`.
  - The report-filename and step-heading regexes now living in three places: `plugins/option-wizard/quality/prior.ts`, `plugins/option-wizard/tools/index.ts:1161-1175`, and the new `ow_review_window`. One tenant-local module should own `REPORT_NAME`, `stepsOf` and `PHASE_ORDER`.
  - `ow_review_window` opens its own `AuditStore` per call (`AuditStore.open(cfg.env)`). If a second tenant ever needs the same, a read-only `AuditStore.openReadOnly(env)` on core is the place for it — not a second `DatabaseSync` inside a plugin.
  - A `keep` predicate for `pruneRecordings` — the hook exists and nothing passes one. The Outcome Ledger is the obvious first caller: a run a settled trade cites should outlive 30 days.
  - `context` is written `null` on every recording because no summariser exists. When one lands, the wrapper in `packages/cli/src/runner.ts` is where it gets filled in.
