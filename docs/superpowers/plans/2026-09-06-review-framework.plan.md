# Implementation plan (v2, consolidated) — Review framework: weekly 复盘+下周展望, daily close/premarket, focus list, theme register

**Intended file:** `/private/tmp/claude-501/-Users-chenxi-projects-helium/04ed705b-a291-45d0-ac8f-dd2433903e9f/scratchpad/research/2026-09-06-review-framework.v2.plan.md`
**Lands in repo as:** `docs/superpowers/plans/2026-09-06-review-framework.plan.md` (Task 0)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans` (or `/execute-plan`), task by task, in order. Steps use `- [ ]` checkboxes. Do NOT dispatch parallel subagents.

> **This file supersedes `2026-09-06-review-framework.plan.md` (the body + Addenda A/B/C/D).** Every amendment those addenda made to the body is applied **in place** here: the coverage row count is `12 + |sectors| + |themes|` everywhere, `declared` carries `themes`, `REVIEW_TITLES` is the seven sections of spec §J.1, `ow_ib_positions` is gone from every role and replaced by tickers of interest, and the optional email task is dropped. Task numbers are contiguous and every cross-reference points at this file's numbering. Do not read the old plan alongside this one — where they differ, this one is right.

**Goal:** In ONE PR on `feat/review-framework`, give option-wizard a **seven-section** review document — Scorecard · 上周复盘 · Coverage (macro / sectors / themes / rotation) · 下周展望 · Dated catalysts · Focus · Open calls — that is **rendered from the outcome ledger and the tools**, never narrated by the model; whose coverage list is **declarative and never shrinks** (`12 + |sectors| + |themes|` rows, missing data prints `untested`); whose verdict tokens and focus admissions are **stored commitments scored next period by a settler**; whose weekly-15 / daily-5 focus list is **computed from dated event feeds with declared weights**, byte-identical on replay; and which runs daily at one third the size, one phase behind. The One Thing lead item, its channel ranking and its check-scoring loop are merged into the same PR because they share the ledger, the renderer and the metric table.

**Architecture:** One deterministic step (`requires: []`) runs one tool, `ow_session_frame`, which computes everything arithmetic exactly once: the ranked channels, the fixed coverage rows (macro + sectors + themes), the focus 15 and focus 5, yesterday's three checks already scored, and the ledger's own rows (receipts settled today; commitments still outstanding). A second deterministic step, `rotation`, runs `ow_rotation` on the weekly only, because 12+N daily-bar histories are a weekly cost. The model receives both payloads through the ordinary `dependsOn` handoff and writes only: one lead paragraph, 上周复盘, 下周展望, one ≤15-word _why_ clause plus a verdict token and a probability per coverage row, one ≤20-word line per focus name, one ≤25-word leadership line per theme. The renderer finds the payloads in `report.toolOutputs` by shape (the way `argonBaseline` already finds argon's), prints sections 1/3/5/6/7 itself, trims 2/4 to the caps declared in `tenant.yaml`, mints one commitment per scorable verdict and per admitted focus name, and writes the metric rows. The settlers (`eval/verdict.ts`, dispatched from the existing `settleAll`) score last period's verdicts against the _next_ dated observation of the same row — found in the ledger itself — and each focus admission against real bars.

**Tech stack:** TypeScript ESM, Node 22.19+/24+, pnpm workspace, vitest (`unit`, `contracts`), zod 4, `node:sqlite` via `@helium/core`'s `AuditStore`.

**Spec:** `docs/superpowers/specs/2026-09-06-review-framework.md` (copied by Task 0). Sections **C, E, F, G, H, I, J** are normative; **§J "The complete shape" is the authoritative output shape and supersedes the C.3/C.4 section tables where they differ.**
**Merged design:** `docs/superpowers/specs/2026-09-06-one-thing-brief.md` + `docs/superpowers/specs/2026-09-06-brief-craft.md` (also copied by Task 0).

---

## Global constraints

- **Doctrine is binding** — `/Users/chenxi/projects/helium/AGENTS.md`, read by absolute path from the primary checkout (it is gitignored and will not be in the worktree). The four that bite here:
  - **2 (core knows no domain):** nothing in this PR adds or edits a line under `packages/core/src`. Every seam already exists: `readLedger`/`outstanding`/`appendLedger`, `Commitment`/`Receipt`/`Settler`, `CommitmentDraft`, `RunMetric`/`RenderedReport.metrics`, `AuditStore.appendMetric`/`metricsBetween`, `StepReport.toolOutputs`, `TenantSpec.stateBlock`, `requires: []`. `contracts/tests/core-neutrality.contract.spec.ts` is therefore unaffected — verify, do not assume.
  - **4 (audit is a queryable table; the LLM never does arithmetic):** every figure in the document is copied from a tool string or from a string the renderer formatted. Verdict classification, Brier scoring, focus scoring, basket excess, coverage counting and word counting are code. Metric rows are written for every number spec §F names, plus the seven §G/§H rows.
  - **6 (ceremony must earn its keep):** no new gate. `invalidation-triple` stays ablated (see the ablation record). `week-reviewer` is not given a second page to write; it feeds counters. Anything that could be a deletion is one.
  - **1 (the loop):** `verdictBrier`, `callHitRate` and `focusHitRate` can only improve if the brief got more _right_, which is what makes the next Helium iteration able to check this change on itself.
- **The argon `/flash` page is PUBLIC.** No position, size, quantity, account value, net liquidation or P/L may reach `BriefView`. **`ow_ib_positions` is removed from every role (Task 5)** and replaced by an operator-maintained **tickers of interest** source; `render/review.ts` never reads a positions payload; the `calls.open` coverage row and section 7 print **published candidates and forecasts** (ledger commitment ids), never holdings.
- **Coverage never shrinks.** The row list is `extensions.review.coverage` + `extensions.review.sectors` + `extensions.review.themes`, in declared order: **`12 + |sectors| + |themes|` rows — 23 with the shipped declaration, and never a hard-coded constant.** Every test computes the expected count from the same declaration the renderer read; a constant would make adding a theme a test edit, which is the coupling `extensions:` exists to avoid. A row with no datum, or with a datum but no model token, prints `untested` and increments `coverageGaps`. There is no code path that omits a row.
- **Numbers are rendered, never narrated** (spec C.0.1). **A verdict is a stored commitment** (C.0.2) and is scored from the ledger, never from prose. **A focus admission is a stored commitment too** (§G.5).
- **The renderer may not learn a phase name.** `plugins/option-wizard/tests/render.spec.ts`, block `"the renderer never branches on phase"`, scans every `.ts` directly under `render/` for a quoted `"premarket" | "intraday" | "close" | "weekly" | "frank"` or a non-comment line with `phase` next to a comparison operator. Branching on a **task id** (`step.task === "weekly"`) is established and allowed — `sectionsFrom` already does it for `regime`. Phase-ordered logic lives in `quality/`, `state/` and the manifest.
- **Tests:** vitest `unit` project. Every asserted number comes from a recorded tool response or from `$S/pit/weekend-2026-09-06/reports/*.md` (as-of dated, provenance recorded in the fixture README). No synthetic prices, no round placeholder tickers, no network, no live model.
- **Tool comments record the live response shape they were verified against**, with the date and the excluded noisy fields (repo convention, AGENTS.md "Declarative surfaces"). **No endpoint shape is ever written from memory** — an unverified feed gets an `it.skip` gate naming what is missing (Task 1 Step 3), never an invented field.
- **Personas ≤4000 chars** (`TeamRoleSchema.persona`), **prompts ≤20000** (`TeamTaskSchema.prompt`). Task 15 rewrites rather than appends and measures with `node -e`.
- **Files another session may own:** `packages/cli/src/runner.ts`, `packages/core/src/**`. Do not edit. If a task appears to need one, stop and re-scope.
- **Repo traps.** `.gitignore` line 6 is a bare `state/` and line 10 is `!plugins/option-wizard/state/` — verify with `git check-ignore -v <path>` (expect no output) before committing anything new under `state/`. `packages/cli/src/runner.test.ts` imports `@helium/core` from `lib/`, so `pnpm build` precedes `pnpm test` after any type change. A stale `plugins/option-wizard/tsconfig.tsbuildinfo` silently skips a rebuild — `rm` it if `lib/` looks old. `plugins/option-wizard/tsconfig.json` `include` and `package.json` `files` already list `tools gates render quality state eval`; every new file here lands in one of those, so no build-input edit is needed.
- **`contracts/brief-view-v2.fixture.json` is a cross-repo contract with argon.** New `BriefView` fields require regenerating it (`HELIUM_WRITE_FIXTURE=1`) and bumping `BRIEF_VIEW_SCHEMA_VERSION` — Task 11 owns the bump to **3**, Tasks 11 and 12 each regenerate the fixture, and the version stays **3** for both (one PR, one version). argon's `flashHeliumFixture.test.tsx` reads `schemaVersion`. **argon needs no change**: `SectionsPanel` renders `view.sections` generically, so the seven review sections reach the public page as ordinary sections.
- **Commands:** `pnpm build && pnpm typecheck && pnpm test`; single test `pnpm vitest run --project unit <path>`; `pnpm vitest run --project contracts` (needs `pnpm build` first).
- **Commit messages:** `<type>(<scope>): <subject>`. No `Co-Authored-By`, no emoji, no AI attribution (user global instruction overrides the default).
- **Branch/worktree:** `git worktree add .worktrees/review-framework -b feat/review-framework origin/master` from `35db17e`. Remove the worktree when the PR merges.

---

## Where the existing machinery lives — anchored by content, not line number

| Thing                                                       | File and anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger read / outstanding                                   | `packages/core/src/ledger.ts` — `readLedger(stateRoot, tenant, {since?}) -> {commitments, receipts, baselines}`, `outstanding(read)`, `ledgerPath`                                                                                                                                                                                                                                                                                                                     |
| Commitment / Receipt / Settler / CommitmentDraft            | `packages/core/src/plugins.ts` — the comment ``"Core never looks inside `payload`"``                                                                                                                                                                                                                                                                                                                                                                                   |
| Settler runs BEFORE the DAG                                 | `packages/cli/src/runner.ts` — `const ledger = readLedger(...)` then `const open = outstanding(ledger)`, under the comment `"it runs BEFORE the DAG and cannot be starved by a budget the tasks spend"`. Rendering happens far later (`rendered = loadedRenderer.renderer(report, spec)`). **This ordering is why verdicts settle against the newest observation strictly earlier than this run.**                                                                     |
| Settler discovery and the cfg it is handed                  | `packages/cli/src/discovery.ts`, `loadSettler` — passes `{stateRoot, env, variant, asOf?, calendar?}` and **not** `extensions`                                                                                                                                                                                                                                                                                                                                         |
| The tenant's settler                                        | `plugins/option-wizard/eval/settle.ts` — `buildSettler(cfg)`, `settleAll(open, now, source, calendar)` dispatching on `payload.kind`, `binaryBrier`, `pending(commitment, now, reason)`, `hashBars`                                                                                                                                                                                                                                                                    |
| Commitment minting from the renderer                        | `plugins/option-wizard/render/ledger.ts` — `forecastCommitments(view, phase)`, `baselineDraft(view, report, phase)`; `renderReport` returns `{..., commitments, baselines}`                                                                                                                                                                                                                                                                                            |
| Metric table                                                | `packages/core/src/audit.ts` — `CREATE TABLE IF NOT EXISTS metric (run_id, name, value, ts, day, label)`, **PK `(run_id, name)`**, `appendMetric`, `metricsBetween`                                                                                                                                                                                                                                                                                                    |
| Who writes metric rows                                      | `packages/cli/src/runner.ts`, `options.audit.appendMetric({runId, name, value, ts, day, label: phase})` — **`label` is the run phase and is not free for a tenant to use**                                                                                                                                                                                                                                                                                             |
| Quality metric assembly                                     | `plugins/option-wizard/quality/index.ts`, `qualityMetrics({view, report})` → the `RunMetric[]` on `RenderedReport.metrics`                                                                                                                                                                                                                                                                                                                                             |
| An existing tenant-side AuditStore reader                   | `plugins/option-wizard/tools/index.ts`, `qualityByDay` — opens per call, closes in `finally`, turns a failure into a `note`. Copy this shape.                                                                                                                                                                                                                                                                                                                          |
| Payload lookup by SHAPE                                     | `plugins/option-wizard/render/index.ts`, `toolPayloads`, `policySnapshotDate`; `render/ledger.ts`, `argonBaseline` (`envelope.source !== "argon.uw_scan"`)                                                                                                                                                                                                                                                                                                             |
| Budget constants / trim / measure                           | `plugins/option-wizard/render/budget.ts` — `FLASH_BUDGET`, `words`, `trim` (cuts at the last sentence end inside the budget), `measure`                                                                                                                                                                                                                                                                                                                                |
| Where the budget is enforced                                | `plugins/option-wizard/render/index.ts`, `enforceBudget`                                                                                                                                                                                                                                                                                                                                                                                                               |
| View assembly                                               | `render/index.ts` — `BriefView`, `assembleView`, `sectionsFrom` (already branches on `step.task === "regime"`), `editorDocFrom`, `applyEditor`, `buildView`, default `renderReport`                                                                                                                                                                                                                                                                                    |
| Review window tool + its defect                             | `tools/index.ts`, `name: "ow_review_window"` — `const STATE_FILE = /^([a-z0-9-]+)\.regime\.json$/u`, the `readdir(stateDir)` in a `try` whose `catch` comment reads `"No records for that day. The empty object says so."`, `qualityByDay`, and the defensive `@helium/core` / `cliSpecifier` imports                                                                                                                                                                  |
| Trading-day walk                                            | `tools/index.ts`, `priorOpenDay`, `openDaysBack` (both take `cfg.calendar`)                                                                                                                                                                                                                                                                                                                                                                                            |
| Env-gated argon HTTP tool to copy                           | `tools/index.ts`, `name: "ow_argon_levels"` — `need(env, "OW_ARGON_API_BASE", tool)`, per-ticker `Promise.all`, partial rows named as partial                                                                                                                                                                                                                                                                                                                          |
| Positions tool and its two callers (both removed in Task 5) | `tools/index.ts`, `name: "ow_ib_positions"`; `team.yaml` roles `universe-builder` (`tools: [ow_tv_watchlist, ow_spot, ow_ib_positions]`) and `risk-reviewer`                                                                                                                                                                                                                                                                                                           |
| Bars for the settler and the baskets                        | `plugins/option-wizard/eval/bars.ts` — `Bar`, `apexBarSource` (`bars1d`/`bars1m`), `fixtureBarSource`                                                                                                                                                                                                                                                                                                                                                                  |
| Flash URL the mail links to                                 | `render/week.ts`, `flashUrl(base, date, label)` → `<base>/flash/<isoWeek>/<date>?run=<label>`                                                                                                                                                                                                                                                                                                                                                                          |
| Cross-repo view fixture                                     | `plugins/option-wizard/contracts/brief-view-v2.fixture.json`, regenerated by `tests/brief-view-fixture.spec.ts` under `HELIUM_WRITE_FIXTURE=1`                                                                                                                                                                                                                                                                                                                         |
| argon watchlist API (read-only reference; never edit argon) | `/Users/chenxi/projects/argon/src/uw_scan/api/routers/watchlist.py` — `GET /watchlist/chains` → `{chains:[{layer, layer_name, focus, chain, count}]}`; `GET /watchlist?chain=<name>` → `{scanned_at_min, scanned_at_max, scheduler_lag_seconds, queue, hot_count, hot_max, tickers:[{ticker, sector, chains[], pinned, hot, sort_rank, spot, spot_quoted_at, iv_rank, …}]}`. Chain names verified present in `uw_scan/watchlist_taxonomy.py` for all ten spec entries. |

### Feeds verified in `tools/index.ts` before this plan was written — and what was NOT

Read 2026-09-06; each tool's own verification comment is the source.

| §G.2 asks for                     | Verified tool + kept fields                                                                                                                                                                                                                                                                                                                      | Usable                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| earnings                          | `ow_uw_earnings` → `{asOf, rows:[{ticker, nextEarningsDate, daysToEarnings, reportTime?}` or `{ticker, issueType, nextEarningsDate:null}], missing:[{ticker,reason}]}`; `reportTime` is UW's `announce_time`, omitted when it is `"unknown"`                                                                                                     | **yes**                                                                           |
| macro on the tape                 | `ow_uw_calendar` → `{asOf, rows:[{time (ISO Z), type, event, forecast\|null, prev\|null}]}`, client-side 7-day window from the as-of instant                                                                                                                                                                                                     | **yes**                                                                           |
| FOMC dates / blackout             | `ow_argon_policy_path` → rows with `meeting_date`, `payload.{label,stance,probability,target_range,probabilities}`, `snapshot_date`                                                                                                                                                                                                              | **yes**                                                                           |
| IV / flow anomaly                 | `ow_uw_iv_term` → `{rows:[{ticker, date, expiry, dte, volatility, implied_move_perc}]}`, 0-DTE dropped, **at most 3 tickers per call**; argon watchlist rows carry `iv_rank`                                                                                                                                                                     | **partly — `iv_rank ≥ 80` alone, Task 7**                                         |
| ATM implied move (§G.5)           | `ow_uw_iv_term` keeps **`implied_move_perc`** and **drops the absolute `implied_move`**                                                                                                                                                                                                                                                          | **yes, in percent**                                                               |
| realized move                     | `ow_apex_bars` → `{bars:[{time, open, high, low, close, volume}]}` (`eval/bars.ts` `Bar`); `apexBarSource` already serves the settler                                                                                                                                                                                                            | **yes**                                                                           |
| split                             | **massive.com (ex-Polygon)** `GET /stocks/v1/splits` — `execution_date.gte/lte`; fields `ticker, execution_date, split_from, split_to, adjustment_type, status`. "Included in all Stocks plans", updated daily. argon already uses this provider (`uw_scan/config.py`: `MASSIVE_API_KEY`, `MASSIVE_BASE_URL`, default `https://api.massive.com`) | **yes, via Task 6 — response shape read from the docs, NOT yet from a live call** |
| ex-dividend (§I.1)                | **massive.com** `GET /stocks/v1/dividends` — `ex_dividend_date.gte/lte`; fields `ticker, declaration_date, ex_dividend_date, pay_date, record_date, cash_amount, status`. The docs' sample carries a FUTURE ex-date, so forward rows are served                                                                                                  | **yes, via Task 6 — same caveat**                                                 |
| index add/remove, rebalance, spin | **nothing.** `ow_uw_calendar` is the US _economic_ calendar; `ow_uw_earnings` is a per-ticker `/info` read; Massive covers splits and dividends only. UW's `get_market_events` was **not** verified against a live response by this plan                                                                                                         | **no — operator-dated `focus.calendarPins` only, Task 1 `it.skip` gate**          |
| lockup expiry / secondary (§I.2)  | nothing                                                                                                                                                                                                                                                                                                                                          | **no — same gate**                                                                |
| seasonality (§I.5)                | nothing in this tenant; UW's `get_market_seasonality` is not a helium tool                                                                                                                                                                                                                                                                       | **deferred to the `ow_base_rate` follow-up**                                      |

> **`ow_price_structure` is not a price-history tool.** §G.5's fallback names it, but it is expiry payoff arithmetic over legs and their NBBO mids (`net`, `maxGain`, `maxLoss`, `breakevens`, `exit`) and holds no price series at all. The realized-move fallback in Task 13 uses **`ow_apex_bars`** and says so in the commitment payload. Recorded here rather than silently substituted.

**Consequence, and it is a design rule for Tasks 1, 6, 7 and 13:** an event row is admitted only from `ow_uw_earnings`, `ow_uw_calendar`, `ow_argon_policy_path`, `ow_uw_iv_term`, `ow_argon_watchlist`, **`ow_massive_actions`**, the ledger, or an operator-dated pin in `tenant.yaml`. Splits and ex-dividends come from Massive (Task 6); index add/remove, rebalance and spin-offs remain a `TODO-verified-shape` gate and enter only as an operator-dated `focus.calendarPins` row — a skipped test naming what is missing, never an invented endpoint. **Massive's own response shape is transcribed from its documentation and has not yet been observed live**, so the tool ships with an `it.skip` that says exactly that and the inline shape comment is written from the first live call, not before.

### Verified real values available for fixtures

From `$S/pit/weekend-2026-09-06/reports/option-wizard-2026-09-03-close.md` (the `edit` step's JSON, as-of 2026-09-03 close): 2Y 4.34% (−3.1bp), 10Y 4.772% (−0.8bp), 30Y 5.253% (−0.7bp), 2s10s 43.2bp; 9/16 FOMC 60% hike to 3.75–4.00% (Frenzy Capital snapshot 2026-09-02); gold +1.89% to 4,471.34 (`asOf 2026-09-03T20:15:31Z`), silver +2.48% to 66.95, copper +1.18%; DXY 98.977 (−0.599); DFII10 2.44% (FRED, asOf 2026-09-01); SPY +8.01 to 773.17, QQQ +8.43 to 717.67, IWM +1.18 to 295.19, VIX 14.32 (−0.87); market-tide net call premium ≈ +$466M (date 2026-09-03); SPY spot 772.66, gamma flip 778.08, magnet 773, call wall 773, put wall 772; QQQ spot 717.11, flip 716.38, magnet 717, call wall 719, put wall 716 (`as of 2026-09-03T20:14:56Z`); SLV close 60.55; candidate id `SPY-2026-09-03-2`. From `option-wizard-2026-09-04-close.md`: SPY 770.19 (−0.39%) — the `referenceClose` the spec's worked skeleton cites, and the second close of the −0.3854% two-day move Tasks 2, 9 and 13 assert against.

---

## File structure

**Create**

- `plugins/option-wizard/quality/review-config.ts` — parses and refuses the `extensions.review` block.
- `plugins/option-wizard/quality/channels.ts` — pure. Tool payloads → `Channel[]` (the ranking) **and** `CoverageRow[]` (the fixed macro + sector + theme list).
- `plugins/option-wizard/quality/themes.ts` — pure. `basketExcess`, `themeRow`, `rotationTable`.
- `plugins/option-wizard/quality/history.ts` — medians from the audit table, `medianSource`, opened and closed per call.
- `plugins/option-wizard/quality/select.ts` — pure. Rank, mode, streak, the supplied _why_ phrase.
- `plugins/option-wizard/quality/focus.ts` — pure. Event extraction, decay, score, stickiness, the daily 5, `FOCUS_BANNED_PATTERNS`.
- `plugins/option-wizard/quality/frame.ts` — assembles the single `SessionFrame` payload and re-parses it out of `report.toolOutputs`.
- `plugins/option-wizard/state/checks.ts` — the prior open session's record; scores yesterday's three checks.
- `plugins/option-wizard/render/review.ts` — sections 1/3/5/6/7, the citation lines, the verdict and focus commitments, the review metric rows.
- `plugins/option-wizard/render/one-thing.ts` — the One Thing document: schema, trim, section, channel metric rows.
- `plugins/option-wizard/eval/verdict.ts` — the verdict settler and the focus settler.
- `plugins/option-wizard/tests/` — `quality-review-config.spec.ts`, `quality-channels.spec.ts`, `quality-coverage.spec.ts`, `quality-themes.spec.ts`, `quality-select.spec.ts`, `quality-focus.spec.ts`, `quality-frame.spec.ts`, `state-checks.spec.ts`, `render-review.spec.ts`, `render-one-thing.spec.ts`, `tools-argon-watchlist.spec.ts`, `tools-massive-actions.spec.ts`, `tools-session-frame.spec.ts`, `tools-rotation.spec.ts`, `eval-verdict.spec.ts`, `eval-focus.spec.ts`.
- `plugins/option-wizard/tests/fixtures/review/` — recorded payloads + `README.md` with sha256/bytes/provenance.
- `docs/superpowers/specs/2026-09-06-review-framework.md`, `…/2026-09-06-one-thing-brief.md`, `…/2026-09-06-brief-craft.md`, `docs/superpowers/plans/2026-09-06-review-framework.plan.md`.
- `docs/evidence/pit-replays/2026-09-06/README.md` + `review-v1/`.

**Modify**

- `plugins/option-wizard/tenant.yaml` — `extensions.review` gains `coverage`, `sectors`, `verdicts`, `caps`, `focus`, `themes`, `rotation`; `env` gains the two NAMES `ow_massive_actions` needs (`MASSIVE_API_KEY`, `MASSIVE_BASE_URL`) — `OW_ARGON_API_BASE` is already declared.
- `plugins/option-wizard/team.yaml` — role `frame-clerk` + tasks `frame` and `rotation`; personas `regime-analyst`, `editor`, `weekly-analyst`, `week-reviewer`, `scenario-analyst`, `universe-builder`, `risk-reviewer`; prompts `universe`, `gex`, `edit`, `weekly`, `week-review`, `scenarios`.
- `plugins/option-wizard/tools/index.ts` — `ow_argon_watchlist`, `ow_session_frame`, `ow_rotation`, their `VOCABULARY` entries, the `parseReviewConfig` call at the top of `buildTools`, `ow_review_window` (defect fix + counters).
- `plugins/option-wizard/eval/settle.ts` — `else if` branches dispatching `"coverage-verdict"`, `"scenario-base-case"` and `"focus-admit"`; `buildSettler` passes `cfg.stateRoot`; `hashBars` exported.
- `plugins/option-wizard/render/index.ts`, `render/budget.ts`, `render/ledger.ts`, `quality/index.ts`, `state/regime.ts`, `gates/regime-state.ts`, `gates/flash-budget.ts`.
- Existing tests: `render.spec.ts`, `render-editor.spec.ts`, `render-flash-budget.spec.ts`, `render-schema-version.spec.ts`, `brief-view-fixture.spec.ts`, `gate-regime-state.spec.ts`, `gate-flash-budget.spec.ts`, `state-regime.spec.ts`, `quality-metrics.spec.ts`, `team-manifest.spec.ts`, `tools-review-window.spec.ts`, `eval-settle.spec.ts`.

**Delete** — nothing. Two personas lose paragraphs; no file becomes dead.

**Not in this PR** — the delivered email. `renderHtml`'s body is deliberately abridged (tape strip, `oneSentence`, `bottomLine`, `candidateRows`, `flashLink`) and renders **no** `view.sections` at all; putting seven review sections into a mail a human reads on a phone is a separate product decision. It is in the follow-up list, not in a task.

---

## Task 0: Land the spec, the merged design, and this plan

**Files:** create the four documents above.

- [ ] **Step 1: Worktree**

```bash
cd /Users/chenxi/projects/helium
git fetch origin
git worktree add .worktrees/review-framework -b feat/review-framework origin/master
cd .worktrees/review-framework && git log --oneline -1   # expect 35db17e
```

- [ ] **Step 2: Copy the documents in**

```bash
S=/private/tmp/claude-501/-Users-chenxi-projects-helium/04ed705b-a291-45d0-ac8f-dd2433903e9f/scratchpad/research
cp "$S/2026-09-06-review-framework.md"        docs/superpowers/specs/2026-09-06-review-framework.md
cp "$S/2026-09-06-one-thing-brief-design.md"  docs/superpowers/specs/2026-09-06-one-thing-brief.md
cp "$S/2026-09-06-brief-craft.md"             docs/superpowers/specs/2026-09-06-brief-craft.md
cp "$S/2026-09-06-review-framework.v2.plan.md" docs/superpowers/plans/2026-09-06-review-framework.plan.md
```

- [ ] **Step 3: Replace the One Thing spec's "Open questions" section with the binding resolutions**

```markdown
## Open questions — RESOLVED 2026-09-06 (binding)

1. **Divergence pairs (channel 7): dropped from V0 entirely.** `min(score_a, score_b)`
   over an unstored sign convention is a number nobody can check (doctrine 6).
2. **Mixed-source day-one ratio: accepted, and labelled.** `channel.<id>.medianSource`
   (0 = daily series, 1 = accumulated metric rows) records which denominator was used.
3. **Checks persistence: inside the EXISTING `regime-state` record.** One extra `checks`
   key and one `invalidation` key. No second state file, no plural `stateBlocks`, no core
   edit, no filesystem write in the renderer. Consequence: the fence's AUTHOR moves from
   `regime-analyst` to `editor` — `liftState` runs on every step and a later fence
   overwrites an earlier one, so exactly one step may emit it.
4. **The tool is named `ow_session_frame`, not `ow_one_thing`** — it now also carries the
   fixed coverage rows, the focus list and the ledger rows the review sections are printed from.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/
git commit -m "docs(option-wizard): land the review-framework spec, the one-thing design and the merged plan"
```

**Check:** `git show --stat HEAD` lists exactly four files.
**Ablation:** removed Task 0 and worked from the scratchpad copies: the reviewer then reviews code with no reviewable statement of intent in the repo, and the next agent has no spec to read by absolute path. **Kept.**
**Doctrine:** 6 (the plan is the artifact a reviewer can reject before code exists).

---

## Task 1: The whole `extensions.review` declaration, and the loader that refuses a bad one

**Files:** modify `plugins/option-wizard/tenant.yaml`, `tools/index.ts` (`buildTools` calls the loader); create `plugins/option-wizard/quality/review-config.ts`, `tests/quality-review-config.spec.ts`.

**`tenant.yaml`** — beside the existing `windows`, the complete block (spec C.2 + §G.3 + §H.1 + §H.4 + §J.4). This is the whole declarative surface; no later task adds a key to it.

```yaml
extensions:
  review:
    windows: [5, 10, 21]
    coverage: # ORDER IS THE PRINT ORDER. Rows are never dropped.
      - rates.front # 2Y level + bp change
      - rates.long # 10Y / 30Y level + bp change
      - curve.shape # steepen / flatten, bull or bear
      - policy.path # dated meeting, hike/cut odds
      - credit # HY OAS
      - vol # VIX + term structure
      - dealer.positioning # call wall / put wall / zero gamma
      - flow # ETF tide, sector tide
      - commodities # gold, crude
      - fx # DXY
      - equity.internals # index %, sector leaders/laggards
      - calls.open # our published candidates and forecasts still pending —
        # NEVER real positions/size/PnL. The /flash page is public;
        # 仓位 is a separate, private project.
    # Each entry is an argon watchlist chain name, VERBATIM from
    # `GET /watchlist/chains` (uw_scan/watchlist_taxonomy.py is the source of
    # truth). Members come from `GET /watchlist?chain=<name>` via
    # OW_ARGON_API_BASE. One coverage row per entry, same verdict token, same
    # <=15-word clause. Members and weekly % are renderer-filled, never recalled.
    sectors:
      - Computer/GPU
      - Semi-Logic/ASIC
      - Foundry
      - Semi-Cap/EDA
      - Memory/Storage
      - Cybersecurity
      - Software/SaaS
      - Cloud/Hyperscaler
      - Foundation-Model-Proxy
      - Devices/Endpoint
    verdicts: [continue, reverse, strengthen, fade, untested]
    # `weeklyModelWords`/`dailyModelWords` are the totals spec C.6/§J cap; the
    # per-section numbers are what render/budget.ts trims to.
    caps:
      weeklyModelWords: 900
      dailyModelWords: 300
      reviewWords: 300
      weekly:
        {
          review: 300,
          outlook: 400,
          catalysts: 150,
          rowWords: 15,
          focusWords: 20,
          themeWords: 25,
        }
      daily:
        {
          review: 120,
          outlook: 180,
          catalysts: 60,
          rowWords: 10,
          focusWords: 20,
          themeWords: 25,
        }
    # §G. The list is COMPUTED, never chosen: these weights and windows are
    # the whole methodology, and they live here so helium-self can diff them
    # and so a re-weight is a reviewable PR rather than a prompt edit. They
    # are a DECLARED PRIOR (2026-09-06), not fitted — §I.6 re-weights them
    # from focusHitRate after ~8 weeks, and the renderer prints
    # "weights: declared prior 2026-09-06" under the focus table until it does.
    focus:
      weekly: 15
      daily: 5
      # Points. An event ON the day earns the full weight and decays in a
      # straight line to zero at its window's end; an event already past
      # earns nothing (it happened — 关注 is about what is ahead).
      weights:
        earnings: 10
        corporate: 8
        macroNamed: 4
        openCall: 6
        theme: 3
        flowAnomaly: 3
        pinned: 2
        # §I.1 assignment risk: an ex-dividend date INSIDE an open call's
        # window, from ow_massive_actions. Weighted just under `openCall`
        # because it only ever fires on a name we already have a commitment
        # on — it sharpens an existing admission rather than creating one.
        # Declared prior, like every weight here.
        assignmentRisk: 6
      # OPEN sessions, counted with the `calendar` block above.
      windows:
        {
          earnings: 7,
          corporate: 10,
          macroNamed: 5,
          openCall: 10,
          assignmentRisk: 5,
        }
      # score DESC, then nearest event ASC, then ticker A-Z. Alphabetical
      # last so a tie is stable across runs — that is what makes the 15
      # replayable.
      tieBreak: [score, daysToNearestEvent, ticker]
      # ow_uw_earnings is one HTTP round trip PER TICKER. The universe is the
      # argon chains plus the TV flag lists and can exceed 80 names, so the
      # lookup is capped and the truncation is REPORTED (pinned first, then
      # alphabetical, so which 60 is deterministic).
      maxEarningsLookups: 60
      # ow_uw_iv_term takes at most 3 tickers per call: 15 names = 5 calls.
      maxIvTermCalls: 5
      # Operator-dated events with no machine feed: §I.3 index rebalances,
      # index add/remove, spin-offs, §I.4 product days. Splits and
      # ex-dividends do NOT belong here — ow_massive_actions serves them
      # (Task 6). Hand-kept, dated, PR-reviewed; `ticker: MARKET` makes it a macroNamed
      # event for every universe member. Empty is fine.
      calendarPins: []
      #  - { ticker: MARKET, day: 2026-09-18, kind: corporate,
      #      label: "S&P quarterly rebalance effective" }
    # §H. A theme lands ONLY with a pollable evidence line, a horizon and a
    # kill condition. No kill, no theme — the loader refuses it and the tenant
    # is skipped with the reason, which is the only way a register stays a
    # register instead of a mood.
    themes:
      - id: el-nino-ag-2026
        thesis: "El Nino 2026 tightens soft/grain supply; medium-term bid for ag inputs and grain"
        horizon: 6m
        entered: 2026-09-06
        instruments: [DBA, MOS, NTR, DE] # what we watch, not what we hold
        evidence:
          - text: "NOAA ONI monthly >= +0.5 for 3 consecutive months"
            # No tool serves NOAA. `tool:` is optional and its absence prints
            # `evidence: operator-checked` on the row — honest, and it does
            # not block the verdict, which settles on the excess-move number.
          - text: "CBOT corn/wheat front-month vs 20d"
        kill: "ONI < +0.5 two months running, or instruments underperform SPY by 10% over 60 sessions"
        # The machine-checkable half of `kill`, so the renderer can print
        # CONDITION MET without reading English. Optional.
        killExcess: { pct: -10, sessions: 60 }
    # §H.4. The eleven Select Sector SPDRs plus the theme baskets, against
    # SPY. In yaml so an operator can correct the list without a code change;
    # Task 9 Step 1 confirms every symbol answers from ow_apex_bars, and one
    # that does not prints `untested` rather than being dropped.
    rotation:
      benchmark: SPY
      lookbacks: { w1: 5, w4: 20, w12: 60 } # OPEN sessions
      sectorEtfs: [XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY]
```

**Interfaces** (`quality/review-config.ts`, zod 4, no clock, no fs):

```typescript
export interface ThemeEvidence {
  text: string;
  tool?: string;
}
export interface ThemeSpec {
  id: string;
  thesis: string;
  horizon: string;
  entered: string;
  instruments: string[];
  evidence: ThemeEvidence[];
  kill: string;
  killExcess?: { pct: number; sessions: number };
}
export interface FocusConfig {
  weekly: number;
  daily: number;
  weights: Record<FocusKind, number>;
  windows: {
    earnings: number;
    corporate: number;
    macroNamed: number;
    openCall: number;
  };
  tieBreak: readonly ["score", "daysToNearestEvent", "ticker"];
  maxEarningsLookups: number;
  maxIvTermCalls: number;
  calendarPins: Array<{
    ticker: string;
    day: string;
    kind: FocusKind;
    label: string;
  }>;
}
export interface RotationConfig {
  benchmark: string;
  lookbacks: { w1: number; w4: number; w12: number };
  sectorEtfs: string[];
}
export interface Caps {
  review: number;
  outlook: number;
  catalysts: number;
  rowWords: number;
  focusWords: number;
  themeWords: number;
}
export interface ReviewConfig {
  windows: number[];
  coverage: string[];
  sectors: string[];
  verdicts: string[];
  caps: {
    weekly: Caps;
    daily: Caps;
    weeklyModelWords: number;
    dailyModelWords: number;
  };
  focus: FocusConfig;
  themes: ThemeSpec[];
  rotation: RotationConfig;
}

/** THROWS on a malformed block. `buildTools` calls it, so a bad declaration
 *  skips exactly this tenant with a recorded reason (AGENTS.md, Architecture:
 *  "a throwing tool module ... skips exactly that tenant with a recorded
 *  reason") — no core edit, no new validation seam. */
