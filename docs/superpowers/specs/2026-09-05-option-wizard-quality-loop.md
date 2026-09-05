# option-wizard quality loop — six improvements

Date: 2026-09-05. Follows the PIT replay iteration in PR #91
(`docs/evidence/pit-replays/2026-09-05/README.md`). Decisions are the user's
from that thread; this file fixes them so a planner and an executor can work
from it without the conversation.

Doctrine applies (`/Users/chenxi/projects/helium/AGENTS.md`): core stays
domain-free, the audit is a queryable table, ceremony must earn its keep,
LLMs never do arithmetic (numbers and scores come from code).

Prerequisite already on the branch: the tenant `calendar` field
(`weekdaysOnly`, `closed[]`) and the runner's closed-day skip. Everything
that counts trading days uses that calendar.

## Delivery shape

One PR (user decision 2026-09-05: "一个pr 做吧"), one branch
`feat/quality-loop`, one worktree, `/execute-plan`. Task order inside it:
items 3, 2, 5 first (cut and gate, deterministic, no new data), then 4, 1, 6
(data and replay, which read item 5's metrics). Item 6's ledger read is
blocked until the Outcome Ledger PR lands; it ships with a defensive import
and a coverage note until then.

## Item 3 — delete the settlement ceremony from the narrative team

`markout`, `drift` and `recap` steps in `plugins/option-wizard/team.yaml`
spend one section per run on "nothing to settle" and the recap step writes
Chinese titles into an English brief. Candidate selection is moving to its
own team; settlement is the Outcome Ledger's job (peer session, settles from
1m bars, no LLM judge).

- Remove the three steps and their persona blocks from `team.yaml`. Leave
  the tools registered (no core edit, no tool deletion).
- Update `plugins/option-wizard/tests/team-manifest.spec.ts` and any renderer
  test that expects those sections.
- Acceptance: a `--as-of` replay of 2026-09-03 close produces no
  markout/drift/recap section and no CJK characters in section titles.
- Assumption to confirm with the ledger session before merging: the ledger
  does not read those steps' output.

## Item 2 — `meta-leak` advisory gate

The editor persona forbids replay/coverage words in prose; v3 still leaked
"No prior intraday brief exists" into a headline. Persona text is not a
gate. Add a renderer-side advisory gate next to `flash-budget`, same
mechanism, same advisory semantics (never blocks delivery).

- Patterns (case-insensitive) over headline, decision, section titles and
  bodies — NOT over the `coverage` block:
  `\breplay\b`, `\bas-of\b`, `\bunavailable\b`, `\bfrozen\b`,
  `nothing ships`, `no prior \w+ brief`, `not (checked|available|live)`.
- Each hit is one violation `{ field, pattern, excerpt }` on the report
  under the gate's name, exactly as flash-budget records its violations.
- Pattern list lives in the tenant (tools or a tenant-local module), not in
  core; the gate runner in core stays pattern-agnostic if it already is.
- Acceptance: unit test with a headline containing "No prior intraday brief
  exists" → one violation; the `coverage` block containing "unavailable" →
  zero.

## Item 5 — deterministic quality metrics on every run

Three numbers per run, computed in code, written to the report and to the
audit table so `SELECT` shows the trend. No LLM judge.

- `metaLeakHits` — count from item 2.
- `budgetViolations` — count from `flash-budget`.
- `causeTitleSimilarity` — Jaccard over lowercased word sets (stopwords
  removed: the, a, an, of, to, in, and, not, is, at, on, for) between this
  run's cause-section title and the previous phase's cause-section title
  (previous phase = the prior report in `reportTimezone` order, across
  days; none → null).
- Storage: one row per metric in the existing audit DB. Reuse a generic
  table if one exists (e.g. a `metric(run_id, name, value)` shape); add it
  if not. Core-neutral names.