export function parseReviewConfig(extensions: unknown): ReviewConfig;

/** The row ids the coverage table prints for the register: `theme:<id>`, in
 *  declared order, appended after the sector rows. */
export function themeRowIds(themes: readonly ThemeSpec[]): string[];

/** The one place the row count is computed. Every test and every renderer
 *  asks HERE rather than writing a constant, so adding a theme is a yaml
 *  edit and nothing else. */
export function coverageRowCount(cfg: ReviewConfig): number;
//  cfg.coverage.length + cfg.sectors.length + cfg.themes.length
```

Refusal rules, each with its reason as a comment:

- A theme with no `kill`, an empty `kill`, or an empty `evidence` array is **refused** — balder's admission gate (§H.1). The message names the id and the missing field: `extensions.review.themes[0] el-nino-ag-2026: kill is required — a theme with no kill condition is not a theme`.
- A theme with no `horizon`, no `entered` (`yyyy-mm-dd`), or an empty `instruments` is refused for the same reason.
- Duplicate theme ids are refused (the row id would collide with itself).
- A theme id that is not `^[a-z0-9][a-z0-9-]{2,63}$` is refused — it becomes a coverage row id and a commitment id fragment.
- `focus.tieBreak` must be exactly `["score","daysToNearestEvent","ticker"]`. A configurable tie-break is a configurable answer; the field exists to be read, not to be varied.
- Every weight finite and `>= 0`; every window a positive integer; `weekly >= daily >= 1`.
- `calendarPins[].day` is `yyyy-mm-dd` and `kind` is one of the eight `FOCUS_KINDS`; the operator is an admitted source (`tenant.yaml`), and Task 7's `ADMITTED_EVENT_SOURCES` says so.
- **`themes` and `calendarPins` may be empty or absent**; `focus` and `rotation` default to nothing and the focus/rotation blocks then print `not declared` rather than being omitted. A tenant without a register still runs.

- [ ] **Step 1: Failing tests** (`tests/quality-review-config.spec.ts`), over the real block above loaded with the same yaml parser `team-manifest.spec.ts` uses:
  - the shipped block parses; `config.themes[0].instruments` is `["DBA","MOS","NTR","DE"]`; `themeRowIds(config.themes)` is `["theme:el-nino-ag-2026"]`; `coverageRowCount(config) === 23` **computed from the parsed block, asserted as `config.coverage.length + config.sectors.length + config.themes.length`**.
  - deleting `kill` throws with a message containing `el-nino-ag-2026: kill is required`; deleting `evidence` throws naming `evidence`; two themes with the same id throw naming `duplicate`.
  - `tieBreak: ["ticker","score","daysToNearestEvent"]` throws.
  - `themes: []` parses, `themeRowIds([])` is `[]`, and `coverageRowCount` is 22 — the register is optional and the count follows the declaration.
  - a `calendarPins` entry with `day: "2026-9-8"` throws (the format is the contract; a date a `localeCompare` sorts wrongly is worse than no pin).
  - `parseReviewConfig({})` throws naming `extensions.review`; **`buildTools` called with the broken extensions block throws**, and the message reaches the caller unchanged (that is what the host records as the skip reason).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Write `quality/review-config.ts`, and the TODO gates for the shapes that do not exist**, in `tests/quality-review-config.spec.ts`:

```typescript
// TODO-verified-shape. Unskip when a live response has been recorded.
it.skip("admits an index add/remove, rebalance or spin-off — BLOCKED: no source", () => {
  // §G.2 wants index add/remove, rebalance and spin rows. Read 2026-09-06:
  // ow_uw_calendar is the US ECONOMIC calendar (verified 2026-09-03,
  // GET /api/market/economic-calendar -> {data:[{type,time,event,forecast,
  // prev,reported_period}]}) and carries none of them; ow_uw_earnings is a
  // per-ticker /info read (next_earnings_date, announce_time) and carries
  // none either; massive.com's Stocks endpoints cover SPLITS and DIVIDENDS
  // only (Task 6). UW's get_market_events was NOT verified against a live
  // response by this plan, so no shape is written here rather than guessed
  // (AGENTS.md: a tool's comment records the live shape it was verified
  // against). Until then these three enter ONLY as an operator-dated
  // `focus.calendarPins` row.
});
it.skip("admits a lockup expiry or a secondary offering — BLOCKED: no source (§I.2)", () => {});
```

- [ ] **Step 4: Wire `buildTools`** — one call at the top of `buildTools(cfg)`: `const review = parseReviewConfig(cfg.extensions);`, its result passed to every tool that needs it (`ow_argon_watchlist`, `ow_massive_actions`, `ow_session_frame`, `ow_rotation` in Tasks 5, 6, 8, 9).
- [ ] **Step 5: Tenant still loads**

```bash
pnpm build && node -e "import('./packages/cli/lib/discovery.js').then(async (m) => {
  const r = await m.loadTenants('plugins');
  console.log(r.tenants.map(t=>t.spec.tenant), r.skipped);
  const ow = r.tenants.find(t=>t.spec.tenant==='option-wizard');
  console.log(JSON.stringify(ow.spec.extensions.review.sectors));
})"
```

Expect `option-wizard` present, `skipped` empty, and the ten chain names printed **exactly** as `tenant.yaml` spells them. Then run the same one-liner with `kill` deleted from the yaml: it must print `option-wizard` in `skipped` with the loader's message. Restore the yaml.

- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test`
- [ ] **Step 7: Commit** — `feat(option-wizard): declare the coverage list, the focus weights, the theme register and the rotation set, and refuse a theme with no kill condition`

**Ablation.** Removed the loader and let the tools read the raw block: the theme-with-no-kill case then reaches the renderer, which prints a row whose verdict can never be settled — the register degrades into the mood §H.1 exists to prevent. **Kept.** Removed the separate `rotation` block and derived the ETF list in code: a tenant then cannot correct a delisted symbol without a code change, which is the coupling doctrine 2 forbids. **Kept.** Removed `killExcess`: the renderer can still print `kill armed: <text>` and the operator still reads it, so only the automatic `CONDITION MET` line is lost — **kept anyway**, because it is four numbers of yaml against the one thing that makes a kill condition act. Removed `coverageRowCount` and wrote `22` in the tests: adding a theme then edits four test files, which is the coupling the count exists to avoid. **Kept.**

**Doctrine:** 2 (a declaration inside the opaque `extensions:` block the host never opens), 3 (the refusal rides the existing tenant-skip seam, no core edit), 6 (no new gate — the loader that already had to exist does the refusing).

---

## Task 2: `quality/channels.ts` + `quality/themes.ts` — one extraction, three consumers (ranking, coverage rows, theme baskets)

**Files:** create `plugins/option-wizard/quality/channels.ts`, `quality/themes.ts`, `tests/quality-channels.spec.ts`, `tests/quality-coverage.spec.ts`, `tests/quality-themes.spec.ts`, `tests/fixtures/review/*.json` + `README.md`.

**Interfaces — `quality/channels.ts`**

```typescript
export type ChannelId =
  "rates" | "curve" | "policy" | "credit" | "vol" | "dealer" | "flow" | "event";

export interface Channel {
  id: ChannelId;
  /** Tie-break order; the `#` column of the one-thing channel table. */
  order: number;
  /** A series a reader can look up: "DGS10", "VIXCLS", "BAMLH0A0HYM2",
   *  "9/16 hike probability", "SPY gamma flip", "market tide net premium". */
  series: string;
  /** Today's level VERBATIM as the source wrote it — a string, never a number.
   *  ow_uw_gex returns every level as a string on purpose: Number("764.77")
   *  round-trips to 764.7699999 in a trading email. */
  level?: string;
  prior?: string;
  /** The move, formatted once, here, with its unit: "-1.14 pts", "+4.0 bp". */
  move?: string;
  /** Signed magnitude for scoring and for verdict classification. Undefined =
   *  EXCLUDED: never the one thing, never in prose, metric row `null`. */
  delta?: number;
  magnitude?: number;
  signFlip?: boolean;
  /** The source's own as-of string, copied. */
  asOf?: string;
  excluded?: string;
}

/** The declared row ids of `extensions.review.coverage`. A sector row's id is
 *  `sector:<chain>` — the chain name VERBATIM from argon's rail. A theme row's
 *  is `theme:<id>` — the id VERBATIM from the register. */
export type CoverageRowId = string;

export interface CoverageRow {
  id: CoverageRowId;
  /** Print order = declared order. Never sorted, never dropped. */
  order: number;
  /** What settles it, in one string a later run can look up. */
  series: string;
  level?: string;
  prior?: string;
  move?: string;
  delta?: number;
  asOf?: string;
  /** Renderer-filled extra for a sector row: the chain's members, from argon. */
  members?: string[];
  /** Theme rows only: the §H.2 triple and the kill state, from quality/themes.ts. */
  theme?: {
    week: BasketExcess | null;
    sinceEntered: BasketExcess | null;
    kill: { armed: string; met: boolean; why?: string };
    evidence: string[];
  };
  /** Set iff the datum is absent. The row still prints, as `untested`. */
  untested?: string;
}

export interface ChannelInputs {
  macro?: unknown; // ow_macro_rates
  policy?: unknown; // ow_argon_policy_path
  gex?: unknown; // ow_uw_gex
  spot?: unknown; // ow_spot
  tide?: unknown; // ow_uw_market_state
  calendar?: unknown; // ow_uw_calendar
  commodities?: unknown; // ow_tv_commodities
  watchlist?: unknown; // ow_argon_watchlist
  bars?: unknown; // ow_uw_ticker_metrics / ow_apex_bars, for sector weekly %
  /** Daily bars by symbol, for the theme baskets. Empty map = every theme row
   *  is `untested`, which is a printed row, not a missing one. */
  themeBars?: ReadonlyMap<string, readonly Bar[]>;
  /** Open commitment count, for the `calls.open` row. Supplied, not fetched. */
  openCalls?: number;
  /** Prior stored metric values by metric name, for channels whose d1 lives in
   *  the audit table rather than in their own payload. */
  priorMetrics?: Record<string, number | null>;
  day: string;
  /** The first day of the coverage period, for the theme week window. */
  weekFrom?: string;
}

export function extractChannels(inputs: ChannelInputs): Channel[];

/** The declared coverage list, in declared order, ALWAYS complete.
 *  `declared` comes straight from `parseReviewConfig`; a row the payloads
 *  cannot answer carries `untested` and still prints. The returned length is
 *  ALWAYS `coverage.length + sectors.length + themes.length`. */
export function coverageRows(
  inputs: ChannelInputs,
  declared: {
    coverage: string[];
    sectors: string[];
    themes: readonly ThemeSpec[];
  },
): CoverageRow[];

/** The ≤20-observation history a channel can supply from its OWN payload,
 *  newest first. Empty when the payload carries no series for it. */
export function seriesHistory(inputs: ChannelInputs, id: ChannelId): number[];
```

**Extraction rules — write these as code comments; they are the contract.**

| row id               | source → field                                                                                                           | unit      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| `rates.front`        | `macro.liveNow` 2Y, else `macro.series.rows` newest `DGS2`; absent in argon's mirror → `untested (DGS2 not ingested)`    | bp        |
| `rates.long`         | `liveNow` 10Y / 30Y, else newest `DGS10`                                                                                 | bp        |
| `curve.shape`        | `liveNow.spreads["2s10s"]`, else `DGS10 − DGS2` when both exist                                                          | bp        |
| `policy.path`        | `policy.meetings[0].payload.probability` with `label` + `stance`                                                         | pp        |
| `credit`             | `macro.fredDirect.points[BAMLH0A0HYM2]`, else newest `series.rows`                                                       | bp        |
| `vol`                | `liveNow` VIX, else newest `VIXCLS`                                                                                      | pts       |
| `dealer.positioning` | `gex.levels[0]` `gammaFlip`/`callWall`/`putWall` vs `spot.quotes[]`                                                      | pts       |
| `flow`               | last `tide.marketTide.data[]` print, `net_call_premium − net_put_premium`                                                | USD       |
| `commodities`        | `commodities` gold + crude rows, level and `changePct` copied                                                            | %         |
| `fx`                 | `commodities`/`macro` DXY level and change                                                                               | index pts |
| `equity.internals`   | `spot.quotes[]` for the index set; leaders/laggards are the copied `changePct` strings, ranked in code                   | %         |
| `calls.open`         | `inputs.openCalls` — the count of outstanding commitments. **Published candidates and forecasts only; never a holding.** | count     |
| `sector:<chain>`     | `watchlist` members for the chain × `bars` weekly % per member, mean formatted in code                                   | %         |
| `theme:<id>`         | `themeRow(theme, inputs.themeBars, day, weekFrom)` — the §H.2 excess-move triple                                         | %         |

Hard rules, each with its reason as a comment:

- **A level is carried as a STRING, verbatim, beside its parsed number.** Two fields, never one.
- **`{unavailable: "as-of"}` is an exclusion, not an error** — recognise it by the key.
- **`liveNow` before `series`**: argon's daily mirror runs ~9 days behind (measured 2026-09-02); a live level under a past date is the most dangerous number here.
- **A missing datum is `untested`, never a dropped row.** `untested` is the mechanism that makes "terse, never dropped" enforceable (spec C.2).
- **A chain name absent from argon's rail prints `untested (chain unknown)`** and counts as a coverage gap — same mechanism as a macro row (spec §E).
- **A theme whose basket cannot be computed prints `untested: "no bars for 3 of 4 instruments"`** and still occupies its row.
- **No clock, no randomness, no `node:fs`, no `@helium/core` runtime import** — types only. `day` is passed in.
- One numeric helper returns `undefined` on a non-finite result, so a `"."` FRED row can never become `NaN` in a metric.

**Interfaces — `quality/themes.ts`** (pure; `rotationTable` lands in Task 9, in this same file)

```typescript
export interface BasketExcess {
  basketPct: number;
  benchPct: number;
  excessPct: number;
  used: string[];
  missing: string[];
}

/** Equal weight means the MEAN OF RETURNS, not the return of a price sum — a
 *  $600 name would otherwise be the basket. A member with no bars is EXCLUDED
 *  and named in `missing`; the row says "3 of 4" rather than quietly averaging
 *  what it has. Returns null (never 0) when nothing is computable. */
export function basketExcess(args: {
  members: readonly string[];
  benchmark: string;
  bars: ReadonlyMap<string, readonly Bar[]>;
  fromDay: string;
  toDay: string;
}): BasketExcess | null;

/** §H.2's triple, both horizons: the week, and since `entered`. The kill line
 *  is armed text plus, when `killExcess` is declared AND computable, whether
 *  the condition is met. The renderer NEVER edits the yaml — §H.3's rule is
 *  that the operator promotes and demotes, in a dated, reviewed PR. */
export function themeRow(
  theme: ThemeSpec,
  bars: ReadonlyMap<string, readonly Bar[]>,
  day: string,
  w1From: string,
): {
  rowId: string;
  week: BasketExcess | null;
  sinceEntered: BasketExcess | null;
  kill: { armed: string; met: boolean; why?: string };
};
```

The theme coverage row is a **print** (Addendum C1): `series: "DBA,MOS,NTR,DE equal-weight vs SPY, excess %"`, `level: "+1.7"`, `prior: "+3.2"`, `move: "+1.7% (1w) · +3.2% (since 2026-09-06)"`. The verdict token the model puts on it is the only forecast on the row, and it **reuses Task 12's `coverage-verdict` commitment kind** with `rowId: "theme:<id>"`, `unit: "%"` — no new kind, so Task 13's `classify`/`VERDICT_BANDS` and the whole settler path apply unchanged. That reuse is why the theme register costs a settler exactly nothing.

- [ ] **Step 1: Extract the fixtures and record their provenance**

Extract from the recorded tool-io of the 2026-09-03 close as-of replay (`$S/pit/fix-v1/runs/run-a6c307ef-5879-4f13-b241-088ba743fedd/tool-io/`, gzipped `{tool,args,at,raw,rawSha256,rawBytes,context}`) into `tests/fixtures/review/`: `macro-2026-09-03-close.json`, `policy-2026-09-03-close.json`, `gex-2026-09-03-close.json`, `tide-2026-09-03-close.json`, `spot-2026-09-03-close.json`, `commodities-2026-09-03-close.json`. Write `tests/fixtures/review/README.md` with one line per file: name, `rawSha256`, `rawBytes`, and the sentence "extracted from the 2026-09-03 close as-of replay, run-a6c307ef, on 2026-09-06". Hand-write `watchlist-chains.json` and `watchlist-Computer-GPU.json` **only** if the live argon is unreachable, and say so in the README; otherwise record them from a real `GET` in Task 5 and backfill here.

- [ ] **Step 2: Write the failing tests**

`tests/quality-channels.spec.ts` (values are the recorded ones; do not round):

- `vol` → `series: "VIXCLS"`, `level: "15.2"`, `prior: "16.34"`, `move: "-1.14 pts"`, `magnitude: 1.14`.
- `rates` → `level: "4.79"`, `prior: "4.79"`, `move: "+0.0 bp"`, `magnitude: 0` — **a zero move is a real move and must not be excluded.**
- `credit` → `level: "2.66"`, `prior: "2.65"`, `move: "+1.0 bp"`, taken from `series.rows` because `fredDirect.points` is `[]` in this recording (every series `"fetch failed"`; the laptop cannot reach the FRED CDN).
- `curve` excluded with a reason naming `DGS2`; `dealer` excluded with a reason containing `as-of`.
- `policy` with `priorMetrics: {}` excluded (`"no prior observation"`); with `{"channel.policy.prob_pp": 55}` → `move: "+5.0 pp"`.
- `seriesHistory(inputs, "vol")` returns 22 numbers, newest first, starting `15.2, 16.34`.
- `extractChannels({day})` on empty input returns eight rows, all excluded, and never throws.
- The array is sorted by `order`; there is no `divergence` id.

`tests/quality-coverage.spec.ts`:

- `coverageRows` with the parsed Task 1 declaration returns **exactly `coverage.length + sectors.length + themes.length` rows in declared order** (23 with the shipped block) — ids `rates.front … calls.open`, then `sector:Computer/GPU … sector:Devices/Endpoint`, then `theme:el-nino-ag-2026` last. **Compute the expected length from the declaration; never write 22 or 23.**
- With every payload absent, all rows return with `untested` set and none missing — assert the length explicitly against the same expression.
- With `themes: []` the length is `coverage.length + sectors.length` and no `theme:` id appears.
- `sector:Cybersecurity` with a chains payload that omits `Cybersecurity` → `untested` containing `chain unknown`.
- A theme whose instruments have no bars → `untested` and the row still occupies its position.
- `calls.open` with `openCalls: 4` → `level: "4"`, `series: "open commitments"`, and its text contains no ticker (privacy: the count is the datum).
- `equity.internals` from the recorded spot payload → the copied `+8.01`/`773.17` strings for SPY, no recomputation.

`tests/quality-themes.spec.ts`:

- `basketExcess` over recorded SPY closes (773.17 on 2026-09-03 → 770.19 on 2026-09-04, both in the fixture README) and a two-member basket returns the mean of the two members' returns, the benchmark's −0.3854%, and their difference.
- a member with no bars lands in `missing` and does not move the mean; an empty basket returns `null`, never `0`.
- `themeRow` with a declared `killExcess` that is met returns `kill.met === true` with a `why` naming the excess and the session count; with `killExcess` absent it returns `kill.met === false` and only the armed text.

- [ ] **Step 3: Run and watch them fail** — `Cannot find module '../quality/channels.js'`.
- [ ] **Step 4: Write `quality/channels.ts` and `quality/themes.ts`.**
- [ ] **Step 5: Run all three specs — PASS.**
- [ ] **Step 6: Commit**

```bash
git add plugins/option-wizard/quality/channels.ts plugins/option-wizard/quality/themes.ts \
        plugins/option-wizard/tests/quality-channels.spec.ts \
        plugins/option-wizard/tests/quality-coverage.spec.ts \
        plugins/option-wizard/tests/quality-themes.spec.ts \
        plugins/option-wizard/tests/fixtures/review/
git commit -m "feat(option-wizard): extract the ranked channels and the fixed coverage rows, themes included, from one payload set"
```

**Check:** `pnpm vitest run --project unit plugins/option-wizard/tests/quality-channels.spec.ts plugins/option-wizard/tests/quality-coverage.spec.ts plugins/option-wizard/tests/quality-themes.spec.ts`

**Ablation.** Removed `coverageRows` and let the renderer build rows from whatever the payloads answered: a quiet week then prints fewer rows and nobody notices, which is the exact failure §C.2 exists to prevent. **Kept.** Removed the theme-specific `CoverageRow.theme` block and printed only `level`/`move`: the kill state and the evidence line then have nowhere to live, and §H.2's "kill-distance" column disappears. **Kept.**

**Doctrine:** 2 (all of it in the tenant), 4 (extraction is code, not prose).

---

## Task 3: `quality/history.ts` + `quality/select.ts` — median, score, rank, mode

**Files:** create both modules and `tests/quality-select.spec.ts`.

**Interfaces**

```typescript
// history.ts — the ONLY module here that touches the audit store.
export interface ChannelHistory {
  moves: number[];
  medianSource: 0 | 1;
}
export const MIN_HISTORY = 20;
export function channelHistory(args: {
  channels: Channel[];
  inputs: ChannelInputs;
  days: string[];
  env?: NodeJS.ProcessEnv;
}): { history: Map<ChannelId, ChannelHistory>; note?: string };

// select.ts — pure.
export type SelectMode = "ratio" | "persistence" | "invalidation" | "no-data";
export interface Ranked {
  channel: Channel;
  score: number | null;
  medianSource: 0 | 1 | null;
}
export interface Selection {
  mode: SelectMode;
  ranked: Ranked[];
  /** The phrase the model is HANDED and must copy, e.g.
   *  "largest normalised move of the session, 3.3x its 20-session median". */
  why: string;
  streak?: number;
  breach?: {
    series: string;
    threshold: string;
    horizon: string;
    level: string;
  };
}
export function select(args: {
  channels: Channel[];
  history: Map<ChannelId, ChannelHistory>;
  standing?: { series: string; threshold: string; horizon: string };
  trail?: Array<{ day: string; values: Record<string, number | null> }>;
}): Selection;
export const RATIO_THRESHOLD = 2.0;
export const EVENT_SCORE = 2.0;
```

**Algorithm, each branch commented with its reason:** excluded channels are dropped before scoring; a breached standing invalidation wins outright (`invalidation`, no score — a view with a price that kills it is the only claim already paid for); otherwise `score = magnitude / median(moves)`; fewer than `MIN_HISTORY` points scores only on a sign flip or a dated event landing today (`EVENT_SCORE`), else `null` and ranks last; rank by score descending, ties by `channel.order` ascending, `null` after every number; top ≥ 2.0 → `ratio`, below → `persistence` with a streak walked out of `trail`; all excluded → `no-data`. **A median of an empty array is `undefined`, not 0** — a zero denominator makes a missing history look like the biggest move of the year.

- [ ] **Step 1: Failing tests** — vol `magnitude 1.14` against a median `0.35` scores `3.257…` and `why` reads `largest normalised move of the session, 3.3x its 20-session median` (one decimal, formatted here so the model only ever copies it); ties break by order (`rates` before `credit` at 2.5); short history and no flip → `null`, ranked last, mode still produced; top `1.4` → `persistence` with a streak; all excluded → `no-data`, `ranked: []`, `why: ""`; a breached standing invalidation wins even against a higher score; `channelHistory` over `new AuditStore(":memory:")` with 20 `channel.vol.dvix_pt` rows → `medianSource: 1`, with 0 rows and a 22-observation `seriesHistory` → `medianSource: 0`, with neither → empty `moves`; calling it twice in one test raises no error (the store is closed in a `finally` — a leaked handle leaks one per run forever; `qualityByDay` is the shape to copy).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Write `history.ts`** — `auditDbPath(env)` + `new AuditStore(path)`, `metricsBetween(days[0], days.at(-1))`, group by name, newest 20 absolute values, close in `finally`, a failure returns `{history: new Map(), note}` and never throws. Comment: the runner already holds the same SQLite file open through `options.audit`; two connections to one WAL database in one process is supported, this one is short-lived and read-only, and no second long-lived handle is added.
- [ ] **Step 4: Write `select.ts`** — pure, imports only `./channels.js`.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `feat(option-wizard): score and rank the channels against their own 20-session median`

**Check:** `pnpm vitest run --project unit plugins/option-wizard/tests/quality-select.spec.ts`
**Ablation.** Removed `medianSource` and used whichever denominator answered: the day-one ratio is then a number with an unstated denominator, and nobody can tell a 20-session median from a two-row one. **Kept** (it is one integer per channel).
**Doctrine:** 4 (ranking is arithmetic in code, recorded in the audit table).

---

## Task 4: `state/checks.ts` — tomorrow's three checks inside the existing fence

**Files:** modify `state/regime.ts`, `tests/state-regime.spec.ts`; create `state/checks.ts`, `tests/state-checks.spec.ts`.

**Interfaces**

```typescript
// state/regime.ts — two OPTIONAL keys on the same strictObject. Optional because
// a run whose editor was gated must still be able to write a valid record.
export const Check = z.strictObject({
  series: z.string().min(1).max(64),
  /** The level VERBATIM, with no unit conversion. A number here fails on
   *  purpose: a retyped number is the one worth refusing. */
  level: z.string().min(1).max(32),
  text: z.string().min(1).max(160),
});
export const Invalidation = z.strictObject({
  series: z.string().min(1).max(64),
  threshold: z.string().min(1).max(32),
  horizon: z.string().min(1).max(64),
});
//   checks: z.array(Check).length(3).optional(),
//   invalidation: Invalidation.optional(),

// state/checks.ts
export type CheckVerdict = "hit" | "miss" | "not-observed";
export interface ScoredCheck {
  series: string;
  level: string;
  text: string;
  verdict: CheckVerdict;
  today?: string;
}
export function priorRecord(args: {
  stateRoot: string;
  day: string;
  label: string;
  calendar?: { weekdaysOnly: boolean; closed: string[] };
}): { day: string; label: string; state: RegimeState } | null;
export function scoreChecks(
  checks: Check[],
  channels: Channel[],
): ScoredCheck[];
export function checksLine(scored: ScoredCheck[]): string;
```

**The scoring rule is deliberately crude, and the module comment says so:** `hit` when today's level for the named series differs from the stored level and that series is the leader's; `miss` when it is unchanged; `not-observed` when the series is absent today. Parsing an English sentence into a direction is model-arithmetic wearing a regex, which is what this whole design removes. A cheap honest counter beats a clever wrong one. `priorRecord` imports `LABEL_ORDER` from `quality/prior.ts` rather than copying it — two copies of an order is how two modules disagree about which run came first. **`CheckVerdict` is named apart from the coverage `VerdictToken` on purpose; they are different vocabularies and a shared name would eventually be a shared bug.**

- [ ] **Step 1: Failing tests** — a record with no `checks` key still parses (backward compatible with every record on disk); `checks` of length 2 or 4 fails, 3 passes; a numeric `level` fails; `priorRecord` over a temp state root with `2026-09-03/close.regime.json` and `2026-09-04/premarket.regime.json` returns the 09-03 close for `(2026-09-04, premarket)` and `null` for `(2026-09-03, premarket)`; it skips a weekend and a declared closed day; `scoreChecks` returns three verdicts in order and `not-observed` for an unmatched series; `checksLine([hit,hit,miss]) === "Yesterday: 2 hit, 1 missed."` and three `not-observed` → `"Yesterday: 3 not observed."`. Add one block to `state-regime.spec.ts` asserting `findStateBlock` is unchanged and the two keys round-trip through `parseRegimeState`.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Extend `state/regime.ts`.** Do not change the fence name, the suffix, or `findStateBlock`.
- [ ] **Step 4: Write `state/checks.ts`.**
- [ ] **Step 5:** `pnpm vitest run --project unit plugins/option-wizard/tests/state-checks.spec.ts plugins/option-wizard/tests/state-regime.spec.ts plugins/option-wizard/tests/gate-regime-state.spec.ts` then `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 6:** `git check-ignore -v plugins/option-wizard/state/checks.ts` — expect no output, exit 1.
- [ ] **Step 7: Commit** — `feat(option-wizard): carry tomorrow's three checks inside the regime-state record`

**Ablation.** Removed the two keys and wrote a second state file (`<label>.checks.json`): nothing improves — one extra key on the record `stateBlock` already lifts, and a second file adds a write path the renderer must not have. **Cut.**
**Doctrine:** 2 (no core edit — the existing single `stateBlock` is reused), 6 (no second state file).

---

## Task 5: `ow_argon_watchlist`, tickers of interest, and the removal of `ow_ib_positions`

**Files:** modify `tools/index.ts` (tool + `VOCABULARY`), `team.yaml` (roles `universe-builder`, `risk-reviewer`; prompts `universe`, `gex`); create `tests/tools-argon-watchlist.spec.ts`; modify `tests/team-manifest.spec.ts`.

**The tool** (`buildTools`, appended to the array; `VOCABULARY` entry `["ow_argon_watchlist", { mutating: false, requiresEnv: "OW_ARGON_API_BASE" }]` — unconfigured on the laptop by design, exactly like `ow_argon_levels`):

```typescript
{
  // Verified <DATE> against the live argon at OW_ARGON_API_BASE:
  //   GET /watchlist/chains -> { chains: [{ layer, layer_name, focus, chain,
  //     count }] } — declared taxonomy order, NOT alphabetical, and the rail
  //     leads with Index & Macro on purpose (uw_scan/api/routers/watchlist.py
  //     says so); this tool preserves whatever order argon returns.
  //   GET /watchlist?chain=<name> -> { scanned_at_min, scanned_at_max,
  //     scheduler_lag_seconds, queue{…}, hot_count, hot_max,
  //     tickers: [{ ticker, sector, chains[], pinned, hot, sort_rank, spot,
  //     spot_quoted_at, spot_source, scanned_at, iv_atm, iv_rank, market_cap,
  //     … }] }.
  // KEPT beyond the members: `pinned` (it IS the tickers-of-interest list) and
  // `iv_rank` (the §G.4 column and the flowAnomaly input).
  // EXCLUDED as noise: setup, aggression_pct, returns, gamma, skew,
  // positioning, queue, market_cap, aum. This tool answers ONE question —
  // which tickers are in this chain — and the weekly % comes from the bars
  // tool, never from a card field whose vintage is the scan's, not the week's.
  // `scanned_at_max` is copied through as `asOf`, verbatim.
  name: "ow_argon_watchlist",
  description:
    "The argon watchlist rail: every chain with its layer and live member count, the members of each requested chain, and the operator's tickers of interest (the pinned rows). A chain name is matched EXACTLY as argon spells it; a name argon does not serve comes back in `unknown` and is reported as untested rather than guessed at.",
  paramsSchema: ArgonWatchlistParams,        // { chains?: string[] } — optional, so a
  mutating: false,                            // deterministic step can call it with {}
  dshParams: { chains: { type: "array", description: 'Chain names, e.g. ["Computer/GPU"]. Omit for the declared `extensions.review.sectors` list.' } },
  async run(args, ctx) { /* … */ },
}
```

Behaviour: with no `chains`, read `review.sectors` (the parsed config from Task 1). Fetch `/watchlist/chains` once; for each requested name, fetch `/watchlist?chain=<encoded>` only if the rail contains it, else push the name into `unknown`. One failing chain does not fail the others (the `ow_argon_levels` discipline). Return:

```
{ source: "argon", asOf, chains: [{ chain, layer, count, members: string[], asOf }],
  unknown: string[],
  /** Addendum B: the operator's TICKERS OF INTEREST — every row with
   *  pinned: true, deduplicated, in argon order. This is what replaces the
   *  positions read: the operator puts a name here by hand if they want it
   *  covered, and the page only ever sees "of interest", never "held". */
  ofInterest: string[],
  /** argon's own iv_rank per ticker, copied. Never computed here. */
  ivRank: Record<string, number> }
```

`need(env, "OW_ARGON_API_BASE", tool)` gates it.

**The privacy change, and why the simpler one.** Spec §E leaves it open: drop `ow_ib_positions` from the role, or keep it and add a renderer gate refusing any brief that names a ticker appearing only in positions. **Take the removal.** The gate is unbuildable as specified without a second store: to know a ticker appears "only in positions" the renderer must hold the positions list at render time, which means the very data the page must never see travels one step further into the renderer — and the gate would then be the only thing standing between it and `data: view`, which argon persists. Removal deletes the path instead of certifying it (doctrine 6), costs one line of YAML, and is provable by a manifest test rather than by a prose rule. What is lost — the universe no longer auto-includes held names — is exactly what `ofInterest` restores, under the operator's hand.

**Beyond the brief, and flagged so it can be reversed:** `risk-reviewer` also holds `ow_ib_positions`, and **its** output (`riskList`, `decision`) renders on the same public page. Removing it there too is the only way the assertion "no held-only ticker can reach the page" is true rather than nearly true. `ow_ib_preflight` (the order-time gate) is untouched, and the tool itself stays in `VOCABULARY` so a future private tenant can use it.

- [ ] **Step 1: Record the live shape** (needs the local argon from `~/.config/helium/argon-local.env`):

```bash
set -a; source ~/.config/helium/argon-local.env; set +a
curl -sS "$OW_ARGON_API_BASE/watchlist/chains" | head -c 800
curl -sS "$OW_ARGON_API_BASE/watchlist?chain=Computer%2FGPU" | head -c 800
```

Paste the observed keys and the date into the tool's header comment, and save both responses (trimmed to the kept fields) as `tests/fixtures/review/watchlist-chains.json` and `watchlist-Computer-GPU.json` with their provenance in the fixture README. **If argon is not running, say so in the README and mark the fixture `recorded from the router source, not a live response`** — do not invent a shape.

- [ ] **Step 2: Failing tests**

`tests/tools-argon-watchlist.spec.ts` (stubbed `ctx.fetchImpl` as `tools-macro.spec.ts` does): the tool's `paramsSchema` accepts `{}`; with the fixture rail, `chains: ["Computer/GPU","Cybersecurity"]` returns both with their real member lists (`NVDA, AMD, ARM, SMCI, DELL, HPE, HPQ` for `Computer/GPU`, asserted against the fixture, not typed from memory); `ofInterest` equals the fixture's pinned tickers in argon order with no duplicates; `ivRank` copies the fixture's numbers and computes none; an unknown name lands in `unknown` and does **not** throw; a 500 on one chain leaves the other's members intact; with `OW_ARGON_API_BASE` unset the tool throws the `need(...)` message and the tenant still loads (the tool is env-gated, not required).

`tests/team-manifest.spec.ts`:

```typescript
it("no role can read positions — the flash page is public", () => {
  // The argon /flash page is public (user, 2026-09-06). team.yaml already
  // forbids quantity, size and account value in prose, but a HELD TICKER NAME
  // is itself private and a prompt is never a permission boundary
  // (AGENTS.md, Safety model). The tool is removed from every role rather
  // than gated at render time: a gate would require the renderer to hold the
  // positions list, one step closer to `data: view`, which argon persists.
  for (const [name, role] of Object.entries(manifest.roles))
    expect(role.permissions.tools ?? [], name).not.toContain("ow_ib_positions");
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

it("no persona or prompt speaks of positions or holdings outside a ban clause", () => {
  // Addendum B wording rule. `position`, `held` and `holding` may appear ONLY
  // inside an explicit "Never …" / "never a …" ban sentence — that is the one
  // place the words have to appear in order to forbid themselves.
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
```

- [ ] **Step 3: Run — fail. Step 4: Write the tool and its `VOCABULARY` entry.**
- [ ] **Step 5: Edit `team.yaml`** — `universe-builder.tools` becomes `[ow_tv_watchlist, ow_argon_watchlist, ow_spot]`; `risk-reviewer.tools` drops `ow_ib_positions`; the `universe` prompt becomes `Merge the TradingView flag lists and the argon tickers of interest into one deduplicated ticker set.`; the `gex` prompt's "any ticker in the universe you were handed that carries an open position" becomes "any ticker of interest in the universe you were handed". Leave the `Never a tool name (…ow_ib_positions…)` lines in the two personas — they are a prose ban on naming any tool and still apply (and the wording test skips `never` lines for exactly this reason).
- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test`, plus the `loadTenants` one-liner from Task 1 (a role naming an _unknown_ tool skips the tenant; this is how you see it before a replay does).
- [ ] **Step 7: Commit** — `feat(option-wizard): read the argon watchlist chains and tickers of interest, and remove the positions read from every role`

**Ablation.** Removed the renderer gate that would have refused briefs naming a held-only ticker: nothing breaks — removing the tool deletes the path instead, and the gate would have pulled positions data one step closer to `data: view`. **Cut.** Removed `ofInterest` and left the universe to TV flags alone: the user's "把持仓改成 ticker of interest" is then unimplemented and the operator has no way to add a name. **Kept** (it is one field of an existing response).
**Doctrine:** 2 (business knowledge in the tenant), 3 (a new capability is a new tool entry), 5 (never publish the book), 6 (delete rather than certify).

---

## Task 6: `ow_massive_actions` — splits and ex-dividends from a real feed

**Files:** modify `tools/index.ts` (tool + `VOCABULARY`), `tenant.yaml` (`env` names); create `tests/tools-massive-actions.spec.ts`, `tests/fixtures/review/massive-splits-docs.json`, `massive-dividends-docs.json`.

**Why this task exists.** Until this feed was found, §G.2's corporate-action row had no source at all and every split, index event and dividend would have entered as an operator-dated pin. **massive.com (ex-Polygon) serves two of those four**, and argon already talks to the same provider — the env names `MASSIVE_API_KEY` and `MASSIVE_BASE_URL` (default `https://api.massive.com`) come from argon's `uw_scan/config.py`, so the operator has one key and two consumers, not two keys. What Massive does **not** cover — index add/remove, rebalance, spin-off, lockup expiry, secondary — stays with `focus.calendarPins` and with Task 1's two `it.skip` gates.

**`tenant.yaml`** gains the two names only (the tenant declares NAMES, never values):

```yaml
env:
  # … existing names …
  - MASSIVE_API_KEY # ow_massive_actions; argon uses the same name
  - MASSIVE_BASE_URL # optional, defaults to https://api.massive.com
```

**The tool** (`VOCABULARY`: `["ow_massive_actions", { mutating: false, requiresEnv: "MASSIVE_API_KEY" }]` — unconfigured on the laptop and, as of 2026-09-06, **not yet in `~/.config/helium/helium.env` on the mini either**; Task 16 carries that as a deploy step):