- Report header gains one line: `- quality: leaks=N budget=N cause-sim=0.xx`.
- Acceptance: query `SELECT name, value FROM metric WHERE run_id = ?`
  returns the three rows; a unit test pins the Jaccard on two known titles
  from `docs/evidence/pit-replays/2026-09-05/pit-v3/`.

## Item 4 — structured prior brief

`ow_prior_brief` feeds the previous phase's whole markdown to the model;
intraday then re-tells premarket's cause. Replace with a small state record.

- The regime step ends its output with one fenced block:
  ````
  ```regime-state
  {"cause":"…","ust2y":4.02,"ust10y":4.79,"s2s10":77,"tide":"up|down|flat","thesis":"one sentence"}
  ```
  ````
  Numbers are copied from tool output, never computed. A zod schema
  validates it; invalid or missing → the record is not written and the run's
  coverage notes `regime-state: missing`.
- Runner (or the tenant's render hook, whichever already post-processes
  step output) strips the block from the delivered brief and writes
  `<stateRoot>/option-wizard/<day>/<phase>.regime.json`.
- `ow_prior_brief` returns `{ headline, regimeState, phase, day }` from the
  most recent prior phase on an open day (calendar-aware); falls back to the
  current markdown behaviour with `fallback: "markdown"` when no JSON exists.
- Persona: "Compare with `regimeState` from the prior phase. If the cause
  has not changed, keep the title and write only the delta."
- Acceptance: unit test round-trips a regime block through
  parse → write → `ow_prior_brief`; a replay of 2026-09-03 intraday shows the
  JSON in the tool call, not the markdown.

## Item 1 — record tool I/O; serve replays from recordings

Today the audit DB stores byte counts only, so 14 live-only tools can never
be replayed and PIT coverage is stuck at 10/24. Record, then serve.

- Recording: every tool call's raw response, plus args and the instant,
  written as `<stateRoot>/runs/<runId>/tool-io/<seq>-<tool>.json.gz`.
  Wrapper lives where the runner already wraps tools for the PIT registry.
  Errors are recorded too (`{ error: message }`).
- Retention: 30 natural days, pruned at run start (covers a 21-trading-day
  lookback with holidays). Prune is one directory walk, no index.
- Serving: `helium run … --as-of <instant> --replay-from <runId>`; with it
  set, an `AS_OF_BLIND` tool returns the recorded response for the same tool
  and args (args hashed) instead of `{ unavailable: "as-of" }`, and
  `pitCoverage` counts it as available with `source: "recording"`. A tool
  with no recording behaves as today.
- Selecting the run is the operator's job for now (`helium runs --day` or
  equivalent listing if one exists; otherwise document the directory).
- Acceptance: record one live run on the laptop, replay it with
  `--replay-from`, pitCoverage reads 24/24 and the two reports' tool
  sections are byte-identical for the served tools.

## Item 6 — review phase with 5 / 10 / 21 trading-day windows

- `plugins/option-wizard/tenant.yaml`:
  ```yaml
  extensions:
    review:
      windows: [5, 10, 21] # trading days, counted with `calendar`
  ```
- New phase `review`, runs once a week after Friday's close (launchd
  `Weekday 6` at 05:00 HKT = Friday 17:00 ET; check whether the existing
  `weekly` plist can carry it before adding a sixth).
- Inputs, all deterministic and gathered by a tool `ow_review_window`:
  for each window, the reports' cause titles, `regime.json` records, the
  three item-5 metrics, and the Outcome Ledger scoreboard for the window if
  present (read-only; absent → coverage note).
- One model step, one page: per window, which causes held, which did not,
  what to change next week. The model reads numbers, never computes them.
- Delivered like other phases (mail under the same operator brake).
- Acceptance: a replay `--as-of 2026-09-04T21:00Z --phase review` produces
  three window blocks; the 5-day block lists exactly the five days
  08-31..09-04.

## Out of scope

Candidate selection (new team), ledger internals (peer session), launchd
changes on the mini during an acceptance window, any change to `packages/core`
that names a domain.