```typescript
{
  // 2026-09-06. Shape TRANSCRIBED FROM THE MASSIVE DOCUMENTATION, NOT YET
  // OBSERVED LIVE — this comment is rewritten from the first real response
  // (repo convention: a tool's comment records the shape it was VERIFIED
  // against, with the date and the excluded fields). The it.skip in
  // tests/tools-massive-actions.spec.ts names exactly that debt.
  //   GET {MASSIVE_BASE_URL}/stocks/v1/splits
  //       ?execution_date.gte=<yyyy-mm-dd>&execution_date.lte=<yyyy-mm-dd>
  //       [&ticker=<sym>]   -> rows: { ticker, execution_date, split_from,
  //       split_to, adjustment_type, status }
  //   GET {MASSIVE_BASE_URL}/stocks/v1/dividends
  //       ?ex_dividend_date.gte=<yyyy-mm-dd>&ex_dividend_date.lte=<yyyy-mm-dd>
  //       [&ticker=<sym>]   -> rows: { ticker, declaration_date,
  //       ex_dividend_date, pay_date, record_date, cash_amount, status }
  // Both are "included in all Stocks plans" and update daily.
  // EXCLUDED as noise: pagination envelopes beyond `next_url`, currency and
  // frequency fields, and every dividend field this tenant does not date on
  // (`pay_date` and `record_date` are kept ONLY because assignment risk is a
  // date question). This tool answers ONE question — which dated corporate
  // actions fall inside this window — and never a price.
  // UNCONFIRMED, and it bounds what the corporate weight may do: the docs do
  // not state whether an ANNOUNCED-but-unexecuted split is returned ahead of
  // its execution_date. The dividends sample carries a FUTURE ex-date, so
  // forward dividend rows are served. Until a live call settles the split
  // question, the `corporate` weight fires on execution_date and nothing
  // earlier (Task 7 comments say so at the scoring site).
  name: "ow_massive_actions",
  description:
    "Dated corporate actions from massive.com: stock splits by execution date and dividends by ex-dividend date, for a ticker set and a date window. Read the dates; this tool carries no price, no direction and no opinion.",
  paramsSchema: MassiveActionsParams,   // { tickers?: string[]; from: string; to: string }
  mutating: false,
  dshParams: {
    tickers: { type: "array", description: 'Tickers, e.g. ["NVDA"]. Omit for the whole window across the universe the caller passes.' },
    from: { type: "string", description: "yyyy-mm-dd, inclusive." },
    to: { type: "string", description: "yyyy-mm-dd, inclusive." },
  },
  async run(args, ctx) { /* two GETs, then normalise */ },
}
```

Returns, normalised so no snake_case reaches a caller:

```typescript
{
  source: "massive",
  window: { from: "2026-09-08", to: "2026-09-22" },
  splits: Array<{ ticker: string; executionDate: string; from: number; to: number; type?: string; status?: string }>,
  dividends: Array<{ ticker: string; exDate: string; declared?: string; amount: number; status?: string }>,
  /** One string per failed half, so one endpoint down never blanks the other. */
  notes: string[],
}
```

Behaviour: **two calls per run, not per ticker** — both endpoints take a date range, so the window is fetched once and filtered to the universe in code (the `tickers` param is passed through when the caller supplies a short list). A 5xx on one endpoint leaves the other's rows intact and adds a `notes` line. `need(env, "MASSIVE_API_KEY", tool)` gates it; `MASSIVE_BASE_URL` defaults to `https://api.massive.com`.

- [ ] **Step 1: Hand-transcribe the documented examples** into `tests/fixtures/review/massive-splits-docs.json` and `massive-dividends-docs.json`, and record in `tests/fixtures/review/README.md`, verbatim: **"transcribed from the massive.com Stocks API documentation on 2026-09-06 — NOT a recorded live response"**. Do not add a field the documentation does not show, and do not round a number it does show.
- [ ] **Step 2: Failing tests** (`tests/tools-massive-actions.spec.ts`, stubbed `ctx.fetchImpl` as `tools-macro.spec.ts` does):
  - the request URLs carry `execution_date.gte` / `execution_date.lte` and `ex_dividend_date.gte` / `ex_dividend_date.lte` with the passed window, and the key is sent the way argon sends it (copy argon's header/param form; do not invent an auth scheme).
  - the documented split row maps to `{ticker, executionDate, from, to, type, status}` with `split_from`/`split_to` as numbers, and the documented dividend row to `{ticker, exDate, declared, amount, status}` with `cash_amount` unrounded.
  - rows outside `[from, to]` are filtered out; rows for tickers outside the supplied set are filtered out.
  - a 500 on `/splits` leaves `dividends` populated and adds one `notes` line naming the endpoint; the tool **never throws** on a partial failure.
  - with `MASSIVE_API_KEY` unset the tool throws the `need(...)` message and the tenant still loads (env-gated, not required).
  - `MASSIVE_BASE_URL` unset uses `https://api.massive.com`; set, it is used verbatim.

```typescript
// TODO-verified-shape.
it.skip("ow_massive_actions: live shape unverified — run once with MASSIVE_API_KEY and record", () => {
  // The fixtures above are TRANSCRIBED FROM DOCUMENTATION. Before this tool is
  // trusted in production: run one real call for a known split (a recent
  // 4-for-1 in the universe) and one for a known dividend, paste the observed
  // keys and the date into the tool's header comment, replace both fixtures
  // with the recorded responses, and answer the one open question — does
  // /stocks/v1/splits return an ANNOUNCED split before its execution_date?
  // Unskip this test only when the comment names a live date.
});
```

- [ ] **Step 3: Run — fail. Step 4: write the tool, its `VOCABULARY` entry and the two `env` names. Step 5: Run — PASS.**
- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test`, plus the `loadTenants` one-liner from Task 1 (an undeclared env name is how a tenant fails its readiness probe — check it here, not in a replay).
- [ ] **Step 7: Commit** — `feat(option-wizard): read dated splits and ex-dividends from massive.com`

**Ablation.** Removed the tool and kept `focus.calendarPins` as the only corporate path: splits and ex-dividends then depend on the operator remembering, which is the "拍脑袋" §G.0.1 exists to remove — and the assignment-risk case (§I.1) is exactly the one a human forgets. **Kept.** Removed the normalisation and passed Massive's snake_case straight through: two spellings of the same date then travel into `quality/focus.ts`, and the purity scan cannot tell which is authoritative. **Kept.** Removed the `it.skip` and written the shape comment as if verified: that is the one thing AGENTS.md forbids outright. **Kept, and it is the honest half of this task.**

**Doctrine:** 2 (a business feed at the tenant edge, never in core), 3 (a new capability is a new tool entry), 4 (two calls per run, stated in the comment), 6 (no new gate — the missing verification is a named skipped test, not a ceremony).

---

## Task 7: `quality/focus.ts` — the 15 and the 5, computed and byte-identical

**Files:** create `plugins/option-wizard/quality/focus.ts`, `tests/quality-focus.spec.ts`.

**Interfaces**

```typescript
export const FOCUS_KINDS = [
  "earnings",
  "corporate", // split (ow_massive_actions) or an operator-dated pin
  "macroNamed",
  "openCall",
  "theme",
  "flowAnomaly",
  "pinned",
  /** §I.1: an ex-dividend date INSIDE an open call's window. It is its own
   *  kind and not a `corporate` row because it means something different —
   *  early assignment on a short leg — and because it may only fire on a
   *  name we already hold a commitment on. */
  "assignmentRisk",
] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

/** The ONLY sources an event may come from. A row from anywhere else is
 *  dropped with a note — §G.1's "nothing outside the universe can be on the
 *  list" applied to the EVENT as well as to the ticker, because a hallucinated
 *  date admits a real ticker for a reason that never existed. */
export const ADMITTED_EVENT_SOURCES: ReadonlySet<string> = new Set([
  "ow_uw_earnings",
  "ow_uw_calendar",
  "ow_argon_policy_path",
  "ow_uw_iv_term",
  "ow_argon_watchlist",
  "ow_massive_actions",
  "ledger",
  "tenant.yaml",
]);

export interface FocusEvent {
  ticker: string;
  kind: FocusKind;
  /** `yyyy-mm-dd`, when the feed dated it. Undefined for the undated kinds
   *  (`pinned`, `theme`, `flowAnomaly` — all "today", none decaying). */
  day?: string;
  /** OPEN sessions from `inputs.day`. Negative = already past: scores 0.
   *  null = the feed gave no date, which is why it never decays. */
  sessionsAway: number | null;
  session?: "pre" | "post";
  /** The tool that dated it, verbatim. Must be in ADMITTED_EVENT_SOURCES. */
  source: string;
  /** What the row prints: "Q3 earnings (post)", "CPI", "theme el-nino-ag-2026". */
  label: string;
}

export interface FocusRow {
  ticker: string;
  /** Sum of the decayed weights, rounded to 4 dp so two machines print the
   *  same string. */
  score: number;
  parts: Array<{ kind: FocusKind; points: number; from: string }>;
  /** The tie-break's second key and the daily list's first. null sorts last. */
  daysToNearestEvent: number | null;
  nearest?: FocusEvent;
  /** argon's `iv_rank` when the watchlist payload carried it; the §G.4 column
   *  prints `—` when it did not. Never computed here. */
  ivRank?: number;
  openCallIds: string[];
  themes: string[];
  /** True when this name was carried in from an open focus-admit commitment. */
  sticky?: boolean;
}

export interface FocusInputs {
  day: string;
  /** §G.1: argon chains ∪ pinned ∪ TV flag lists. Nothing else may score. */
  universe: string[];
  pinned: string[];
  ivRank?: Record<string, number>;
  earnings?: unknown; // ow_uw_earnings
  calendar?: unknown; // ow_uw_calendar
  policy?: unknown; // ow_argon_policy_path
  ivTerm?: unknown; // ow_uw_iv_term
  actions?: unknown; // ow_massive_actions — splits and ex-dividends
  /** Outstanding ledger commitments that name a ticker, from readLedger. */
  openCalls?: Array<{ id: string; ticker: string; settleDay?: string }>;
  themes: readonly ThemeSpec[];
  pins: FocusConfig["calendarPins"];
  /** Open-session arithmetic, injected: no calendar walk lives in here. */
  openDaysBetween: (from: string, to: string) => number;
  notes?: string[];
}

export function focusEvents(
  inputs: FocusInputs,
  cfg: FocusConfig,
): FocusEvent[];
export function decay(
  weight: number,
  sessionsAway: number | null,
  window: number,
): number;
export function scoreFocus(inputs: FocusInputs, cfg: FocusConfig): FocusRow[];

/** §G.0.2 stickiness. `carried` = the tickers whose `focus-admit` commitment is
 *  still outstanding; they take slots first, in tie-break order, before any new
 *  name. `churn` = carried names dropped anyway (only possible when more are
 *  carried than there are slots). Target 0, and it is a metric. */
export function selectFocus(args: {
  rows: readonly FocusRow[];
  limit: number;
  carried: readonly string[];
}): {
  rows: FocusRow[];
  churn: number;
  dropped: Array<{ ticker: string; why: string }>;
};

/** §G.4 daily: the 5 of the weekly list with the nearest event, topped up from
 *  the full universe when the weekly list holds fewer than `limit`. A name
 *  whose event is TODAY ranks first, which falls out of the sort key. */
export function dailyFocus(
  weekly: readonly FocusRow[],
  all: readonly FocusRow[],
  limit: number,
): FocusRow[];

/** §G.6: "No direction. No sizing. No 'hot stock' reasoning." A persona is a
 *  request; a pattern list is a match — the same reasoning quality/meta-leak.ts
 *  is built on, and the same {field, pattern, excerpt} shape. Regex SOURCES,
 *  not RegExp objects: a shared /g RegExp carries lastIndex between calls.
 *
 *  `\bshort\b` also catches "short interest". Accepted: the row's job is the
 *  EVENT, and "borrow" says the same thing without a direction word. */
export const FOCUS_BANNED_PATTERNS: readonly string[] = [
  "\\b(?:buy|sell|long|short|bull(?:ish)?|bear(?:ish)?)\\b",
  "\\b(?:target|upside|downside|rally|crash|squeeze|breakout)\\b",
  "\\b(?:size|sizing|position|contracts|shares|allocate)\\b",
  "\\b(?:should|recommend|favou?rite|best|top pick)\\b",
];
export function findFocusLeaks(
  rows: ReadonlyArray<{ ticker: string; why: string }>,
): Leak[];
```

**Scoring rules, as code comments:**

```typescript
export function decay(
  weight: number,
  sessionsAway: number | null,
  window: number,
): number {
  // §G.3: full points on the day, a straight line to zero at the window's end,
  // nothing outside it. An UNDATED kind (pinned, theme, flowAnomaly) has
  // sessionsAway null and earns its full weight with no decay — "today only,
  // no decay" in the spec's own words. An event already PAST earns nothing: it
  // happened, and its focus-admit commitment is what scores it now.
  if (sessionsAway === null) return weight;
  if (sessionsAway < 0 || window <= 0) return 0;
  if (sessionsAway >= window) return 0;
  return Number((weight * (1 - sessionsAway / window)).toFixed(4));
}
```

Sort key, used by `scoreFocus`, `selectFocus` and `dailyFocus` so there is one comparator and not three:

```typescript
// score DESC · daysToNearestEvent ASC (null last) · ticker A-Z. The alphabetical
// last key is what makes the list REPLAYABLE: without it two names on the same
// score come back in payload order, and payload order is the API's, not ours.
function byFocusRank(a: FocusRow, b: FocusRow): number {
  if (a.score !== b.score) return b.score - a.score;
  const da = a.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  const db = b.daysToNearestEvent ?? Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  return a.ticker.localeCompare(b.ticker, "en");
}
```

The daily comparator inverts the first two keys (`daysToNearestEvent` first, then score, then ticker) — §G.4 asks for nearest-event order, and a name whose event is today has `daysToNearestEvent === 0` and therefore leads.

**`corporate` and `assignmentRisk` come from `ow_massive_actions` (Task 6), and the comment at the scoring site says what bounds them:**

```typescript
// A SPLIT scores `corporate` on its execution_date, and — until a live call
// confirms that /stocks/v1/splits returns an ANNOUNCED split ahead of that
// date — nothing earlier. Announced-but-unexecuted is unverified (Task 6's
// it.skip), so the weight fires on the date we can see, not on one we hope is
// served.
//
// An EX-DIVIDEND scores `assignmentRisk` ONLY when it falls inside the window
// of an open ledger commitment on the same ticker: a dividend on a name we
// have no position-shaped exposure to is not a reason to watch it, and this
// list is about what is ahead for OUR book of published calls. Every other
// ex-dividend row is ignored, not down-weighted.
// index add/remove, rebalance and spin-off have no feed and enter only as a
// `focus.calendarPins` row (Task 1's it.skip gates say why).
```

**`flowAnomaly` is scored from `iv_rank >= 80` alone**, and the row's `parts[].from` says `"ow_argon_watchlist iv_rank"` so the half that is missing is visible in the output. §G.2 also asks for a 30-day volume ratio ≥ 2×; **no verified payload in this tenant carries a volume ratio** (`ow_uw_ticker_metrics` returns IV term structure and max pain, not volume), so it is not scored and not faked.

Call budget, written into the frame tool's comment because doctrine 4 makes cost part of the design: `ow_uw_earnings` is one round trip per ticker and is capped at `maxEarningsLookups` (pinned first, then alphabetical, so _which_ 60 is deterministic); `ow_uw_iv_term` takes at most 3 tickers per call and is capped at `maxIvTermCalls`; `ow_uw_calendar` and `ow_argon_policy_path` are one call each and are already siblings; **`ow_massive_actions` is two calls for the whole window regardless of universe size**, because both Massive endpoints take a date range. Every truncation is a `notes` line, never silence.

- [ ] **Step 1: Failing tests** (`tests/quality-focus.spec.ts`), table-driven, real values only:
  - `decay` table: `(10, 0, 7) === 10`; `(10, 7, 7) === 0`; `(10, 3, 7) === 5.7143`; `(10, -1, 7) === 0`; `(10, null, 7) === 10`; `(8, 10, 10) === 0`.
  - `focusEvents` from a recorded `ow_uw_earnings` payload for NVDA — the tool's own verification comment records the live `next_earnings_date` as `"2026-11-18"` with `announce_time` `"unknown"` for NVDA and `"postmarket"` for SNOW — yields an `earnings` event for NVDA with `source: "ow_uw_earnings"`, no `session` (UW's own `"unknown"` never becomes a report time), and, from `day: "2026-09-06"`, a `sessionsAway` far outside the 7-session window, so `scoreFocus` gives it **0 earnings points**. This is the zero end of the decay tested against a real date, not a constructed one.
  - an event whose `source` is `"get_market_events"` is dropped and named in `notes` — `ADMITTED_EVENT_SOURCES` is the whole defence against an invented feed.
  - a split row from the Task 6 fixture, dated inside the `corporate` window, scores `corporate` points with `parts[].from === "ow_massive_actions"`; the same row dated **before** `inputs.day` scores 0.
  - an ex-dividend row scores `assignmentRisk` **only** when an open ledger commitment on that ticker spans the ex-date; with no such commitment the row produces no event at all (assert the absence, not a zero).
  - a `calendarPins` row with `kind: corporate` and a date inside the window scores `corporate` points with `parts[].from === "tenant.yaml"` — still the only path for an index add/remove or a spin-off (Task 1's `it.skip` gates say why).
  - `flowAnomaly` scores from a watchlist `iv_rank` of 84 and does **not** score at 79; `parts[].from` names `ow_argon_watchlist iv_rank`.
  - `scoreFocus` over a universe of the real chain members Task 5 recorded (`NVDA, AMD, ARM, SMCI, DELL, HPE, HPQ`) with one pinned name, one open ledger call and one theme membership: the parts sum to `score`, and every part's `from` names the tool it came from.
  - **tie-break:** two rows with equal score and equal `daysToNearestEvent` come back alphabetically; shuffling `inputs.universe` produces a `JSON.stringify`-identical result (the strongest form of §G.0.1).
  - **byte-identity:** `JSON.stringify(selectFocus(...))` from two separately constructed but equal input objects is `toBe`-equal.
  - **purity scan**, the technique `render.spec.ts` already uses for the phase scanner:

```typescript
it("computes the list without a clock or a coin", async () => {
  const src = await readFile(
    new URL("../quality/focus.ts", import.meta.url),
    "utf8",
  );
  for (const banned of [
    "Date.now(",
    "Math.random(",
    "new Date(",
    "process.env",
    "node:fs",
  ])
    expect(src, banned).not.toContain(banned);
});
```

- `selectFocus` with 15 slots and 3 carried names returns the 3 first (each `sticky: true`), then 12 new, `churn === 0`; with 17 carried names and 15 slots returns 15, `churn === 2`, and `dropped` names both with `"carried list is 17 long; only 15 slots"`.
- `dailyFocus` returns exactly 5 with the today-dated name first; from a weekly list of 3 it tops up to 5 from the universe; from a universe of 2 it returns 2 and the caller (Task 12's renderer) prints the row that says why not.
- `scoreFocus` with every payload absent returns one row per universe member, all `score: 0`, and never throws.
- `findFocusLeaks` flags `"bullish into the print"` with the pattern and a ≤40-character excerpt, and passes `"Q3 earnings after the close; guidance is the swing factor"`.

- [ ] **Step 2: Run — fail. Step 3: write `quality/focus.ts`. Step 4: Run — PASS.**
- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm test`
- [ ] **Step 6: Commit** — `feat(option-wizard): compute the weekly 15 and daily 5 from dated event feeds, not from a model`

**Ablation.** Removed `selectFocus`'s stickiness and re-ranked from scratch each run: the list then churns whenever a score moves by a rounding step, which is exactly the "每次 run 都会不一样" the user rejected. **Kept.** Removed the injected `openDaysBetween` and called `openDaysBack` directly: `quality/` would then import from `tools/index.ts`, inverting the dependency and dragging `env` into a pure module. **Kept as an injection.** Removed `parts[]` and kept only `score`: nothing breaks in the arithmetic, but the row can no longer say _why_ it is on the list, which is §G.4's whole output column. **Kept.** Removed the `ADMITTED_EVENT_SOURCES` set: nothing breaks today because no unverified feed is wired — and that is precisely the point at which one gets wired. **Kept.** Removed `findFocusLeaks` and relied on the persona sentence: the 09-03 audit is the standing evidence that a persona is a request — eight of eleven model-computed numbers were wrong under a persona that forbade computing them. **Kept.**

**Doctrine:** 4 (the list is arithmetic; the model writes one clause and nothing else), 1 (the same inputs replay to the same 15, so a weight change is measurable), 2 (all of it in the tenant).

---

## Task 8: `ow_session_frame` — one deterministic step, one payload, three readers

**Files:** create `quality/frame.ts`, `tests/quality-frame.spec.ts`, `tests/tools-session-frame.spec.ts`; modify `tools/index.ts`, `team.yaml`, `tests/team-manifest.spec.ts`.

**Interfaces**

```typescript
// quality/frame.ts
/** The marker key. The renderer and the gate find this payload in
 *  report.toolOutputs BY SHAPE — a tool output does not record its producer. */
export const SESSION_FRAME_KIND = "session-frame/1";

export type VerdictToken =
  "continue" | "reverse" | "strengthen" | "fade" | "untested";

export interface SessionFrame {
  kind: typeof SESSION_FRAME_KIND;
  day: string;
  mode: SelectMode;
  why: string;
  streak?: number;
  ranked: Array<{
    id: ChannelId;
    series: string;
    level?: string;
    prior?: string;
    move?: string;
    score: number | null;
    medianSource: 0 | 1 | null;
    asOf?: string;
    excluded?: string;
  }>;
  /** The FIXED list, in declared order, always complete:
   *  coverage.length + sectors.length + themes.length rows. */
  rows: CoverageRow[];
  /** §G. Both lists, always. The renderer takes `weekly` for the `weekly` task
   *  and `daily` for `edit` — a task id, which `sectionsFrom` already branches
   *  on, and never a phase. */
  focus: {
    weekly: FocusRow[];
    daily: FocusRow[];
    churn: number;
    carried: string[];
    dropped: Array<{ ticker: string; why: string }>;
    /** "earnings: 60 of 87 universe members looked up (maxEarningsLookups)". */
    notes: string[];
    /** Printed under the table until §I.6 re-weights from data. */
    weightsNote: string; // "weights: declared prior 2026-09-06"
  };
  /** Yesterday's three, already scored. The editor OPENS with this line. */
  checks: {
    line: string;
    scored: ScoredCheck[];
    from?: { day: string; label: string };
  };
  standing?: {
    series: string;
    threshold: string;
    horizon: string;
    breached: boolean;
  };
  /** The ledger, as of AFTER the settler ran earlier in this same run.
   *  `settledToday` is section 1; `open` is section 7 and the `calls.open` row. */
  ledger: {
    settledToday: Array<{
      id: string;
      issuedDay: string;
      issuedPhase: string;
      status: string;
      scores: Record<string, number>;
      detail?: unknown;
      evidenceHash?: string;
      payload: unknown;
    }>;
    open: Array<{
      id: string;
      issuedDay: string;
      issuedPhase: string;
      payload: unknown;
      barsSeen?: number;
      deadlineBars?: number;
    }>;
    /** Addendum C4: the first commitment day, so §1 can print
     *  "all n calls issued since <day>; none removed". */
    firstCommitmentDay?: string;
    totalCommitments: number;
    unavailable?: string;
  };
  /** The caps the renderer trims to, copied out of extensions.review.caps. */
  caps: { weekly: Caps; daily: Caps };
  /** The declaration the row list was built from, so the renderer and the
   *  tests can recompute the expected count instead of holding a constant. */
  declared: { coverage: string[]; sectors: string[]; themes: ThemeSpec[] };
  coverage: Array<{
    layer: string;
    source: string;
    asOf?: string;
    state: "ok" | "skipped";
    reason?: string;
  }>;
  notes?: string[];
}

export function buildFrame(args: {
  inputs: ChannelInputs;
  focusInputs: FocusInputs;
  days: string[];
  stateRoot: string;
  label: string;
  review: ReviewConfig;
  calendar?: { weekdaysOnly: boolean; closed: string[] };
  env?: NodeJS.ProcessEnv;
}): SessionFrame;

/** The same payload back out of a finished run. Null when the step did not run. */
export function frameFrom(report: RunReport): SessionFrame | null;
```

**The tool.** `VOCABULARY`: `["ow_session_frame", { mutating: false, requiresEnv: "OW_ARGON_PG_URL" }]` — its primary source is argon's macro store and a machine without that key cannot rank or cover anything; the reason goes in a comment beside it.

```typescript
{
  // 2026-09-06. The ranking, the coverage rows, the focus list and the ledger
  // citation rows are arithmetic and bookkeeping, so they are computed ONCE,
  // here, and read three times: the editor / weekly analyst through the
  // deterministic step's handoff, the renderer out of report.toolOutputs, and
  // the flash-budget gate out of GateCtx. Two computations of one ranking is
  // how a prompt and an audit table end up disagreeing about what moved.
  //
  // It re-calls its sibling tools rather than reading their outputs, because a
  // deterministic step's tool can only be handed `{}` (packages/cli/src/runner.ts
  // `toolArgs`: a schema that accepts {} is called with {}). That is inside the
  // existing envelope — the 2026-09-03 close replay already called
  // ow_macro_rates three times and ow_argon_policy_path twice in one run — and
  // it buys the property that the number in the prompt and the number in the
  // audit table are the same number.
  //
  // CALL BUDGET (doctrine 4 — cost is part of the design): ow_uw_earnings is
  // ONE round trip PER TICKER, capped at focus.maxEarningsLookups, pinned
  // first then alphabetical so WHICH 60 is deterministic; ow_uw_iv_term takes
  // at most 3 tickers per call, capped at focus.maxIvTermCalls;
  // ow_massive_actions is TWO calls for the whole window whatever the universe
  // size (both endpoints take a date range); every other sibling is one call.
  // Every truncation is a focus.notes line, never silence.
  //
  // The LEDGER read is `readLedger` from @helium/core, a real dependency since
  // PR #93. It is called AFTER the settler has run (the runner settles before
  // the DAG), so `settledToday` is this morning's verdicts already scored.
  //
  // ow_ib_positions is NOT a sibling and never will be: the /flash page is
  // public (Task 5). A test asserts the sibling list.
  name: "ow_session_frame",
  description:
    "This session's frame, computed not narrated: the ranked channels with each one's named series, today's level and the prior one copied verbatim and the move against that channel's own 20-session median; the FIXED coverage list in its declared order with a level, a move and an as-of per row (or `untested`); the weekly-15 and daily-5 focus lists with the dated event that admitted each name; yesterday's three checks already scored; and the ledger rows — what the settler closed today, and what is still open. Write about rank 1, the rows you were given and the names you were given; you may not re-rank, you may not add or drop a row or a name, and every number you quote is copied from this payload.",
  paramsSchema: NoParams,
  mutating: false,
  dshParams: {},
  async run(_args, ctx) { /* siblings, then buildFrame */ },
}
```

Sibling lookup, identical to the pattern already used inside `buildTools`:

```typescript
const sibling = (name: string) => built.find((entry) => entry.name === name);
const answer = async (name: string, args: Record<string, unknown> = {}) => {
  const tool = sibling(name);
  if (tool === undefined) return { skipped: `${name}: not built` };
  try {
    return { payload: JSON.parse(await tool.run(args, ctx)) as unknown };
  } catch (error: unknown) {
    return {
      skipped: `${name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
```

A skipped sibling becomes a `coverage` row with `state: "skipped"` and a reason, and every channel, coverage row or focus feed it fed becomes `excluded` / `untested` / a `focus.notes` line. **`ow_session_frame` never throws** — an unrankable day is `mode: "no-data"` with a full set of `untested` rows and a focus list scored from whatever answered, and the brief can still be written from it.

**team.yaml wiring**

```yaml
frame-clerk:
  # DETERMINISTIC — not an agent. Ranking rows by numeric fields, scoring an
  # event calendar and reading an append-only ledger is reproducible
  # arithmetic; a model here costs tokens and adds variance for nothing
  # (packages/core/src/team.ts, CapabilityList: "a step that requires no
  # capability is a DETERMINISTIC step").
  requires: []
  permissions:
    mutations: forbidden
    tools: [ow_session_frame] # Task 9 appends ow_rotation
```

```yaml
- id: frame
  role: frame-clerk
  phases: [premarket, intraday, close, weekly]
  dependsOn: [universe]
  requires: []
```

`regime.dependsOn`, `edit.dependsOn`, `weekly.dependsOn` and `week-review.dependsOn` each gain `frame` — the analyst and the editor must see the same rows the renderer will print.

- [ ] **Step 1: Failing tests.**
      `tests/quality-frame.spec.ts` — `buildFrame` over the Task 2 fixtures plus an in-memory store: `kind === SESSION_FRAME_KIND`; `rows.length === review.coverage.length + review.sectors.length + review.themes.length` and in declared order; `mode` is `"ratio"` with a small vol median and `"persistence"` with a large one; `coverage` has one row per layer with the source's own `asOf` copied; `checks.line === "Yesterday: no prior checks."` when `priorRecord` returns null; `ledger.open` echoes the ids of a seeded `option-wizard.jsonl`, `ledger.settledToday` only the receipts whose `settledAt` falls on `day`, and `ledger.firstCommitmentDay` the earliest issue day; an absent ledger file yields `ledger.open: []` with `unavailable` set and no throw; `focus.weekly.length === min(15, universe.length)` and `focus.daily.length === min(5, focus.weekly.length)`; an absent `ow_uw_earnings` sibling leaves `focus.weekly` populated (scored from the other feeds) and adds a `notes` line; `focus.weightsNote` is the declared-prior string; **an unconfigured `ow_massive_actions` (no `MASSIVE_API_KEY`, the laptop default) leaves the frame intact — a `skipped` coverage row, a `focus.notes` line, and zero `corporate`/`assignmentRisk` points, never a thrown tool.** `frameFrom(report)` finds the payload inside a synthetic `RunReport` and returns `null` when it is absent.
      `tests/tools-session-frame.spec.ts` — `paramsSchema` accepts `{}` (this is what lets the deterministic step call it at all); the output parses to a `SessionFrame`; a throwing sibling becomes a `skipped` coverage row plus `untested` rows, never a thrown tool; **the recorded sibling name list does not contain `ow_ib_positions`** (assert against the list, so a future edit that adds it fails here).
      `tests/team-manifest.spec.ts` —

```typescript
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
    expect(manifest.tasks.find((e) => e.id === id)?.dependsOn).toContain(
      "frame",
    );
});
```

- [ ] **Step 2: Run — fail. Step 3: `quality/frame.ts`. Step 4: the tool + `VOCABULARY`.** `tools/index.ts` is large and another session has edited it — **re-locate every anchor by content immediately before editing**, and rebase on master first if the branch is over a day old.
- [ ] **Step 5: Wire the manifest. Step 6: Tenant still loads** (the `loadTenants` one-liner from Task 1 — a role naming an unknown tool skips the whole tenant with a recorded reason, and this is how you see it before a replay does).
- [ ] **Step 7:** `pnpm build && pnpm typecheck && pnpm test`
- [ ] **Step 8: Commit** — `feat(option-wizard): frame the session — channels, coverage rows, focus list and ledger — in one deterministic step`

**Ablation.** Removed the frame and let each role call the tools itself: the prompt and the audit table then disagree about what moved, which is the 2026-09-03 defect this whole design exists to close. **Kept.** Removed `declared` from the payload and re-read the tenant block in the renderer: the renderer would then need `cfg`, which it does not get. **Kept.**

**Doctrine:** 1 (the frame is what the next iteration reads back), 3 (a new step is a manifest edit), 4 (one computation, one audit).

---

## Task 9: `ow_rotation` and the weekly rotation step (section 3d)

**Files:** modify `quality/themes.ts` (add `rotationTable`), `tools/index.ts` (`ow_rotation` + `VOCABULARY`), `team.yaml`; create `tests/tools-rotation.spec.ts`; extend `tests/quality-themes.spec.ts`, `tests/team-manifest.spec.ts`.

**Why its own step.** The table needs 11 + N + 1 symbol histories that a daily run must not pay for, and **the manifest is where a phase belongs** — never the renderer (which may not learn a phase) and never the tool (which is handed `{}`).

```yaml
- id: rotation
  role: frame-clerk # requires: [] — same deterministic role
  phases: [weekly]
  dependsOn: [frame]
  requires: []
```

`frame-clerk.permissions.tools` becomes `[ow_session_frame, ow_rotation]`, and `weekly.dependsOn` gains `rotation`.

```typescript
{
  // 2026-09-06. Eleven Select Sector SPDRs plus each active theme's basket,
  // against the declared benchmark, over 5/20/60 OPEN sessions — the rank
  // order IS the rotation signal (§H.4), so it is computed here and the model
  // gets one sentence about it and no arithmetic. Symbols come from
  // extensions.review.rotation and .themes; a symbol apex cannot answer prints
  // `untested` and is NOT dropped, exactly like a coverage row.
  // Cost: 12 + N ow_apex_bars calls, weekly only — which is why this is a
  // separate step with `phases: [weekly]` rather than a field on the frame.
  name: "ow_rotation",
  description:
    "Sector and theme rotation: for each sector ETF and each active theme basket, the 1-week, 4-week and 12-week return and the excess over the benchmark, ranked by the 1-week excess. Every number is computed here from daily bars — read the ranking and say what it confirms or contradicts; compute nothing.",
  paramsSchema: NoParams,
  mutating: false,
  dshParams: {},
  async run(_args, ctx) { /* ow_apex_bars per symbol, then rotationTable */ },
}
```

```typescript
export interface RotationRow {
  symbol: string; // "XLK" or "theme:el-nino-ag-2026"
  label: string; // "XLK" or the theme id
  w1: number | null;
  w4: number | null;
  w12: number | null;
  excess1w: number | null;
  excess4w: number | null;
  excess12w: number | null;
  untested?: string;
}
export function rotationTable(args: {
  sectorEtfs: readonly string[];
  themes: readonly ThemeSpec[];
  benchmark: string;
  lookbacks: { w1: number; w4: number; w12: number };
  bars: ReadonlyMap<string, readonly Bar[]>;
  day: string;
  openDaysBack: (from: string, n: number) => string;
}): { asOf: string; benchmark: string; rows: RotationRow[]; notes: string[] };
```

Rows sort by `excess1w` descending, `null` last, ties by symbol — the same stability rule as the focus tie-break, for the same reason. The renderer prints the table as **section 3d** on the weekly only (spec §J.1), and the benchmark's own `w1/w4/w12` print as the table's footer line so a reader can see what the excess is against.

- [ ] **Step 1: Confirm every rotation symbol answers.** With `~/.config/helium/argon-local.env` sourced (it carries `OW_APEX_API_BASE`):

```bash
for s in XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY SPY DBA MOS NTR DE; do
  printf '%s ' "$s"
  curl -sS "$OW_APEX_API_BASE/v1/equity/$s/bars?timeframe=1d&start=$(date -u -v-10d +%Y-%m-%dT%H:%M:%SZ)" \
    | head -c 120; echo
done
```

Record the result in `tests/fixtures/review/README.md`. **A symbol that does not answer stays in the yaml and prints `untested` with the reason** — it is not deleted, because a silently shorter table is the coverage failure §C.2 exists to prevent. If apex is unreachable, say so in the README and mark the rotation fixture `recorded from <source>, not a live response`.

- [ ] **Step 2: Failing tests**
  - `tests/quality-themes.spec.ts`: `rotationTable` returns `sectorEtfs.length + themes.length` rows, sorted by `excess1w` with `null` last; a symbol with no bars is present with `untested` set; `notes` names it; the benchmark's own returns come back on the result, not as a row.
  - `tests/tools-rotation.spec.ts`: `paramsSchema` accepts `{}`; a throwing `ow_apex_bars` for one symbol leaves the others intact; the tool never throws.
  - `tests/team-manifest.spec.ts`:

```typescript
it("prices the rotation table once a week, in a deterministic step", () => {
  // 12 + N ow_apex_bars calls is a weekly cost, not a daily one, and the
  // MANIFEST is where that belongs: the renderer may not learn a phase and the
  // tool is handed {}.
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
```

- [ ] **Step 3: Run — fail. Step 4: write `rotationTable`, add `ow_rotation`, wire the manifest. Step 5: Run — PASS.**
- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test`
- [ ] **Step 7: Commit** — `feat(option-wizard): price the weekly sector and theme rotation table in its own deterministic step`

**Ablation.** Removed the separate `rotation` step and put the table on the frame: every daily run then pays 12+ bar calls for a table it does not print, and the frame has to learn which phase wants it — which it may not. **Kept as its own step.** Removed the benchmark footer row: the excess column then has no visible denominator. **Kept.**

> **Deviation from spec §J.2, stated so a reviewer can reject it.** §J.2 asks the daily document for a rotation table at 1d/1w. §H.4 says "one table per weekly", and a daily table costs 12+N bar calls on each of four daily runs for a ranking that moves by rounding between sessions. The weekly-only step is what ships; the daily document prints sections 3a/3b/3c and no 3d. Reopen it if a week of weeklies shows the ranking turning inside the week.

---

## Task 10: The output schemas and the budget tables

**Files:** modify `render/budget.ts`, `tests/render-flash-budget.spec.ts`; create the schema halves of `render/one-thing.ts` and `render/review.ts`, and `tests/render-one-thing.spec.ts` (schema half).

```typescript
// render/budget.ts — keyed by FIELD NAME, never by phase. The persistence caps
// are a second table chosen by the SELECTION MODE the tool reported, and the
// review caps by the TASK that emitted the document — both data, not a phase.
export const ONE_THING_BUDGET = {
  headlineWords: 14,
  oneThingWords: 180,
  changeMyMindWords: 40,
  checkWords: 15,
  checkCount: 3,
  elseLines: 5,
  elseLineWords: 12,
  rationaleWords: 25,
  proseWords: 420,
} as const;
export const PERSISTENCE_BUDGET = { oneThingWords: 90, elseLines: 3 } as const;

/** Spec §J. Defaults; the live numbers come from extensions.review.caps
 *  through the frame payload, so the tenant can move a cap without a code
 *  change. */
export const REVIEW_BUDGET = {
  weekly: {
    review: 300,
    outlook: 400,
    catalysts: 150,
    rowWords: 15,
    focusWords: 20,
    themeWords: 25,
    total: 900,
  },
  daily: {
    review: 120,
    outlook: 180,
    catalysts: 60,
    rowWords: 10,
    focusWords: 20,
    themeWords: 25,
    total: 300,
  },
} as const;

export interface Overage {
  what: string;
  words: number;
  limit: number;
  firstSentenceOver: boolean;
}
export function measureOneThing(
  doc: unknown,
  mode?: string,
): { overages: Overage[]; checkCount?: number; elseCount?: number };
export function measureReview(
  doc: unknown,
  caps: Caps,
): { overages: Overage[]; rowCount?: number; focusCount?: number };
```

**The review document the model returns** (parsed by `parseReviewDoc` in `render/review.ts`):

```
review     string  <=caps.review words. What held, what missed, and EXACTLY ONE
                   largest miss, citing the commitment id AND the receipt number
                   that killed it. May discuss ONLY ids printed in section 1.
outlook    string  <=caps.outlook words. One `why` per non-`continue` row, each with
                   the observable that settles it. May carry `PROPOSED:` lines.
catalysts  string  <=caps.catalysts words. Scheduled events that can flip a verdict.
                   May name ONLY admitted calendar rows.
coverage   array   ONE entry per row id the frame supplied, no more and no fewer:
                   { id: string,
                     token: "continue"|"reverse"|"strengthen"|"fade"|"untested",
                     p: number  (0.5..0.95; Tetlock: probability-bearing or unscorable),
                     why: string   <=caps.rowWords words,
                     observable: string  <=caps.rowWords words — what settles it }
focus      array   ONE entry per focus row you were handed, in that order:
                   { ticker: string, why: string  <=caps.focusWords words }
                   `why` = why the event matters and what would make it matter
                   more. NO direction, NO sizing, NO recommendation.
themes     array   ONE entry per ACTIVE theme id:
                   { id: string,
                     leadership: "confirms" | "contradicts" | "mixed",
                     why: string  <=caps.themeWords words }
```

No numbers field, no section titles, no as-of, no tool name: titles and every figure are renderer-supplied. **A `coverage`/`focus`/`themes` entry for an id, ticker or theme the frame did not supply is DISCARDED; a coverage row the model omitted prints `untested` and counts as a gap; a focus row it omitted prints `—` and counts in `focusWhyMissing`; a theme row it omitted prints its verdict and no leadership sentence.** A `p` outside `[0.5, 0.95]` or absent → the row keeps its token for display but mints **no commitment**, and one `view.faults` line says so — an unscorable call must not enter the ledger (spec C.5). **The verdict token for a theme does not live in `themes[]`** — a theme is a coverage row, so its token arrives through `coverage[]`, and `themes[]` carries only the §H.4 leadership sentence.

**The One Thing document** is unchanged from the merged design (`headline` ≤14 words; `oneThing` ≤180, four beats in order — what moved ≤40 · why this one, using the renderer's supplied phrase ≤25 · mechanism ≤65 · who is hurt ≤50; `changeMyMind` {text, series, threshold, horizon}; exactly 3 `checks`; ≤5 `everythingElse`; `rationales`). **The beats are ordered so the trim takes the right thing** — `trim()` cuts at the last sentence end inside the budget, so the beat that goes first is the last one. Write that sentence into the code comment; it is the whole reason for the ordering. `changeMyMind` missing any of the triple → the object is dropped and one renderer-written flag line prints; it is never padded.

- [ ] **Step 1: Failing tests** — all six One Thing fields parse with no problems; a `changeMyMind` missing `horizon` parses the rest and reports `changeMyMind: missing horizon`; `checks` of length 2 reports `checks: 2 of 3` and keeps the two; `measureOneThing` on a 260-word `oneThing` reports `{what:"oneThing", words:260, limit:180}` and `limit: 90` under `mode: "persistence"`; 7 `everythingElse` lines report `elseCount: 7`; `trim(text, 180)` on a four-beat paragraph returns text ending at the third beat's full stop with `cut: "sentence"` and **no trailing `…`**; `measureReview` with the weekly caps flags a 380-word `review` at `limit: 300` and with the daily caps at `limit: 120`; a `coverage` entry whose `why` is 22 words flags `rowWords`; a `focus` entry whose `why` is 24 words flags `focusWords`; a `themes` entry whose `why` is 30 words flags `themeWords`; `ONE_THING_BUDGET` and `REVIEW_BUDGET` contain no phase name and both `measure*` take `mode`/`caps`, never `phase`.
- [ ] **Step 2: Run — fail. Step 3: budget tables + `measureOneThing`/`measureReview`.** Leave `FLASH_BUDGET`, `words`, `trim`, `measure` in place — `quality/index.ts#budgetViolations` and the `flash-budget` gate still measure `sections` for `regime`, `scenarios` and `frank`.
- [ ] **Step 4: schema halves of `render/one-thing.ts` and `render/review.ts`. Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `feat(option-wizard): add the one-thing and review output schemas and their per-field budgets`

**Ablation.** Removed `p` from the coverage entry: `verdictBrier` is then meaningless and C.5's Tetlock gate is unenforceable — a token with no probability cannot be scored. **Kept.** Removed the `focus`/`themes` arrays and let the model write those lines into the outlook prose: the renderer then cannot bind a line to a row, and §G.4's per-name column has no source. **Kept.**
**Doctrine:** 4 (caps are arithmetic, enforced by `trim`, never by a prompt), 6 (no new gate: the trim is the enforcement).

---

## Task 11: The One Thing renderer, the fence move, and the flash-budget retarget

**Files:** modify `render/one-thing.ts` (rendering half), `render/index.ts`, `render/budget.ts` consumers, `quality/index.ts`, `gates/regime-state.ts`, `gates/flash-budget.ts`, and the tests `render-one-thing.spec.ts`, `render.spec.ts`, `render-editor.spec.ts`, `quality-metrics.spec.ts`, `gate-regime-state.spec.ts`, `gate-flash-budget.spec.ts`, `render-flash-budget.spec.ts`, `render-schema-version.spec.ts`, `brief-view-fixture.spec.ts`.

**`BriefView` gains** (and `BRIEF_VIEW_SCHEMA_VERSION` goes to **3** — Task 12 adds three more optional fields and the version stays 3, because both land in one PR):

```typescript
  /** The lead item, after trim. Absent in `no-data` mode. */
  oneThing?: { title: string; body: string; why: string; checksLine: string };
  changeMyMind?: { text: string; series: string; threshold: string; horizon: string };
  checks?: Array<{ series: string; level: string; text: string }>;
  everythingElse?: string[];
  /** Renderer-owned, outside the prose budget and outside the model's reach:
   *  coverage by layer, every source's own as-of copied, `dataDate` from
   *  ow_argon_metrics, staleSeries lags, and degradationFrom(report). */
  footer?: { coverage: string[]; asOf: string[]; notes: string[] };
  /** One line per renderer-detected authoring fault. NOT `degradation`:
   *  nothing failed. */
  faults?: string[];
```

**Channel metric rows** written per run, `null` for every excluded channel (`null` is "not computable this run" and is not zero — `packages/core/src/audit.ts` says so on `MetricRow`): `channel.rates.d10y_bp` (`r10`), `channel.rates.d2s10s_bp` (`r2s10`), `channel.policy.dprob_pp` (`pol`), `channel.credit.dhyoas_bp` (`cr`), `channel.vol.dvix_pt` (`vol`), `channel.dealer.spot_minus_flip` (`dlr`), `channel.flow.net_premium_usd` (`flw`), `channel.<id>.score` (`<id>.s`), `channel.<id>.medianSource` (`<id>.m`), `select.top.score` (`top`), `select.mode` (`mode`: 0 ratio · 1 persistence · 2 invalidation · 3 no-data), `select.streak.sessions` (`strk`), `checks.scored`/`hit`/`miss`/`notObserved` (`scd`/`hit`/`mss`/`nob`), `brief.proseWords` (`words`), `brief.invalidationComplete` (`inv`).

> **Known cosmetic cost, accepted.** `packages/cli/src/runner.ts` prints every metric as `short=value` on one `- quality:` header line; with Task 12's rows this reaches ~50 metrics, roughly 400 characters. Suppressing a row would need a `short: ""` rule in `runner.ts`, which this PR may not touch. Open it as a follow-up on the runner-owning session; do not work around it here.

**The fence moves to the editor.** `liftState` runs on every step and a later fence overwrites an earlier one, so exactly one step may emit it and it must be the last step that knows the checks. `gates/regime-state.ts` `appliesTo: ["editor"]`, comment updated to say why (the record now carries the three checks the next run scores, and only their author can write it).

**`flash-budget` retarget, and no new gate.** It keeps `appliesTo: ["editor", "regime-analyst", "weekly-analyst"]` and grows branches: a parsed document with `oneThing` is measured by `measureOneThing`; one with `review`/`coverage` by `measureReview` (caps from the frame payload in `GateCtx.toolOutputs`, defaulting to the **stricter** daily table when absent — a gate that guesses the looser limit guards nothing); one with `sections` by `measure` as before, `sectionCount` rule intact for `regime`, `scenarios` and `frank`.

**`invalidation-triple` is deliberately NOT built.** Ablation: the renderer already drops the incomplete object, already flags it in `view.faults` beside `staleness`, and already records `brief.invalidationComplete` (0/1) so a `SELECT` answers "how often did the editor skip the horizon". Nothing breaks. Under doctrine 6 that is ceremony with no caught defect behind it. Write the reasoning into the comment on `brief.invalidationComplete` so the next reader knows it was considered and rejected, not forgotten; build it only if the metric shows the field missing on more than one run in twenty.

- [ ] **Step 1: Failing tests** — `buildView` over a synthetic `RunReport` carrying a `frame` step (a `SessionFrame` in `toolOutputs`) and an `edit` step (a valid document) produces `view.oneThing.body` trimmed to 180 words, `view.oneThing.why` equal to the payload's `why` **character for character**, `view.oneThing.checksLine === checksLine(frame.checks.scored)`; `view.oneThing.title` is the fixed string `"The one thing"`, not the model's; a `changeMyMind` without `threshold` yields `view.changeMyMind === undefined` and one `view.faults` entry containing `invalidation incomplete`; `mode: "persistence"` trims to 90 words and 3 else-lines; `mode: "no-data"` produces no `view.oneThing` and `view.footer.notes` names the missing sources; `view.footer.asOf` copies each source's own string verbatim plus `dataDate` from `ow_argon_metrics` (**not** `queriedAsOf` — the 2026-09-03 defect that distinction exists for is recorded in that tool's comment); `renderReport(...).metrics` contains every row above in order with `null` for the excluded channels and `select.mode === 0` for `ratio`; `brief.proseWords` equals the sum of the trimmed field word counts. `gate-flash-budget.spec.ts`: a 250-word `oneThing` refuses with `oneThing 250 of 180`, the same under a persistence marker refuses at `of 90`, a document with none of the three shapes passes with `no sections to measure`, and a legacy `sections` document refuses exactly as it does today (copy the existing assertion unchanged — that is the regression guard for the steps that keep the old shape).
- [ ] **Step 2: Run — fail. Step 3: rendering half of `render/one-thing.ts`.** It takes `(report, view)`, calls `frameFrom(report)` and `state/checks.ts`, and returns the new fields plus the metric rows. It does **not** re-extract channels and does **not** recompute a score. Absent frame → it returns nothing and the renderer falls through to the existing path unchanged. **No filesystem write anywhere under `render/`** — the checks reach disk through the editor's fence and the runner's `liftState`.
- [ ] **Step 4: Wire `render/index.ts`** — `editorDocFrom` learns the fields via `parseOneThingDoc`; `applyEditor` lays them over the view; `enforceBudget` calls the One Thing trims and keeps `FLASH_BUDGET` for `sections`; `renderReport` concatenates `qualityMetrics({view, report})` with the channel rows; bump `BRIEF_VIEW_SCHEMA_VERSION` to 3.
- [ ] **Step 5: Retarget both gates.**
- [ ] **Step 6: Regenerate the cross-repo fixture**

```bash
HELIUM_WRITE_FIXTURE=1 pnpm vitest run --project unit plugins/option-wizard/tests/brief-view-fixture.spec.ts
git diff --stat plugins/option-wizard/contracts/brief-view-v2.fixture.json
```

- [ ] **Step 7: The phase scanner must still pass**

```bash
pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts -t "never branches on phase"
```

If it fails, the offending line is in a `render/*.ts` file and the fix is to move that logic to `quality/` or `state/` — **never to relax the scanner**.

- [ ] **Step 8:** `pnpm build && pnpm typecheck && pnpm test && pnpm vitest run --project contracts`
- [ ] **Step 9: Commit** — `feat(option-wizard): render the one-thing document, its channel metrics and the editor-owned fence`

**Doctrine:** 4, 6 (a gate considered and ablated, with the reason written down).

---

## Task 12: `render/review.ts` — the seven sections, the citation lines, the commitments, the metrics

**Files:** modify `render/review.ts` (rendering half), `render/index.ts`, `render/ledger.ts`, `quality/index.ts`; create `tests/render-review.spec.ts`.

**Interfaces**

```typescript
/** Spec C.1, verbatim. The model NEVER re-narrates one of these. */
export function citationLine(row: SettledRow): string;
//  `${id} · issued ${day} ${phase} · ${status} · said p=${p} · got ${outcome} · Brier ${score.toFixed(4)} (${min}..${max}) · bars ${hash.slice(0,8)}`
export function pendingLine(row: OpenRow): string;
//  `${id} · issued ${day} ${phase} · pending (${n} of ${deadlineBars} bars seen)`
/** A direction leg prints t1/t5 and referenceClose.value in place of `said p`. */

/** Spec §J.1's SEVEN fixed titles, in order. Sections 1/3/5/6/7 bodies are
 *  built here; 2 and 4 are the model's, trimmed. Section 3 carries four
 *  sub-blocks — 3a macro, 3b sectors, 3c themes, 3d rotation (weekly only). */
export const REVIEW_TITLES = [
  "1 · Scorecard",
  "2 · 上周复盘",
  "3 · Coverage",
  "4 · 下周展望",
  "5 · Dated catalysts",
  "6 · Focus",
  "7 · Open calls",
] as const;

export function reviewSections(args: {
  frame: SessionFrame;
  rotation: RotationResult | null; // the ow_rotation payload; null on a daily run
  doc: ReviewDoc | null;
  caps: Caps;
  period: "weekly" | "daily"; // from the emitting TASK id, never a phase
  calendarRows: Array<{
    time: string;
    type: string;
    event: string;
    forecast?: string;
    prev?: string;
    session?: "pre" | "post";
  }>;
}): {
  sections: Section[];
  faults: string[];
  gaps: number;
  citations: number;
  admitted: string[];
  notAdmitted: string[];
  focusWhyMissing: number;
  focusWhyRejected: number;
  proposed: Array<{ id: string; thesis: string; evidence: string }>;
};

/** One commitment per scorable coverage row, one per admitted focus name, plus
 *  one for the scenario base case. Fed to renderReport's existing `commitments`
 *  return — the runner stamps runId/tenant/issuedAt/deployment/variant/asOf. */
export function verdictCommitments(args: {
  frame: SessionFrame;
  doc: ReviewDoc | null;
  day: string;
  phase: string;
}): CommitmentDraft[];

export function reviewMetrics(args: {
  frame: SessionFrame;
  sections: Section[];
  gaps: number;
  citations: number;
  focus: { churn: number; whyMissing: number; whyRejected: number };
  themes: { rows: number; proposed: number };
  rotationRows: number | null;
  windows?: unknown; // the ow_review_window payload, when this run has one
}): RunMetric[];

/** `PROPOSED: <id> — <thesis> — evidence: <source>`, one per line, out of the
 *  model's section 4. A proposal is NOT a row: it mints nothing, it enters no
 *  focus score, and its id is not a coverage row id. It prints under section 4
 *  as `proposed (not scored)` so the operator can promote it by editing the
 *  yaml. This is what stops the model inventing a fresh rotation every Sunday. */
export function proposedThemes(
  outlook: string,
): Array<{ id: string; thesis: string; evidence: string }>;
const PROPOSED =
  /^PROPOSED:\s+([a-z0-9][a-z0-9-]{2,63})\s+—\s+([^—]{3,200}?)\s+—\s+evidence:\s+(.{3,200})$/u;
```

**Section bodies, all renderer-built:**

- **1 Scorecard** — zero model words.
  - Header line (Addendum A1 + C4): `<callsScored> scored of <callsScored+callsOutstanding> issued · <untested rows> not called · all <totalCommitments> calls issued since <firstCommitmentDay>; none removed`. **`callHitRate`'s denominator is the scored only** — "a call the model declined to make cannot be right or wrong", and a pending call is not a miss.
  - Metric line (§J.1): `callHitRate · verdictBrier · focusHitRate · coverageGaps · focusChurn`, each formatted or `—`.
  - One `citationLine` per `frame.ledger.settledToday`, newest first; then one `pendingLine` per `frame.ledger.open` older than today.
  - Focus line (§G.5): `focus: <hits> of <settled> names moved at least their implied move · <pending> still open`.
  - **Calibration sentence** (Addendum A3, weekly only, chosen by `period === "weekly"`): with ≥10 settled verdict receipts, `calibration: said p≈<mean p> · hit <observed rate> (<n>)`; if `observed − mean p > 0.15` append `— under-confident`, if `< −0.15` `— over-confident`. Under 10 receipts: `calibration: n=<n>, not yet scorable`. No model words.
  - `what we left out: <n> rows` — the count; the per-row reasons print under section 3 where the rows are (§J.1 asks for the list in §1 and Addendum A2 puts the reasons under §3; printing the count here and the reasons there satisfies both without printing the same lines twice).
  - Empty ledger → the single line `no call has come due yet` (an absent ledger is one coverage line, never an error).
- **3 Coverage** — `12 + |sectors| + |themes|` lines, declared order, in four sub-blocks:
  - **3a macro** (12 rows) and **3b sectors** (one per chain, appending `members: NVDA, AMD, …` and the weekly % **from the tool**, never model-recalled). Each line: `<id> — <level string> → <prior/move string> — **<token>** — <why> — settles: <observable>`.
  - **3c themes** (one per declared theme): the excess-move triple `+1.7% (1w) · +3.2% (since 2026-09-06)`, the verdict token, the `kill armed: <text>` line — and, when `killExcess` is declared and met, `kill: excess −11.4% over 60 sessions — CONDITION MET; promote a removal PR`. A theme whose evidence line carries no `tool:` prints `evidence: operator-checked`.
  - **3d rotation** (weekly only, from the `ow_rotation` payload): the ranked table plus the benchmark footer line. Absent payload → the block prints `rotation: not priced this run` and is still a block.
  - A row with no datum or no model token prints `untested` and the `why`/`observable` are the renderer's `data not printed this period`.
  - The section ends with one line per `untested` row (Addendum A2): `left out: <rowId> — <reason>`, the reason copied from `CoverageRow.untested` (tool absent / chain unknown / data stale / no bars). `coverageGaps` equals that line count.
  - **Rows are PRINTS** (Addendum C1). The verdict token is the only forecast on the row.
  - **The band prints beside the token** (Addendum A5) for rows with a numeric observable: `strengthen (>1.5x prior |Δ| = 4.65bp)`, `continue (0.5–1.5x)`, `fade (<0.5x)` — the numbers are `VERDICT_BANDS` × the stored prior magnitude, formatted by the renderer.
- **5 Dated catalysts** — the renderer prints the dated rows from `ow_uw_calendar`, and the model's ≤`caps.catalysts` words follow. **One section, never the outlook** — the 1.5/10 weekly made a CPI/FOMC four-path essay the entire outlook.
  - **Admission gate** (Addendum A4): a row prints only if it has a dated source (a `time`), a named observable (`event`), and bounded outcomes (`forecast` or `prev` present, or a scenario with an explicit base case). Rows failing this are dropped and listed as `not admitted: <event> — <missing field>`. The model's words may name **only** admitted events; a name outside the admitted set is a fault line and the paragraph is dropped. This is the fix for run-735e656b's CPI/FOMC dates with no tool source.
  - **Session alignment** (Addendum C3): each admitted row carries `session: pre|post` and the renderer prints the settlement day it implies (`settles: <day>`) — a pre-market report moves the stock that day; an after-close report moves it the next.
- **6 Focus** — `rank · TICKER · event (date, pre/post) · IV rank · implied move · our open call id · why watch`, plus a sticky flag on a carried name, plus `weights: declared prior 2026-09-06` under the table. Exactly `focus.weekly`/`focus.daily` rows, **or the row says why not**: `view.focus.shortfall` reads e.g. `3 of 5 — universe holds 3 names`. A model `why` with a `FOCUS_BANNED_PATTERNS` hit is **dropped** (the row prints `—`), one `view.faults` line names the ticker, the pattern and the excerpt, and `focusWhyRejected` counts it. A missing `why` prints `—` and counts in `focusWhyMissing`.
- **7 Open calls** — `pendingLine` per open commitment. **Zero model words. Published candidates and forecasts only; no position, size or P/L can reach this section because nothing in `SessionFrame` carries one.**

**Section 2 and 4, the model's, after trimming:**

- **2** may discuss **only** ids that appear in section 1 (spec C.3) — a body naming another id is dropped with a fault line. It must name exactly one largest miss, and that miss must cite **the commitment id and the receipt number that killed it** (Addendum C2); the renderer verifies the id is in §1 and the number equals the receipt's `got`. Under §2 the renderer adds, at zero model words: `not to quote: <rowId> — <reason>` for any row whose datum is stale (`asOf` older than the period) or whose source was a fallback (`medianSource: 1`, or a `series` fallback). Metric `staleRowsQuoted` counts §2/§4 sentences that quote a stale row; target 0.
- **4** may not restate a print (Addendum C1): a §4 paragraph containing a level string that appears in §3 is a fault line. It carries one `why` per non-`continue` verdict, one leadership sentence per theme (from `doc.themes[]`), and any `PROPOSED:` lines, printed under `proposed (not scored)`. A proposal whose id collides with a declared theme is dropped with a fault line (it is not a proposal, it is a re-narration of a row). Proposal words count inside §4's cap — they are the model's words.

**Verdict commitment payload** (opaque to core, read by `eval/verdict.ts`):

```typescript
{
  kind: "coverage-verdict",
  evaluator: "verdict-v0",
  rowId: "rates.front",
  series: "DGS2",
  unit: "bp",
  token: "reverse",
  p: 0.7,
  observed: { value: 4.374, prior: 4.33, delta: 0.044, asOf: "2026-09-04T20:15:00Z" },
  /** Trading days after the issue day before this may be settled — the cadence,
   *  made explicit so a mid-week daily run cannot close a weekly verdict early. */
  settleAfterOpenDays: 5,
}
```

Ids: `${day}-${phase}-verdict-${rowId}` (the phase is in the id because `design`/`review` run at both premarket and close, and `render/index.ts` records what happened the last time an id did not say which run minted it). `untested` rows and rows with an out-of-range `p` mint **nothing** — a row with no observation is not a forecast. A **theme row mints the same kind** with `rowId: "theme:<id>"` and `unit: "%"`. The scenario base case mints `${day}-${phase}-scenario-base` with `{kind:"scenario-base-case", evaluator:"verdict-v0", path, p, observable}` and a `settleAfterOpenDays` **derived from the catalyst's session-aligned settlement day** (Addendum C3), not a constant.

**Focus-admit commitment payload** (§G.5; opaque to core, read by the focus settler):

```typescript
{
  kind: "focus-admit",
  evaluator: "focus-v0",
  ticker: "NVDA",
  admittedFor: { kind: "earnings", day: "2026-11-18", session: "post",
                 source: "ow_uw_earnings", label: "Q3 earnings (post)" },
  /** The event window: the open session before the event through the open
   *  session after it. `session: "post"` shifts the end one day — a report
   *  after the close moves the stock the NEXT session (Addendum C3). */
  window: { fromDay: "2026-11-17", toDay: "2026-11-19", openDays: 2 },
  /** PERCENT, and the claim is |realized move| >= this. ow_uw_iv_term keeps
   *  `implied_move_perc` and DROPS the absolute `implied_move` (tools/index.ts,
   *  ow_uw_iv_term, verified 2026-09-03), so the claim is written in percent
   *  and never needs a price to be read back. */
  threshold: { pct: 4.6,
    source: "ow_uw_iv_term implied_move_perc, expiry 2026-11-20, dte 5" },
  p: 0.5,
  settleAfterOpenDays: 2,
}
```

Ids: `${day}-${phase}-focus-${ticker}`. **The threshold fallback, stated because §G.5's own suggestion does not exist.** When `ow_uw_iv_term` returned no row whose `expiry >= window.toDay` — a skipped sibling, a name with no listed options, or the 3-ticker cap — the threshold is computed at MINT time from `ow_apex_bars` by `realizedThreshold` (Task 13) and the payload records `source: "fallback: median |2-session return| over the prior 60 sessions, ow_apex_bars"`. When neither is available the name is still on the list and **no commitment is minted** — one `view.faults` line says `focus NVDA: no implied or realized threshold; admitted but not scorable`. A name already carried from a still-open commitment mints **no second commitment** for the same event (the ledger is append-only, and re-admitting the same event under a new id would double-count `focusHitRate`).

**`BriefView` gains three optional fields** (extending Task 11's v3 — _not_ a fourth version and _not_ a fork; both land in the same PR, so `BRIEF_VIEW_SCHEMA_VERSION` stays at **3** and the cross-repo fixture is regenerated once more here):

```typescript
  /** §G. The list this run printed, already trimmed and already filtered.
   *  `period` is which list it is — from the emitting TASK id, never a phase. */
  focus?: {
    period: "weekly" | "daily";
    rows: Array<{ ticker: string; event: string; why: string; ivRank?: number; openCall?: string; sticky?: boolean }>;
    /** Present only when fewer rows than declared were available — §G.4's
     *  "exactly 15 / exactly 5 rows, or the row says why not". */
    shortfall?: string;
    churn: number;
  };
  /** §H. One entry per declared theme, in declared order. */
  themes?: Array<{
    id: string; token: string; excess1w: string; excessSinceEntered: string;
    leadership?: string; why?: string; kill: string; killMet: boolean;
  }>;
  /** §H.4. Weekly only. */
  rotation?: { asOf: string; benchmark: string; rows: RotationRow[] };
```

> **argon needs no change, and that is deliberate.** `SectionsPanel` renders `view.sections` generically, so all seven sections reach the public page as ordinary sections the day this ships. The three structured fields are carried **in addition**, for a future argon component that wants a real table — they are additive and optional, so argon's `flashHeliumFixture.test.tsx` keeps passing on `schemaVersion: 3`. Do not make the page depend on them in this PR.

**Metric rows** (spec §F + §G/§H; `short` in brackets): `callsScored` [`cs`], `callsOutstanding` [`co`], `callHitRate` [`chr`] plus `callHitRate.w5`/`.w10`/`.w21` [`chr5`/`chr10`/`chr21`] when `ow_review_window` ran, `verdictBrier` [`vb`] = the mean of this run's settled verdict receipts' `verdictBrier` scores, `coverageGaps` [`gaps`] = the count of `untested` rows, `reviewModelWords` [`rw`] plus `reviewModelWords.s2`/`.s3`/`.s4`, `ledgerCitationCount` [`cite`], `staleRowsQuoted` [`sq`], `focusHitRate` [`fhr`], `focusChurn` [`fch`], `focusWhyRejected` [`fwr`], `focusWhyMissing` [`fwm`], `themeRows` [`thr`], `themesProposed` [`thp`], `rotationRows` [`rot`]. **`null`, not `0`, where a source was absent.**

> **Deviation from spec §F, stated so a reviewer can reject it:** §F asks for `verdictBrier` labelled by coverage row id and `callHitRate` by window. The `metric` table's PK is `(run_id, name)` and its `label` column is written by the runner as the run's phase — a tenant cannot use it. So the run **aggregate** is written under the exact name §F's "one query" selects, and the **per-row detail lives in the receipt** (`scores.verdictBrier`, `detail.rowId`), which is where `helium scoreboard` already aggregates by key. Nothing is lost and no core edit is needed. **Accepted.**

> **§J.1's footer** asks for `tokens in/out · model per role · cost · wall time`. Before writing it, **verify what `RunReport`'s step records actually carry** (`node -e` over a recorded report under `$S/pit/*/runs/*/report.json`); print exactly the fields that exist and nothing else, and record in the evidence README which of the four were unavailable. Do not compute or estimate a cost that the report does not carry.

- [ ] **Step 1: Failing tests** (`tests/render-review.spec.ts`, over a seeded ledger and the Task 2 fixtures):
  - `reviewSections` returns **exactly seven sections, in `REVIEW_TITLES` order**, on every input including an empty frame.
  - Section 3 has `frame.declared.coverage.length + sectors.length + themes.length` lines with a fully-populated frame **and the same number** with an empty one; with an empty one every row reads `untested`, `gaps` equals that count, and there is one `left out:` line per row.
  - Section 3d is present on `period: "weekly"` with a rotation payload and **absent** on `period: "daily"`.
  - `citationLine` renders character-for-character from a seeded receipt, including the 8-character sha prefix; a pending row uses the second form; a `spy-direction` leg prints `t1`/`t5` and `referenceClose.value` in place of `said p`.
  - **A1:** the §1 header with 3 hit / 1 miss / 2 pending prints `callHitRate` 0.75, never 0.5, and names the untested count.
  - **A3:** a ledger with 12 settled verdict receipts whose mean `p` is 0.70 and observed rate 0.55 prints `over-confident`; with 4 receipts prints `n=4, not yet scorable`.
  - **A4:** a calendar payload with an undated row → the row is not printed, a `not admitted` line is present, and a model paragraph naming it is dropped with a fault.
  - **A5:** a row with prior −3.1bp and token `strengthen` prints `>4.65bp`.
  - **C1:** a §4 paragraph containing a level string that appears in §3 produces a fault line.
  - **C2:** a §2 body whose largest miss cites an id not in §1 is dropped with a fault; a stale row produces a `not to quote:` line and `staleRowsQuoted` counts a §2 sentence quoting it.
  - **C3:** a post-close AVGO calendar row dated 2026-09-02 prints `settles: 2026-09-03`, and the scenario base-case draft's `settleAfterOpenDays` is derived from that day.
  - Section 2's body is dropped and one fault line printed when it names an id **not** in section 1 (spec C.3).
  - `verdictCommitments` mints one draft per scorable row and **none** for an `untested` row or a row with `p: 0.3`; ids match `${day}-${phase}-verdict-${rowId}`; a theme row mints one `coverage-verdict` with `rowId: "theme:el-nino-ag-2026"`.
  - a frame with 15 focus rows mints 15 `focus-admit` drafts with ids `${day}-${phase}-focus-${ticker}`; a row with no threshold mints none and adds exactly one `faults` line; a name carried from a still-open commitment mints no second one.
  - `proposedThemes` parses the spec's exact line shape, returns `[]` from prose with no such line, and drops a proposal whose id collides with a declared theme.
  - a `focus` entry for an unknown ticker is discarded; a 24-word `why` is flagged by `measureReview` and trimmed; a `why` containing `"bullish"` is dropped, `view.faults` names the ticker and the pattern, and `focusWhyRejected === 1`; a missing entry prints `—` and counts in `focusWhyMissing`; `view.focus.rows.length === 15` on the `weekly` task and `5` on `edit`; with a universe of 3 names `view.focus.shortfall` reads `3 of 5 — universe holds 3 names` and the section still prints.
  - a `themes` entry for an inactive id is discarded; `view.themes.length` equals the declared theme count on every input, including an empty model reply.
  - `reviewMetrics` returns every name above; `coverageGaps` equals the untested count; `ledgerCitationCount` equals section 1's citation-line count; `rotationRows` is `null` on a daily run.
  - **Privacy:** the rendered seven sections, serialised, contain none of the strings `position`, `net liq`, `buying power`, `quantity`, `P/L`, and no numeric field sourced from a positions payload — asserted by feeding a frame plus a report whose `toolOutputs` includes an `ow_ib_positions`-shaped payload and asserting no ticker unique to it appears.
- [ ] **Step 2: Run — fail. Step 3: write the rendering half. Step 4: wire `render/index.ts`** — `sectionsFrom` gains the review sections when `frameFrom(report)` is non-null and the emitting step is `weekly` (weekly caps, `period: "weekly"`, rotation payload) or `edit` (daily caps, `period: "daily"`, no rotation); `renderReport` concatenates `verdictCommitments(...)` onto the existing `forecastCommitments(...)` and `reviewMetrics(...)` onto `metrics`.
- [ ] **Step 5: Regenerate the cross-repo fixture** (the three new view fields):

```bash
HELIUM_WRITE_FIXTURE=1 pnpm vitest run --project unit plugins/option-wizard/tests/brief-view-fixture.spec.ts
git diff --stat plugins/option-wizard/contracts/brief-view-v2.fixture.json   # schemaVersion stays 3
```

- [ ] **Step 6:** the phase scanner again, then `pnpm build && pnpm typecheck && pnpm test && pnpm vitest run --project contracts`.
- [ ] **Step 7: Commit** — `feat(option-wizard): print the seven review sections from the ledger, the frame and the rotation table`

**Ablation.** Removed the three `BriefView` fields and shipped sections only: the page renders identically today, and a future argon table has no data to bind to; the cost of keeping them is three optional fields and one fixture regeneration in the same PR. **Kept, and flagged as the one speculative item here** — delete them if the reviewer disagrees and nothing else changes. Removed `focus.shortfall` and printed 3 rows silently: §G.4's "exactly 15 / exactly 5, or the row says why not" is then unenforceable. **Kept.** Removed the separate section 8 for rotation and folded it into section 3 as 3d: §J.1 numbers it that way and a reader gets one Coverage section instead of two tables in different places. **Folded — this is the change from the superseded plan.**

**Doctrine:** 1 (the loop: this week's verdicts are next week's scorecard), 4 (every figure rendered; every count a metric row), 2 (nothing under `packages/core/src`).

---

## Task 13: `eval/verdict.ts` — the settlers that score a verdict and a focus admission

**Files:** create `eval/verdict.ts`, `tests/eval-verdict.spec.ts`, `tests/eval-focus.spec.ts`; modify `eval/settle.ts`, `tests/eval-settle.spec.ts`.

**Interfaces**

```typescript
/** How a stored verdict is judged against the NEXT dated observation of the
 *  same row. Bands, not opinions — and they live here rather than in a prompt
 *  because a token whose meaning the model could argue with is not scorable.
 *  continue   : same sign, 0.5x..1.5x the prior magnitude
 *  strengthen : same sign, >1.5x       (Frank's word is "accelerate")
 *  fade       : same sign, <0.5x, trending to nil
 *  reverse    : the sign flipped
 *  A |delta| under NIL_FRACTION of the prior magnitude has no sign at all and
 *  realises as `fade`, never as `reverse` — a rounding-sized wiggle is not a
 *  turn. */
export const VERDICT_BANDS = {
  continueLow: 0.5,
  continueHigh: 1.5,
  nilFraction: 0.1,
} as const;
export function classify(
  prior: number,
  next: number,
): Exclude<VerdictToken, "untested">;

/** Settled against the ledger itself: the NEWEST commitment for the same rowId
 *  issued strictly after this one carries the next dated observation. No new
 *  storage, no network, no clock — the record we already keep is the evidence. */
export function settleVerdict(args: {
  commitment: Commitment;
  later: readonly Commitment[];
  now: Date;
  calendar?: TenantCalendar;
}): Receipt;

/** §G.5. Unlike a verdict, this one IS bar-backed. */
export async function settleFocus(args: {
  commitment: Commitment;
  now: Date;
  source: BarSource;
  calendar?: TenantCalendar;
}): Promise<Receipt>;

/** The median |n-open-session close-to-close return| over the prior 60
 *  sessions, in percent. A DEFINED statistic over real bars, not a guess: it
 *  is the same horizon as the window, so "moved more than usual" means the
 *  same thing under both thresholds. `ow_price_structure` — which §G.5 names —
 *  holds no price series at all (it is expiry payoff arithmetic over legs and
 *  their NBBO mids), so it cannot answer this and is not used. Returns null
 *  from fewer than openDays + 1 bars. */
export function realizedThreshold(
  bars: readonly Bar[],
  openDays: number,
): number | null;
```

**Verdict receipt:** `status` = the realised token; `scores: { verdictBrier: binaryBrier(p, realised === token ? 1 : 0) }` — reusing `binaryBrier` already in `eval/settle.ts`; `evidenceHash` = sha256 of `${rowId}|${issuedObserved}|${laterObserved}`; `detail = { rowId, said: token, got: realised, from: {day,phase}, to: {day,phase}, prior, next }`. `pending(...)` with a reason when: no later commitment exists (`"no later observation of rates.front yet"`), or fewer than `settleAfterOpenDays` open days have passed (`"settles after 5 open days; 2 seen"`).

**Focus receipt:** daily bars for `[priorOpenDay(window.fromDay), window.toDay]`; anchor = the last close on or before `window.fromDay`; end = the close on `window.toDay`. Either missing → `pending("no daily bar for NVDA on 2026-11-19 yet")`. Then `movePct = (end.close / anchor.close - 1) * 100`; `hit = Math.abs(movePct) >= threshold.pct`; `status = hit ? "hit" : "miss"`; `scores = { focusBrier: binaryBrier(p, hit ? 1 : 0) }`; `detail = { ticker, admittedFor, movePct, thresholdPct, thresholdSource, anchor: {...}, end: {...} }`; `evidenceHash = hashBars(used)` — `hashBars` is currently module-private in `eval/settle.ts` and is **exported** (one word) rather than reimplemented, so two settlers cannot disagree about what a bar hash is.

**Wiring** in `settleAll`: one `else if (kind === "coverage-verdict")` calling `settleVerdict` with the ledger's own later commitments, one for `"scenario-base-case"` (same shape, `p` against the observable's realised token), and one for `"focus-admit"` calling `settleFocus`. `buildSettler` reads the ledger once per settle call via `readLedger(cfg.stateRoot, "option-wizard")` — a literal import; `@helium/core` is a real dependency (`plugins/option-wizard/package.json`). **A kind this build does not know is still left alone, not settled** — the existing comment stands.

**The `OW_APEX_API_BASE` guard narrows.** It moves from the top of `settle` to the **bar-backed kinds only**: `spy-direction` and `focus-admit` need bars and stay inside it; `coverage-verdict` and `scenario-base-case` settle from the ledger and do not. A test asserts exactly that split, because the current early return would otherwise pend everything.

> **Departure, stated for review.** Spec C.4 says close scores that morning's premarket verdicts. The runner settles **before** the DAG and renders **after** it, so at a close run the freshest stored observation of a row is the intraday run's, not the close's. The receipt therefore names the observation it used (`detail.to = {day,label}`) and the scorecard prints it. The alternative — a settler that fetches its own market data — duplicates the renderer's extraction, adds six network calls per run, and buys three hours of freshness. Rejected under doctrine 6; reopen it if a review shows the intraday observation changing a verdict's class.

- [ ] **Step 1: Failing tests** (real numbers only).

`tests/eval-verdict.spec.ts`: `classify(-3.1, +4.4)` → `"reverse"`; `classify(-3.1, -3.0)` → `"continue"`; `classify(-3.1, -0.2)` → `"fade"`; `classify(-3.1, -9.0)` → `"strengthen"`; `classify(-3.1, -0.05)` → `"fade"` (under the nil fraction, no sign); a verdict `token:"reverse", p:0.7` whose realised class is `reverse` → `status:"reverse"`, `scores.verdictBrier === 0.09` (`(0.7-1)²`); the same said `continue` → `0.49`; no later commitment → `status:"pending"` with the reason naming the row; a later commitment only two open days out with `settleAfterOpenDays: 5` → pending with `"2 seen"`; two settles of the same commitment produce the same `evidenceHash`; `settleAll` leaves an unknown kind untouched (extend the existing assertion in `eval-settle.spec.ts`).

`tests/eval-focus.spec.ts` (`fixtureBarSource` from `eval/bars.ts`, real closes from the fixture README — SPY 773.17 on 2026-09-03 and 770.19 on 2026-09-04, a −0.3854% two-day move):

- a `focus-admit` on SPY with `threshold.pct: 0.25` over `2026-09-03..09-04` settles `"hit"` with `detail.movePct` ≈ −0.3854 and `scores.focusBrier === 0.25` at `p: 0.5`; the same with `threshold.pct: 1.0` settles `"miss"`, also `0.25`.
- a window whose `toDay` has no bar yet → `pending` with the reason naming the ticker and the day; a window whose anchor is missing → `pending`, never a miss.
- two settles produce the same `evidenceHash`.
- `realizedThreshold` over 60 real daily closes returns a finite percent, and returns `null` from fewer than `openDays + 1` bars.
- **the guard split, in one test:** `settleAll` with `OW_APEX_API_BASE` unset pends a `focus-admit` (it needs bars) while still settling a `coverage-verdict` (it does not).

- [ ] **Step 2: Run — fail. Step 3: write `eval/verdict.ts` (both settlers + `realizedThreshold`). Step 4: export `hashBars`, wire `settleAll` and `buildSettler`, narrow the `OW_APEX_API_BASE` guard.**
- [ ] **Step 5:** `pnpm vitest run --project unit plugins/option-wizard/tests/eval-verdict.spec.ts plugins/option-wizard/tests/eval-focus.spec.ts plugins/option-wizard/tests/eval-settle.spec.ts` then the full suite.
- [ ] **Step 6: Commit** — `feat(option-wizard): settle a coverage verdict against the next dated observation and a focus admission against its own implied move`

**Ablation.** Removed the focus commitment and printed the list unscored: nothing breaks in the document, and §I.6's re-weighting loses its only input — the weights stay a declared prior forever and the user's "methodology, not 拍脑袋" has no way to be checked. **Kept.** Removed the realized fallback and pended every name with no IV term row: on the recorded laptop replays that is most of them, so the metric would read `null` for weeks. **Kept.** Removed `settleAfterOpenDays` and settled on the first later bar: a post-close event would settle on the same session it was announced. **Kept.** Removed the theme-specific commitment kind and reused `coverage-verdict`: nothing broke — the settler, the bands, the Brier and the scorecard all work unchanged. **Cut before it was written, and that is why §H.2 costs no settler code.** Removed a settler that fetches its own market data: three hours of freshness on a daily verdict, at six network calls per run and a duplicated extraction. **Cut.**

**Doctrine:** 4 (the LLM asserts, the code scores), 1 (the receipt is what the next iteration measures and what re-weights the focus score next quarter), 6 (no new store, no new gate — `else if` branches and one export).

---

## Task 14: `ow_review_window` — fix the "not written" defect, and feed the counters

**Files:** modify `tools/index.ts`, `tests/tools-review-window.spec.ts`.

**The defect, from spec §E, fixed first.** `ow_review_window` builds a session from `stateRoot/option-wizard/<day>/*.json` regime-state records, which only began being written in PR #92. For every earlier day the directory is absent, and `week-reviewer`'s rule "a window whose sessions are empty is reported as empty" turned that into the 2026-09-06 weekly's claim that 20 of 21 sessions were "not written" — while the reports for those days sit on disk. Two changes:

1. **Session existence is decided by the report file**, not by the state directory: a day with any `option-wizard-<day>-<label>.md` is a session that happened.
2. **A missing regime-state block reports as `regime: "unavailable"`**, never as a missing session. Replace the silent `catch` (whose comment currently reads "No records for that day. The empty object says so.") with an explicit `{ regime: "unavailable", reason }` per label, and put the defect's date and consequence in the comment so it is not re-introduced.

**Counters added per window** (a fold over what the loop already has — `measured.rows` from `qualityByDay` and the per-day regime records; **do not add a second audit query**):

```typescript
counters: {
  sessionsWithReport: number;
  sessionsWithRegime: number;         // <= sessionsWithReport, by construction
  checks: { hit: number; miss: number; notObserved: number; scored: number };
  oneThingHitRate: { leaderStillTopAt1: number; leaderStillTopAt3: number; of: number };
  modeHistogram: Record<"ratio" | "persistence" | "invalidation" | "no-data", number>;
  budgetViolations: number;
  coverageGaps: number;
  verdicts: { settled: number; meanBrier: number | null; byToken: Record<VerdictToken, number> };
  focus: { churn: number; hitRate: number | null; whyRejected: number };
  calls: { scored: number; outstanding: number; hitRate: number | null };
  pnl?: unknown;                      // 21-day window ONLY, and only with a ledger
}
```

`counters.pnl` is **absent** from the 5- and 10-day windows — process review and P/L review are different documents, and mixing them anchors judgement to outcome. Divergence-pair wins are not counted; channel 7 does not exist. The ledger read for `verdicts`/`calls`/`focus` uses `readLedger` **literally** (it is a real dependency now); the `cliSpecifier` indirection for `summarise` stays exactly as it is with its comment — `@helium/cli` is still not a dependency of this tenant.

- [ ] **Step 1: Failing tests** — with a temp `HELIUM_AUDIT_DB`, three days of report files and only ONE day of `<day>/<label>.regime.json`: all three days report as sessions, two report `regime: "unavailable"`, and **no session is reported as "not written"**; `counters.checks` sums the stored `checks.*` metric rows; `modeHistogram` counts `select.mode` 0–3 by name; `counters.focus.churn` sums the stored `focusChurn` rows; `counters.pnl` is absent from the 5- and 10-day windows and present (as `null` with no ledger) on the 21-day one — assert the **absence** explicitly; a missing ledger yields exactly one `coverage` string containing `ledger scoreboard unavailable` and three windows still return; `counters` never contains a `divergence` key.
- [ ] **Step 2: Run — fail. Step 3: fix the defect. Step 4: add the counters. Step 5:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 6: Commit** — `fix(option-wizard): a missing regime record is an unavailable block, not a missing session`

**Ablation.** Removed the counters and let `week-reviewer` write its own page: it then produces a rival document to the one this PR builds, which is exactly what spec §E rejects. **Cut the second page; kept the counters.**
**Doctrine:** 4 (the counters are the queryable answer), 6 (one fold over data already in hand; no second query, no new page).

---

## Task 15: Personas and prompts — rewritten, measured, not eyeballed

**Files:** modify `team.yaml` (`regime-analyst`, `editor`, `weekly-analyst`, `week-reviewer`, `scenario-analyst` personas; `edit`, `weekly`, `week-review`, `scenarios` prompts), `tests/team-manifest.spec.ts`.

**These are REWRITES, not appends.** Each persona is written from scratch and measured.

- **`weekly-analyst`** (spec §E). Tools become `[ow_reports, ow_session_frame, ow_rotation]`. It must say: section 1 is printed for you from the ledger and you may not settle anything that is not in it; write section 2 in ≤300 words naming **exactly one largest miss**, citing the commitment id and the receipt number that killed it (a week with no loser was not read carefully — Frank's discipline); write section 4 as the _why_ behind each non-`continue` verdict, one observable each, and never restate a level that section 3 already printed; give every coverage row you were handed exactly one token from `[continue, reverse, strengthen, fade, untested]`, one ≤15-word clause and one probability 0.50–0.95 — a token without a probability cannot be scored and will not be stored. It must **no longer** say: "settle each of the week's numbered calls by name" (the renderer does that), or "下周展望 — next week's A/B/C/D with an explicit base case" (A/B/C/D moves to section 5, bounded).
- **`week-reviewer`** (spec §E(a)): the counters are given to you; answer the ONE question for this window; cite settled calls only by the renderer's line; a missing regime block is `regime: unavailable`, **never** a session that was not written. Must no longer compute, average or mix P/L into the 5- and 10-day windows; 5-day question _which channel did I keep over-reading, and which did I keep missing?_ (≤200 w), 10-day _did the regime change, and did I say so before or after it changed?_ (≤250 w), 21-day outcome, the only window with P/L, printed **beside** the process stats, never below them (≤250 w), and under 30 closed trades it prints `sample too small to score edge` in place of a verdict.
- **`scenario-analyst`** (spec §E): **kept and demoted.** Its A/B/C/D with a transmission order was the one good part of the 2026-09-06 weekly. It now produces **section 5 only**, ≤150 words, and flags exactly one **my base case** — which is minted as a commitment (Task 12) and scored next week. It may name only admitted calendar events.
- **`regime-analyst`**: name the cause; cite a verbatim headline (`cause-citation` still checks it); copy every number; you are handed a ranked list and you may not re-rank. Must **no longer** say: the four-tag menu CAUSE/DIVERGENCE/REACTION FUNCTION/BEAT-AND-RAISE; "The 2Y/10Y levels … are a MANDATORY datapoint here every day" (it guarantees rates prose on days rates did nothing, and it produced "Rates are the story"); "At most FIVE sections … choose the five that matter"; the Layer Coverage paragraph (it moves to the footer, and it is the direct cause of the recurring `meta-leak` refusals); the uniform 60-word cap; the `regime-state` fence paragraph (the fence moves to the editor).
- **`editor`**: write about **row 1** of the ranked list and do not re-rank; open by copying the supplied `Yesterday: …` line; `changeMyMind` needs `series` + `threshold` + `horizon` or the section is dropped; the per-field caps; the daily review document is the same seven sections at the daily caps, one phase behind; end with the `regime-state` fence carrying `cause`, the rate levels, `tide`, `thesis`, your three `checks` and your `invalidation`. Must **no longer** say "Say what CHANGED, not what IS" without a supplied delta — replace with "the delta is handed to you, in the `move` field; copy it" — nor "choose the five that matter", nor anything about coverage/as-of, nor the flat 60-word cap, nor the ~2.5 K-character STYLE EXEMPLAR of the five-section brief this PR deletes (replace it with the blueprint from `brief-craft.md` section (e), quoted for SHAPE only, with the same "its numbers belong to that day" warning).

**`weekly-analyst` and `editor` both gain, verbatim** (§G/§H's entire model share):

- `You are handed a focus list. For each name write ONE line of at most 20 words: what the dated event is and what would make it matter more. Never a direction, never a size, never a recommendation, never a price target — a line containing one is dropped and the row prints empty.`
- `For each active theme you are handed, say in at most 25 words whether this week's sector leadership confirms it, contradicts it, or is mixed. You may propose a NEW theme with exactly one line of the form "PROPOSED: <id> — <thesis> — evidence: <source>"; a proposal is not a row and is not scored, and the operator promotes it by editing the manifest.`
- `You may not re-rank the focus list, add a name to it, or drop one. The numbers beside each name are already computed.`

- [ ] **Step 1: Failing tests** in `team-manifest.spec.ts`:

```typescript
it("every persona fits the 4000-character cap with room to spare", () => {
  // packages/core/src/team.ts: persona: z.string().max(4000). Measured, not
  // eyeballed: the 2026-09-05 rewrite came within 580 characters of the cap.
  for (const [name, role] of Object.entries(manifest.roles))
    expect((role.persona ?? "").length, name).toBeLessThan(3800);
});

it("no persona or prompt still asks for the deleted formats", () => {
  const text = [
    ...Object.values(manifest.roles).map((r) => r.persona ?? ""),
    ...manifest.tasks.map((t) => t.prompt ?? ""),
  ].join("\n");
  for (const gone of [
    "choose the five that matter",
    "At most FIVE sections",
    "Layer Coverage",
    "MANDATORY datapoint",
    "BEAT-AND-RAISE",
    "Say what CHANGED",
    "settle each of the week's numbered calls by name",
  ])
    expect(text, gone).not.toContain(gone);
});

it("exactly one role is asked for the regime-state fence, and it is the editor", () => {
  // liftState runs on EVERY step and a later fence overwrites an earlier one.
  const authors = Object.entries(manifest.roles)
    .filter(([, role]) => (role.persona ?? "").includes("regime-state"))
    .map(([name]) => name);
  expect(authors).toEqual(["editor"]);
});

it("the review author is bound to the ledger and to one largest miss", () => {
  const persona = manifest.roles["weekly-analyst"]?.persona ?? "";
  expect(persona).toContain("exactly one");
  expect(persona).toContain("ow_session_frame");
  expect(manifest.roles["weekly-analyst"]?.permissions.tools).toContain(
    "ow_session_frame",
  );
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
    const prompt = manifest.tasks.find((t) => t.id === id)?.prompt ?? "";
    expect(prompt, id).toContain("at most 20 words");
    expect(prompt, id).toContain("never a direction");
    expect(prompt, id).toContain("PROPOSED:");
  }
});
```

The Addendum B wording rule from Task 5 must still pass: the new lines say `size` and `position` **inside a ban sentence**, and the assertion skips any line containing `never` for exactly that reason. Leave that narrowing as a comment in the test — it is the only reason the two rules coexist.

- [ ] **Step 2: Run — fail. Step 3: rewrite. Step 4: measure**

```bash
node -e "
const {parse}=require('yaml');const fs=require('fs');
const m=parse(fs.readFileSync('plugins/option-wizard/team.yaml','utf8'));
for(const [k,v] of Object.entries(m.roles)) console.log(String((v.persona??'').length).padStart(5), k);
for(const t of m.tasks) console.log(String((t.prompt??'').length).padStart(5), 'prompt:'+t.id);
"
```

Every persona under 3800; every prompt under 20000.

- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm test`
- [ ] **Step 6: Commit** — `refactor(option-wizard): bind the review authors to the ledger, the fixed coverage list and the computed focus list`

**Ablation.** Removed the rewrite and appended the new rules to the existing personas: the persona then carries both "choose the five that matter" and "print every row", and the model obeys whichever it read last. **Rewrite kept.**
**Doctrine:** 2 (all business language stays in the tenant manifest), 6 (rules deleted, not stacked).

---

## Task 16: Acceptance — the weekly through the pit runner, on the local argon

**Files:** create `docs/evidence/pit-replays/2026-09-06/README.md` and `review-v1/`.

- [ ] **Step 1: Point the runner at this worktree.** `$S/run-pit.sh` `cd`s to `/Users/chenxi/projects/helium` and runs `node packages/cli/lib/cli.js run option-wizard --phase <phase> [--as-of …] --variant <v>`, sourcing `$S/helium-nomail.env` and `~/.config/helium/argon-local.env`, setting `HELIUM_TENANT_DELIVERY=1`, `HELIUM_STATE_ROOT=$S/pit/<variant>`, `HELIUM_AUDIT_DB=$S/pit/<variant>/audit.db`, `HELIUM_RENDER_DUMP=…`. **`weekly` takes no `--as-of`** — it runs live tools. Copy and repoint it at the worktree:

```bash
S=/private/tmp/claude-501/-Users-chenxi-projects-helium/04ed705b-a291-45d0-ac8f-dd2433903e9f/scratchpad
sed 's#^cd /Users/chenxi/projects/helium$#cd /Users/chenxi/projects/helium/.worktrees/review-framework#' \
  "$S/run-pit.sh" > "$S/run-pit-review.sh" && chmod +x "$S/run-pit-review.sh"
```

Delivery is markdown plus the **local** argon; `HELIUM_DEPLOYMENT` is unset, so any subject that did go out would carry the `[TEST] ` prefix.

- [ ] **Step 2: Build, then seed one settleable period, then run the weekly — detached**

```bash
cd /Users/chenxi/projects/helium/.worktrees/review-framework
rm -f plugins/option-wizard/tsconfig.tsbuildinfo && pnpm build
# a prior period so the scorecard has something to settle; same state root
"$S/run-pit-review.sh" 2026-09-04 close review-v1
"$S/run-pit-review.sh" 2026-09-06 weekly review-v1
```

Run each **detached** (background) and poll the log; a weekly run is minutes, not seconds.

- [ ] **Step 3: Confirm the report reached the local argon page — HTTP 200**

```bash
set -a; source ~/.config/helium/argon-local.env; set +a
node -e "const {flashUrl}=require('./plugins/option-wizard/lib/render/week.js');
         console.log(flashUrl(process.env.ARGON_APP_BASE ?? '', '2026-09-06', 'weekly'))"
curl -sS -o /dev/null -w '%{http_code}\n' "<the printed URL>"
```

Expect `200`. A non-200 is a failed acceptance, not a note.

- [ ] **Step 4: Paste the audit header and the metric table**

```bash
V=$S/pit/review-v1
grep -n '^- quality:' "$V/reports/option-wizard-2026-09-06-weekly.md"
sqlite3 "$V/audit.db" "SELECT day,label,name,value FROM metric ORDER BY day,label,name;"
sqlite3 "$V/audit.db" "SELECT name, avg(value) FROM metric WHERE name IN
 ('callHitRate','verdictBrier','coverageGaps','reviewModelWords','focusHitRate','focusChurn') GROUP BY name;"
node -e "const {readLedger}=require('./packages/core/lib/ledger.js');
  const r=readLedger(process.env.V,'option-wizard');
  console.log(r.commitments.length,'commitments',r.receipts.length,'receipts')" V="$V"
```

**The acceptance bar, all of it — fourteen bullets. A bullet that could not be checked is recorded as blocked, never omitted.**

1. **Every §J.1 section is present**, in order, with the seven fixed titles, on both documents.
2. **Coverage rows = `12 + |extensions.review.sectors| + |extensions.review.themes|`** (23 with the shipped declaration), in declared order, on both the weekly and the 09-04 close document. Count them out of the rendered markdown, not out of a variable.
3. **Model words within caps:** `reviewModelWords` ≤ 900 on the weekly and ≤ 300 on the close; `reviewModelWords.s2` ≤ 300 / ≤ 120; `.s4` ≤ 400 / ≤ 180.
4. **Metric rows written:** `callsScored`, `callsOutstanding`, `callHitRate`, `verdictBrier`, `coverageGaps`, `reviewModelWords`, `ledgerCitationCount`, plus the channel and checks rows, with `null` (not 0) where a source was absent.
5. **`coverageGaps` is honest:** every `untested` row in the document is counted, the count equals `rows − (rows with both a datum and a token)`, and there is one `left out:` line per counted row.
6. **The ledger moved:** the weekly minted one commitment per scorable coverage row, and the close run's settler wrote at least one verdict receipt whose `detail.rowId` names a real row. The commitment count in the ledger equals the count §1's header printed (Addendum C4). If every receipt is `pending`, say which reason and why — a first period with nothing to settle is the expected reading, and step 2's two-run pair exists to make it not the case.
7. `metaLeakHits` = 0.
8. `<state root>/option-wizard/2026-09-04/close.regime.json` carries a `checks` array of exactly three entries and an `invalidation` object.
9. **Exactly 15 and exactly 5.** The weekly document's section 6 has **15** focus rows and the 09-04 close document's has **5** — counted out of the rendered markdown. Fewer is a pass **only** if `view.focus.shortfall` prints the reason and the universe really is that small; record the universe size beside the count either way.

```bash
V=$S/pit/review-v1
awk '/^## 6 · Focus/,/^## 7 · /' "$V/reports/option-wizard-2026-09-06-weekly.md" | grep -c '^| '
awk '/^## 6 · Focus/,/^## 7 · /' "$V/reports/option-wizard-2026-09-04-close.md" | grep -c '^| '
```

10. **The focus list is byte-identical on replay.** Re-run the weekly with `--replay-from <the first run id>` into a second variant, and diff the focus block of the two reports. Empty diff, or the acceptance fails:

```bash
"$S/run-pit-review.sh" 2026-09-06 weekly review-v1-replay --replay-from <runId>
diff <(awk '/^## 6 · Focus/,/^## 7 · /' "$S/pit/review-v1/reports/option-wizard-2026-09-06-weekly.md") \
     <(awk '/^## 6 · Focus/,/^## 7 · /' "$S/pit/review-v1-replay/reports/option-wizard-2026-09-06-weekly.md")
```

11. **N theme rows present.** Section 3's row count equals `12 + |sectors| + |themes|`, the last rows are the `theme:` ids in declared order, and each prints its excess-move triple or an `untested` reason. The **rotation block (3d)** is present on the weekly with `|sectorEtfs| + |themes|` rows plus the benchmark footer line, and **absent** on the close document.
12. **The focus ledger moved.** The weekly minted one `focus-admit` commitment per admitted, scorable name, and each carries a `threshold.source` naming either `ow_uw_iv_term implied_move_perc` or the `ow_apex_bars` realized fallback. Count them, and print the distribution of the two sources — a run where every threshold is the fallback is a finding about IV coverage, not a failure:

```bash
node -e "const {readLedger}=require('./packages/core/lib/ledger.js');
  const r=readLedger(process.env.V,'option-wizard');
  const f=r.commitments.filter(c=>c.payload?.kind==='focus-admit');
  const by={}; for (const c of f) { const k=String(c.payload.threshold?.source??'none').split(',')[0]; by[k]=(by[k]??0)+1; }
  console.log(f.length,'focus-admit', by);" V="$V"
```

13. **The new metric rows are written:** `focusChurn`, `focusHitRate`, `focusWhyRejected`, `focusWhyMissing`, `themeRows`, `themesProposed`, `rotationRows`, `staleRowsQuoted` — `null` (not `0`) where a source was absent. `focusChurn` is **0** on a first period by construction (nothing is carried yet); a nonzero value on the second period must be explained by the `dropped` reasons, not waved through.

14. **`ow_massive_actions` is exercised, or its absence is recorded.** If `MASSIVE_API_KEY` is available locally, export it for the pit run, confirm the two endpoints answered (the `coverage` layer says `ok`, not `skipped`), **record the observed response shape and rewrite the tool's inline comment and the two fixtures in the same PR**, and answer the open question — did `/stocks/v1/splits` return an announced split ahead of its `execution_date`? If the key is not available, the run is still a pass: the frame prints a `skipped` layer and a `focus.notes` line, and the evidence README records **"corporate/assignmentRisk unexercised: no MASSIVE_API_KEY on this machine"** as blocked, never omitted.

    **Deploy step, and it is not optional.** `~/.config/helium/helium.env` on the mini does **not** carry `MASSIVE_API_KEY` or `MASSIVE_BASE_URL` as of 2026-09-06 (argon holds them elsewhere). Add both to that file **before** the first production weekly after this merge, or the corporate and assignment-risk weights silently score zero in production while the laptop's test run looked fine. Write the step into the PR body and into the evidence README.

- [ ] **Step 5: Write the evidence.** `docs/evidence/pit-replays/2026-09-06/README.md` in the same form as the 2026-09-05 one: what was run, from which branch and sha, against which sources, the instants, and a variant/code/runs/tokens/what-changed table. **Adopt Addendum C6's three-question header now, at zero cost** — _the question · what came back · why it matters_ — and state the null and the n where a replay produced one (`n>1` waits for a real A/B). Copy both rendered reports into `review-v1/` and paste the `metric` dump and the ledger counts — **that dump is the acceptance evidence for bullets 3–6 and 12–14.** Record honestly what did not pass, including which of §J.1's four footer fields the `RunReport` could not supply.
- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts` — green, and `core-neutrality` unaffected because nothing under `packages/core/src` changed.
- [ ] **Step 7: Commit, push, PR**

```bash
git add docs/evidence/pit-replays/2026-09-06/
git commit -m "docs(option-wizard): record the review-framework acceptance run"
git push -u origin feat/review-framework
gh pr create --title "feat(option-wizard): the seven-section review framework, scored from the ledger" --body "$(cat <<'EOF'
Replaces the free-form weekly with seven fixed sections — Scorecard, 上周复盘, Coverage
(macro / sectors / themes / rotation), 下周展望, Dated catalysts, Focus, Open calls —
rendered from the outcome ledger and the tools.

- The coverage list is declarative (`extensions.review.coverage` + `sectors` + `themes`):
  12 macro rows + one row per argon watchlist chain + one row per registered theme, never
  dropped. Missing data prints `untested` and counts in `coverageGaps`.
- Every verdict token is a stored commitment with a probability; a new settler scores it
  against the next dated observation of the same row and writes a receipt. Sections 1 and
  7 are printed from those rows, at zero model words.
- The weekly 15 / daily 5 focus list is COMPUTED from dated event feeds with declared
  weights — same inputs, same list, byte-identical on `--replay-from`. Each admitted name
  mints a `focus-admit` commitment scored against its own ATM implied move.
- A theme lands only with a pollable evidence line, a horizon and a kill condition; it is
  an ordinary coverage row with an excess-move triple, so it costs no settler code.
- Channel ranking, coverage extraction, focus scoring and check scoring are one
  deterministic step (`requires: []`), so the prompt and the audit table cannot disagree.
- Daily premarket/close run the same seven sections at one third the size, one phase behind.
- `ow_ib_positions` is removed from every role and replaced by operator-maintained tickers
  of interest: the argon /flash page is public.
- `ow_review_window` no longer reports a session with a report on disk as "not written".
- New tool `ow_massive_actions` reads dated splits and ex-dividends from massive.com (the
  provider argon already uses). **Deploy step: add `MASSIVE_API_KEY` and `MASSIVE_BASE_URL`
  to `~/.config/helium/helium.env` on the mini before the first production weekly** — they
  are not there yet, and without them the corporate and assignment-risk weights score zero.
  The response shape is transcribed from the documentation; the tool carries a named
  `it.skip` until one live call has been recorded.
- No feature flag, no new gate. Rollback is `ln -sfn <old sha> current`.

Acceptance: `docs/evidence/pit-replays/2026-09-06/`.
Deliberately out of scope: putting these sections into the delivered email (the mail body
is abridged today and renders no sections at all).
EOF
)"
```

Wait for CI. **Never merge before every check is green.**

- [ ] **Step 8:** `cd /Users/chenxi/projects/helium && git worktree remove .worktrees/review-framework`

**Doctrine:** 1 (the run proves the loop closes), 4 (the audit header is the answer), 6 (evidence, not assertion).

---

## Ablation record — what was cut before writing this plan, and what broke

| Removed                                                                        | What broke without it                                                                                                                                                             | Verdict                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A renderer gate refusing briefs that name a held-only ticker                   | Nothing — removing the tool deletes the path instead, and the gate would have pulled positions data one step closer to `data: view`                                               | **Cut**, replaced by Task 5                        |
| A separate `theme-verdict` commitment kind                                     | Nothing — the settler, the bands, the Brier and the scorecard all work on `coverage-verdict` unchanged                                                                            | **Cut before it was written** (Task 13)            |
| A section 8 for the rotation table                                             | Nothing — §J.1 numbers it 3d, and a reader gets one Coverage section instead of two tables in different places                                                                    | **Cut**, folded into section 3 (Task 12)           |
| The optional delivered-email task                                              | Nothing in this PR — the mail body renders no `view.sections` at all today, so the sections reach the page and not the mail either way                                            | **Cut**, moved to the follow-up list               |
| `invalidation-triple` advisory gate                                            | Nothing — the renderer already drops the object, flags it in `view.faults`, and records `brief.invalidationComplete`                                                              | **Cut**                                            |
| A second state file (`<label>.checks.json`)                                    | Nothing — one extra key on the record `stateBlock` already lifts                                                                                                                  | **Cut**                                            |
| Divergence-pair channel (#7)                                                   | Nothing — it scored `min(a,b)` against a sign convention no store holds                                                                                                           | **Cut**                                            |
| A `brief.format` feature flag                                                  | Nothing `git revert` does not cover, at the cost of two renderers and two persona sets                                                                                            | **Cut**                                            |
| A settler that fetches its own market data                                     | Three hours of freshness on a daily verdict, at six network calls per run and a duplicated extraction                                                                             | **Cut**, ledger-based settlement instead (Task 13) |
| Per-coverage-row metric rows (23 more per run)                                 | Nothing — the per-row detail is in the receipt, which is where `helium scoreboard` already aggregates                                                                             | **Cut**                                            |
| A second review page from `week-reviewer`                                      | Nothing — it feeds counters into one document instead of writing a rival one                                                                                                      | **Cut** (spec §E)                                  |
| A daily rotation table (§J.2)                                                  | 12+N bar calls on each of four daily runs, for a ranking that moves by rounding between sessions; §H.4 asks for one table per weekly                                              | **Cut**, recorded as a deviation (Task 9)          |
| `focus.selectFocus` stickiness                                                 | The list churns on a rounding-sized score move — the "每次 run 都会不一样" the user rejected                                                                                      | **Kept**                                           |
| `ADMITTED_EVENT_SOURCES`                                                       | Nothing today, because no unverified feed is wired — which is precisely the moment one gets wired                                                                                 | **Kept**                                           |
| `findFocusLeaks`                                                               | A persona is a request: eight of eleven model-computed numbers were wrong on 2026-09-03 under a persona that forbade computing them                                               | **Kept**                                           |
| `coverageRowCount` helper                                                      | Adding a theme becomes a four-file test edit                                                                                                                                      | **Kept**                                           |
| `FLASH_BUDGET` / `measure()`                                                   | `regime`, `scenarios` and `frank` still emit `sections`; deleting it breaks three steps to tidy one                                                                               | **Kept**                                           |
| `as-of-verbatim`, `cause-citation`, `meta-leak`, `design-spot`, `ib-preflight` | Each has caught a real defect (`as-of-verbatim`: the 2026-09-02 four-hour timezone error; `meta-leak`: the coverage-in-prose refusals this PR's footer move needs a detector for) | **Kept, unchanged**                                |
| The three `BriefView` structured fields (`focus`, `themes`, `rotation`)        | The page renders identically without them; a future argon table has no data to bind to                                                                                            | **Kept, and flagged as the one speculative item**  |

## Spec coverage — every C/E/F/G/H/I/J item mapped to a task

| Spec item                                                                                                              | Task                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C.0.1 a number is rendered, never narrated                                                                             | 2, 8, 11, 12                                                    |
| C.0.2 a verdict is a stored commitment                                                                                 | 12 (mint), 13 (settle)                                          |
| C.1 ledger binding, citation line format, direction legs, "no commitment row → not scored, not shown"                  | 8 (`ledger` in the frame), 12 (the lines)                       |
| C.2 `extensions.review.coverage`/`sectors`/`verdicts`/`caps`; the `untested` mechanism                                 | 1 (declaration), 2 (`untested`), 10 (caps)                      |
| C.3 per-section writer and cap; section 2 may discuss only §1 ids; exactly one largest miss                            | 10 (caps), 12 (renderer check + fault), 15                      |
| C.3 token semantics continue/reverse/strengthen/fade/untested; each token+observable minted                            | 13 (`classify`, `VERDICT_BANDS`), 12 (mint)                     |
| C.4 daily = the same sections, one third, one phase behind                                                             | 10 (daily caps), 12 (task-id cap choice), 13                    |
| C.5 four sources scored; three-valued yes/no/not-observed; Tetlock gate; a changed view is a NEW dated commitment      | 4 (`CheckVerdict`), 14 (counters), 13, 10/12                    |
| C.6 renderer/model share; `--replay-from` A/B                                                                          | 11, 12 (share), 16 (replay)                                     |
| E new tool `ow_argon_watchlist`, env-gated, unknown chain → `untested`                                                 | 5                                                               |
| E privacy: `ow_ib_positions`                                                                                           | 5 (removal + tickers of interest)                               |
| E `weekly-analyst` reads the ledger; `week-reviewer` counters + the `regime: unavailable` defect; `scenario-analyst`   | 15, 14, 12 (mint) + 15 (persona)                                |
| E "also required": coverage block, verdict settler, section renderers                                                  | 1, 13, 12                                                       |
| F metric rows                                                                                                          | 12 (write), 14 (windowed), 16 (verify)                          |
| F the one query                                                                                                        | 16 Step 4                                                       |
| G.0.1 computed not chosen; same inputs → same 15                                                                       | 7 (pure + purity scan), 16 bullet 10                            |
| G.0.2 stickiness; `focusChurn`                                                                                         | 7 (`selectFocus`), 13 (the open commitment)                     |
| G.1 universe = argon chains ∪ pinned ∪ TV flag lists                                                                   | 7, fed by 5                                                     |
| G.2 event feeds; G.3 weights, decay, tie-break                                                                         | 1 (declaration + sources), 6 (splits/dividends), 7 (extraction) |
| G.2 split and ex-dividend source (massive.com)                                                                         | 6 (`ow_massive_actions`)                                        |
| G.4 output row, exactly 15 / exactly 5 or say why                                                                      | 12 (`view.focus`, `shortfall`), 16 bullet 9                     |
| G.5 settlement vs ATM implied move; `focusHitRate`                                                                     | 12 (mint), 13 (settle)                                          |
| G.6 no direction, no sizing, no hot-stock reasoning                                                                    | 7 (`FOCUS_BANNED_PATTERNS`), 12 (the drop)                      |
| H.1 declarative register; no kill, no theme                                                                            | 1 (loader refuses)                                              |
| H.2 theme = coverage row; verdict; excess-move triple                                                                  | 2 (`themeRow`), 12 (print + mint)                               |
| H.3 PROPOSED, parsed, printed, never scored                                                                            | 12 (`proposedThemes`)                                           |
| H.4 rotation table, renderer-only, one model sentence                                                                  | 9 (`ow_rotation`), 12 (3d), 15 (sentence)                       |
| I.1 OPEX / quad witching / FOMC blackout / ex-dividend assignment risk                                                 | 1 + 7 (OPEX date arithmetic, `meeting_date`), 6 (ex-dividend)   |
| I.3 index rebalance dates, I.4 analyst/product days                                                                    | 1 (`focus.calendarPins`, PR-reviewed)                           |
| I.6 weights are a declared prior until `focusHitRate` says otherwise                                                   | 1 (the printed line), 13 (the metric)                           |
| J.1 seven sections, header, per-section writer, what each mints                                                        | 12 (`REVIEW_TITLES`, the bodies)                                |
| J.2 daily = the same seven, one third                                                                                  | 12 (`period: "daily"`)                                          |
| J.3 what each section mints and who settles it                                                                         | 12 (mint), 13 (settle)                                          |
| J.4 declarative surface                                                                                                | 1                                                               |
| Addendum A1–A5 (denominator, what-we-left-out, calibration, catalyst gate, band print)                                 | 12                                                              |
| Addendum C1–C4 (prints vs forecasts, killed claim + figures-not-to-quote, session alignment, complete by construction) | 12 (+ 16 evidence for C4)                                       |

## Unmapped spec items — stated rather than invented away

1. **§F's settlement harness** (window = N production runs after the merge sha; `not-merged` / `pending` / `improved|regressed|flat`; `span.code_version` ties runs to the merge sha) is the **helium-self** side of the loop and belongs to whoever owns the PR-opens-a-commitment machinery from `option-wizard-quality-loop-2026-09-05`. This plan produces the metric rows that harness reads and nothing more. No task claims to build it.
2. **§F's `label`-column semantics** (`verdictBrier` labelled by coverage row id, `callHitRate` by window) cannot be honoured as written: the `metric` PK is `(run_id, name)` and `label` is written by the runner as the run phase. Task 12 writes the aggregate under §F's exact name and puts the per-row detail in the receipt. **Deviation accepted and documented, not silently reinterpreted.**
3. **C.4's "close scores that morning's premarket verdicts"** is satisfied one observation earlier than literally written, because the runner settles before the DAG. Task 13 documents it and the receipt names the observation it used.
4. **The 21-day P/L counters** in Task 14 remain unexercised locally: they need closed trades in the ledger, and none exist. The counter is written and its absence path is tested; the number itself is blocked on real fills.
5. **Corporate actions, partly solved and partly not.** Splits and ex-dividends now have a real feed — massive.com's `/stocks/v1/splits` and `/stocks/v1/dividends`, Task 6. Two caveats, both binding: (a) **that response shape is transcribed from the documentation and has not been observed live**; the tool ships with an `it.skip` named "live shape unverified — run once with `MASSIVE_API_KEY` and record", and its inline comment is rewritten from the first real call. (b) **Whether `/stocks/v1/splits` returns an ANNOUNCED-but-unexecuted split is unconfirmed** — the docs do not say, and only the dividends sample shows a forward date. **Until that is verified live, the `corporate` weight fires on `execution_date` and nothing earlier**, which is stated at the scoring site in Task 7. Still with no source at all: **index add/remove, rebalance, spin-off (§G.2)** and **lockup expiry, secondary offering (§I.2)** — Task 1 Step 3's two `it.skip` gates name them, and they enter only as an operator-dated `focus.calendarPins` row.
6. **Flow anomaly at "30d vol ratio ≥ 2×" (§G.2).** `iv_rank` is available (argon watchlist rows carry it) and drives the `flowAnomaly` weight; a _volume_ ratio has no field in any verified payload here. Task 7 scores `flowAnomaly` from `iv_rank >= 80` alone and the row's `parts[].from` says so, so the missing half is visible in the output rather than assumed.
7. **§I.5 seasonality base rates.** `get_market_seasonality` / `get_average_return_per_month_by_ticker` are UW MCP tools, not helium tools. Deferred to the `ow_base_rate` follow-up, which owns the comparable-set definition; nothing here claims it.
8. **§H.1's NOAA ONI evidence line.** No tool serves it. `ThemeEvidence.tool` is optional and its absence prints `evidence: operator-checked` on the row; the theme's verdict still settles, because it settles on the excess-move number, which is computable. The evidence line is the operator's to poll.
9. **`ow_price_structure` as a realized-move source (§G.5's own suggestion).** It holds no price series — it is expiry payoff arithmetic over legs and their NBBO mids. Task 13 uses `ow_apex_bars` and records the substitution in the commitment payload.
10. **§J.2's daily rotation table (1d/1w).** Not built: §H.4 asks for one table per weekly, and a daily table costs 12+N bar calls per daily run. Task 9 records the deviation; the daily document prints 3a/3b/3c and no 3d.
11. **§J.1's footer (`tokens in/out · model per role · cost · wall time`).** Task 12 prints exactly the fields `RunReport`'s step records are verified to carry, checked before writing; whichever of the four are unavailable are recorded as blocked in the acceptance evidence. No cost is estimated.

## Follow-ups — deliberately not in this PR

| #   | What                                                                                                                                                                                                                                                                                                                                                                            | Why it is separate                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`ow_base_rate`** (Addendum C5): conditional base rates from a defined comparable set over apex daily bars — P(no deeper break), P(regain high within 20 sessions), P(+2% more), the four-path table with deepest drawdown, all with n                                                                                                                                         | Needs a history engine and, before code, a written comparable-set definition — that definition **is** the method. It turns `continue p=0.7` into "history says 78%; we say 70%", which is what makes A3's over/under-confidence diagnosable. Design doc first. It is also where §I.5 seasonality lands.                     |
| 2   | **Research-study discipline for the evidence README** (Addendum C6): question · what came back · why it matters; null stated; n stated; failures published; a per-family multiple-testing table; every number carrying its command                                                                                                                                              | The three-question header is adopted now at zero cost (Task 16 Step 5). The null/n columns wait for a replay run with `n>1`, which needs a real prompt A/B.                                                                                                                                                                 |
| 3   | **Finish the corporate-action coverage**: (a) run `ow_massive_actions` once with a real `MASSIVE_API_KEY`, record the observed shape in the tool comment, replace the doc-transcribed fixtures, answer the announced-split question, unskip Task 6's `it.skip`; (b) find a source for index add/remove, rebalance, spin-off, lockup and secondary and unskip Task 1's two gates | (a) is a single call and belongs to the first run with the key on the mini. (b) still has no verified feed: a shape must be recorded before a tool is written (AGENTS.md), and until then `focus.calendarPins` is the only admitted path for those five.                                                                    |
| 4   | **The delivered email**: tape strip · `oneSentence` · The one thing · What would change my mind · What I'll check tomorrow · Everything else · `bottomLine` · `candidateRows` · `flashLink` · footer                                                                                                                                                                            | A separate product decision about a document read on a phone. Constraints that will bind it: Design 04 minimal-white; under Gmail's 102 KB clip (the trailing `page.replace(/>\n\s+</gu, "><")` is load-bearing); light and dark via the existing `ink`/`ink-dim` classes; no quantity and no account information anywhere. |
| 5   | **`runner.ts` metric `short` suppression**: ~50 metrics now print on one `- quality:` header line, roughly 400 characters                                                                                                                                                                                                                                                       | `packages/cli/src/runner.ts` is owned by another session and this PR may not touch it. Cosmetic; open it there.                                                                                                                                                                                                             |
| 6   | **Re-weight §G.3 from `focusHitRate` by event type** after ~8 weeks (§I.6)                                                                                                                                                                                                                                                                                                      | Needs the data this PR starts collecting. Until then the weights print as `declared prior 2026-09-06`.                                                                                                                                                                                                                      |

## Where this plan departs from the source documents

1. The tool is `ow_session_frame`, not `ow_one_thing`, and `quality/frame.ts` replaces `quality/one-thing.ts` — it carries the coverage rows, the focus list and the ledger rows too, and a name that says "one thing" would lie about its payload. Neither name has landed, so the rename costs nothing.
2. Sections 1/3/5/6/7 live in a new `render/review.ts` rather than inside `render/one-thing.ts`; the citation-line work moves there wholesale so it is not written twice.
3. The frame's ledger window is defined by the ledger's own state (`settledToday`, `open`) rather than by a `since` argument, because a deterministic step's tool can only be handed `{}` and a `since` would have to be inferred from a phase the tool does not know. Effect is identical and no phase name enters the codebase.
4. Verdict commitments carry a probability. Spec C.2 does not say so, but C.5's Tetlock gate requires "probability-bearing" and `verdictBrier` is meaningless without one.
5. `risk-reviewer` loses `ow_ib_positions` too, beyond the brief's instruction, because its output renders on the same public page. Reversible in one line if the user disagrees.
6. The rotation table is section **3d**, not a section 8 (spec §J.1's numbering), and it is weekly-only (§H.4 over §J.2).
7. Addendum A2's "what we left out" prints its per-row reasons under section 3 and its **count** in section 1, satisfying both A2 and §J.1 without printing the same lines twice.

## What this plan could not verify

- **The live argon watchlist response** was read from the router and model source (`watchlist.py`, `models/watchlist.py`, `watchlist_taxonomy.py`), not from a live `GET`. All ten chain names in the spec were confirmed present in the taxonomy. Task 5 Step 1 records the real shape before the tool is written; if argon is down, the fixture must say so.
- **The live-run channel paths** (`liveNow.quotes[]`, `liveNow.spreads["2s10s"]`, `ow_uw_gex.levels[]`) are read from tool source and its verification comments, not from a recording — every recorded payload here is an as-of replay where `liveNow` is `{unavailable:"as-of"}` and `ow_uw_gex` returns nothing. The first live premarket run on the mini is where those paths are first exercised.
- **`fredDirect` never answers on this laptop** (every series `"fetch failed"` in the recording); the credit row's `series` fallback is what the acceptance run exercises.
- **massive.com's live response** was never called: `/stocks/v1/splits` and `/stocks/v1/dividends`, their parameters and their fields are transcribed from the provider's documentation, and the env names come from argon's `uw_scan/config.py`. Task 6's fixtures say so in the README, its `it.skip` names the debt, and **whether an announced-but-unexecuted split is returned is unknown** — the `corporate` weight therefore fires on `execution_date` only.
- **Apex coverage for the rotation and theme symbols** (`XLB…XLY`, `DBA`, `MOS`, `NTR`, `DE`) is unverified until Task 9 Step 1 runs.
- **The 21-day P/L window** has no closed trades to score.
- **`RunReport`'s per-step usage fields** (tokens, model, cost, wall time) are unverified; Task 12 checks before printing a footer that claims them.

## Task shape — one screen

| #   | Task                              | Files                                                                         | Mints / measures                                                              | Test command                                                                              |
| --- | --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0   | Spec, design, plan, branch        | `docs/superpowers/{specs,plans}/*`                                            | —                                                                             | `git show --stat HEAD`                                                                    |
| 1   | `extensions.review` + loader      | `tenant.yaml`, `quality/review-config.ts`, `tools/index.ts`                   | the declaration everything else counts from; refuses a theme with no kill     | `pnpm vitest run --project unit …/quality-review-config.spec.ts`                          |
| 2   | Channels, coverage rows, baskets  | `quality/channels.ts`, `quality/themes.ts`                                    | `12+\|sectors\|+\|themes\|` rows, `untested`, basket excess triple            | `pnpm vitest run --project unit …/quality-{channels,coverage,themes}.spec.ts`             |
| 3   | History + select                  | `quality/history.ts`, `quality/select.ts`                                     | score, rank, mode, `medianSource`                                             | `pnpm vitest run --project unit …/quality-select.spec.ts`                                 |
| 4   | Tomorrow's three checks           | `state/regime.ts`, `state/checks.ts`                                          | `hit/miss/not-observed`, `checksLine`                                         | `pnpm vitest run --project unit …/state-checks.spec.ts …/state-regime.spec.ts`            |
| 5   | Watchlist, tickers of interest    | `tools/index.ts`, `team.yaml`                                                 | chain members, `ofInterest`, `ivRank`; **no role reads positions**            | `pnpm vitest run --project unit …/tools-argon-watchlist.spec.ts …/team-manifest.spec.ts`  |
| 6   | `ow_massive_actions`              | `tools/index.ts`, `tenant.yaml` (`env`)                                       | dated splits + ex-dividends; doc-transcribed shape behind a named `it.skip`   | `pnpm vitest run --project unit …/tools-massive-actions.spec.ts`                          |
| 7   | Focus 15 / 5                      | `quality/focus.ts`                                                            | decayed score, stickiness, `churn`, banned-pattern leaks                      | `pnpm vitest run --project unit …/quality-focus.spec.ts`                                  |
| 8   | `ow_session_frame` + frame-clerk  | `quality/frame.ts`, `tools/index.ts`, `team.yaml`                             | one payload: ranked, rows, focus, checks, ledger                              | `pnpm vitest run --project unit …/quality-frame.spec.ts …/tools-session-frame.spec.ts`    |
| 9   | `ow_rotation` + weekly step       | `quality/themes.ts`, `tools/index.ts`, `team.yaml`                            | `\|sectorEtfs\|+\|themes\|` ranked rows vs benchmark                          | `pnpm vitest run --project unit …/tools-rotation.spec.ts …/quality-themes.spec.ts`        |
| 10  | Schemas + budgets                 | `render/budget.ts`, `render/one-thing.ts`, `render/review.ts` (schema halves) | per-field caps; `p` required or no mint                                       | `pnpm vitest run --project unit …/render-one-thing.spec.ts …/render-flash-budget.spec.ts` |
| 11  | One Thing renderer, `BriefView` 3 | `render/one-thing.ts`, `render/index.ts`, `gates/*`                           | channel/checks/brief metric rows; fence moves to editor                       | `pnpm vitest run --project unit …/render-one-thing.spec.ts …/gate-*.spec.ts`              |
| 12  | `render/review.ts`                | `render/review.ts`, `render/index.ts`, `render/ledger.ts`                     | 7 sections; verdict + focus-admit + scenario commitments; all §F/§G/§H metrics | `pnpm vitest run --project unit …/render-review.spec.ts`                                  |
| 13  | Settlers                          | `eval/verdict.ts`, `eval/settle.ts`                                           | `verdictBrier`, `focusBrier`, receipts, evidence hashes                       | `pnpm vitest run --project unit …/eval-{verdict,focus,settle}.spec.ts`                    |
| 14  | `ow_review_window`                | `tools/index.ts`                                                              | per-window counters; `regime: unavailable` (defect fix)                       | `pnpm vitest run --project unit …/tools-review-window.spec.ts`                            |
| 15  | Personas and prompts              | `team.yaml`                                                                   | ≤3800 chars each; deleted formats gone; bounded focus/theme lines             | `pnpm vitest run --project unit …/team-manifest.spec.ts`                                  |
| 16  | Acceptance                        | `docs/evidence/pit-replays/2026-09-06/`                                       | the 14-bullet bar, the one query, the ledger counts, the MASSIVE deploy step  | `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts`, then the pit runs     |
