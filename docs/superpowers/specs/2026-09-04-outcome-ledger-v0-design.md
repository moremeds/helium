# Outcome Ledger V0 — design

**Date:** 2026-09-04 (revised 2026-09-05)
**Status:** approved in discussion; ready for writing-plans
**Scope:** core seam (`packages/core`, `packages/cli`) + first tenant
(`plugins/option-wizard`) + consumer (argon `web/components/flash`)
**Codename:** Recursive Self _Measurement_, milestone V0. Not yet improvement.

## 0. Doctrine check

Judged against `AGENTS.md`:

1. Self-improvement — V0 is the scale. No loop can converge without it.
   The scale is generic; the first weight on it is option-wizard.
2. Multipurpose — core learns three domain-blind types and a jsonl file
   format. Everything that knows what SPY is stays in the tenant.
3. Pluggable — a tenant that wants measurement implements one interface,
   `Settler`, next to `Gate`. No new agent kind, no new provider.
4. Token sense — untouched; audit already covers it.
5. Blast radius — settler is read-only over the lake; ledger and evidence
   write under `$HELIUM_STATE_ROOT`.
6. Ceremony — five deliverables, each tied to a defect that already
   happened or a sample that cannot be collected later. Everything else is
   listed under _Not built_.

## 1. Goal

From the next production run onward, every tenant that declares a settler
leaves behind **machine-settleable commitments**; a deterministic step
settles them against ground truth and writes a receipt; a scoreboard reads
the receipts. option-wizard is the first tenant. Two weeks later the first
scoreboard exists. Nothing changes what the reader sees except the
`TARGET —` bug being fixed.

Why now and not after the tooling: outcome samples accrue only from the day
typed forecasts are emitted. Tooling can be back-filled; samples cannot.

## 2. What is general and what is not

The **loop is general, the truth is not.** AlphaEvolve and autoresearch are
a generic skeleton plus a user-supplied `evaluate`. Same split here:

| core / cli (generic, domain-blind)                     | tenant (domain)                                  |
| ------------------------------------------------------ | ------------------------------------------------ |
| `Commitment` / `Settler` / `Receipt` types             | what a commitment contains (`payload`)           |
| ledger jsonl append/read                               | `settle.ts`: how to resolve it against real data |
| evidence dump (exact prompt, tool calls)               | the meaning of each `scores` key                 |
| `helium scoreboard <tenant>`: aggregates `scores` only | deadline policy, scorable rules, verbatim checks |
| later: replay, compare, keep/reject                    | later: failure taxonomy, mutation allow-list     |

Core never interprets `payload` or `status`. It aggregates `scores` by key.
That is all `core-neutrality` permits, and all a second tenant needs.

Second tenant is `helium-self` (helium-df starts it after the quality-loop
PR). Its commitment is minted when a PR opens: `{ id: prNumber, payload: {
headSha, backlogItem, metric, direction, window: N production runs,
baseline } }`, metric from a closed tenant list (failed-run rate, cost per
run, p50 wall, gate fails), never agent-chosen. Settler reads `audit.db`
by `code_version`: not merged → `not-merged`; < N production `live` runs
since merge → `pending`; else `improved | regressed | flat` with `{ delta,
baseline, after, n }`. That is the test of whether the seam is drawn
right: it must need no core edit beyond the three types and `ledger.ts`.
Until then core holds three types and a file writer, nothing more.

## 3. Non-goals (explicitly not built)

eval.db · MutationManifest · LLM judge · replay store · bootstrap statistics ·
experiment UI · autonomous mutator · worktree sandbox · content-addressed
evidence · weighted utility · option P&L · scenario probability trees ·
any change to team topology · a generic evaluator framework.

Each enters only after the V0 scoreboard names a failure it would have
caught.

## 4. Core seam

In `packages/core/src/plugins.ts`, beside `Gate`:

```ts
export interface Commitment {
  id: string; // tenant-minted, stable; one per settleable thing (see D2)
  runId: string;
  tenant: string;
  issuedAt: string; // ISO instant
  deployment: "production" | "backtest" | "test"; // derived: asOf set → backtest, else HELIUM_DEPLOYMENT
  variant: string; // run context; "live" for the scheduled run
  asOf?: string; // run context; absent = live
  payload: unknown; // opaque to core
}

export interface Receipt {
  commitmentId: string;
  runId: string; // the run that settled it
  settledAt: string;
  status: string; // tenant vocabulary; "pending" is the one word core knows
  scores: Record<string, number>;
  evidenceHash?: string;
  detail?: unknown; // tenant extras; opaque to core
}

export interface Settler {
  settle(outstanding: Commitment[], now: Date): Promise<Receipt[]>;
}
```

Tenant declares it in `tools/index.ts` as `export function
buildSettler(cfg: TenantToolConfig): Settler` (same shape as `buildTools`,
so the settler gets `cfg.env` and `cfg.calendar` without reading
`process.env`). Discovery lives in `packages/cli/src/discovery.ts` beside
`loadGates`, not in core's synchronous YAML loader. Runner, at DAG start, if the tenant
exports a settler: read outstanding commitments (those with no receipt or
latest receipt `pending`), call `settle`, append receipts. Runs as an
audited zero-token span like gates do. Failure of the settler is recorded
and does not block the run.

Ledger: `$HELIUM_STATE_ROOT/ledger/<tenant>.jsonl`, append-only, three
record kinds: `commitment`, `receipt`, `baseline`. Commitments are written
by the renderer path **before the delivery intent** (records precede side
effects). `packages/core/src/ledger.ts` owns append and read; nothing else.

Run context is defined by the PIT-replay work (session helium-df, branch
`feat/pit-replay-narrative`) and adopted verbatim: `helium run <tenant>
--phase <p> --as-of <ISO> --variant <label>` (default `live`);
`RunOptions.asOf?: Date`, `RunOptions.variant?: string`;
`TenantToolConfig` (`packages/cli/src/discovery.ts`) = `{ stateRoot, env,
asOf?: Date, variant: string, pit?: { markUnavailable(tool, reason) } }`;
`RunReport` (`packages/core/src/report.ts`) gains `asOf?`, `variant?`,
`pitCoverage?: { available, total, unavailable: string[] }`. Landed as
PR #91 (head 453ea66, which also adds `TenantCalendar` at `tenant.ts:39-60`
and `calendarSkipReason` at `runner.ts:590-614`); this branch bases on it. Runner line numbers in this
spec are pre-#91 and shift by ~25 lines (the clock block is now near `:747`);
locate by content, not by number. This spec only derives `deployment`.

Scoreboard: `helium scoreboard <tenant> [--since] [--deployment production]
[--variant]`. Groups receipts by `variant` then `status`, means every `scores`
key over **non-pending** receipts only, counts `pending`, joins cost from
`audit.db` by `runId`. Read-only, small. Same-day noise floor is the first
report it must support: several runs with the same `asOf` and `variant`.

Evidence: `$HELIUM_STATE_ROOT/evidence/<tenant>-<day>-<phase>-<runId>.json`,
**rewritten after every step** (a run killed by launchd mid-way still leaves
the steps it completed; a JSON object cannot be appended to), header
written at run start:

```ts
{
  run: { runId, tenant, day, phase, deployment, variant, asOf, startedAt,
         codeSha, dshVersion, teamYamlSha256, tenantYamlSha256,
         toolIo: "<stateRoot>/runs/<runId>/tool-io/" },   // recorded by quality-loop item 5
  steps: [{ task, role, mode, provider, model,
            assembledPrompt,          // the string runner hands the executor (runner.ts:713-722, ~:747 post-#91).
                                      // NOT the full provider request: dsh adds its own system
                                      // prompt and tool specs at the edge; dshVersion pins those.
            output, gateResults }],
  view: unknown                                                // rendered data, opaque
}
```

Tool calls are **not** recorded here. helium-df's quality-loop PR (item 5)
records every raw tool response under `<stateRoot>/runs/<runId>/tool-io/`
and serves `--replay-from <runId>`; this spec references that directory
and asks two things of it: args and the summarised-vs-raw distinction are
kept, and a run with outstanding commitments is not pruned: the recorder
prunes by age with a caller-supplied `keep(runId)` hook, which this spec
fills from `ledger/<tenant>.jsonl` (any run with a commitment lacking a
non-pending receipt).

Runner touch is therefore two lines of intent: keep the joined prompt on
the step record, and call the settler at DAG start. Not delivered anywhere,
not in email, not POSTed to argon.

Read entry points, fixed now because the quality-loop review phase (item 6)
codes against them: `readLedger(stateRoot, tenant, { since? })` in
`packages/core/src/ledger.ts` returns `{ commitments, receipts, baselines }`
raw, empty arrays when the file is absent; `summarise(records, {
deployment?, variant? })` in `packages/cli/src/scoreboard.ts` returns
`{ byVariant: { [variant]: { n, pending, means, ranges } } }`. The quality
loop's per-run `metric` table (item 3) is not written by V0: outcome scores
settle days later and aggregate across runs, so they stay in the ledger.

## 5. First tenant: option-wizard

### D1. Typed `target` + deadlines + `thesis`

**Defect:** argon reads `target.level/side`; helium emits prose. Flash shows
`TARGET —`. Confirmed at `render/index.ts:67` vs argon `view.ts:58`.

```ts
entry?:       { level: number; side: "above" | "below"; deadlineBars: number }
target?:      { level: number; side: "above" | "below" }
invalidation: { level: number; side: "above" | "below" }[]
resolutionDeadline: string           // ISO date = expiry
thesis: string                       // the old prose target
```

Deadline policy is **renderer-owned** (an agent that picks its own deadline
inflates `pTrigger`): `entry.deadlineBars` default 5, agent may lower only.
It is a count of **1d bars after `referenceClose.date`**, not a calendar
date: helium has no exchange calendar and must not grow one; the lake's
daily bars are the calendar, and a bar that does not exist yet is simply
`pending`. `resolutionDeadline` is the expiry date, the one date the
contract itself fixes. `schemaVersion` bumps.

Argon: mirror updated, `CandidateCard` shows `thesis` and renders `target`
through the existing `level()` helper. Consumer test uses a real helium
producer fixture.

### D2. Probabilities

Semantics frozen as `evaluator-v0`:

```ts
spyForecast: {
  referenceClose: { date: string; value: number }   // stamped by renderer from tool output
  t1Down: number    // P(close[ref+1 td] < referenceClose.value)
  t5Down: number    // P(close[ref+5 td] < referenceClose.value)
}
candidate.forecast?: {
  pTrigger: number
  givenTrigger: { targetFirst: number; invalidationFirst: number; unresolved: number }
}
```

`referenceClose` = last completed close known at issue time (premarket →
prior session; close phase → that session); its value must be a verbatim
tool output (extend `as-of-verbatim` to this number).

Owners: `scenarios` emits `spyForecast` (option-wizard, V0). Candidate
`forecast` is emitted by the **dedicated candidate-selection team** the
user has decided to build separately (2026-09-05: the same window yields
different candidates every run, so today's design/review tasks are not the
thing to score). In V0 option-wizard emits typed `target`/`entry`/
`invalidation` (D1, the Flash bug) but no candidate `forecast`; the
`-entry`/`-result` commitments and the candidate rules of D3 are written
against that shape and light up when the new team emits it. Renderer rules (issue #78: a missing field must never
erase a section): missing/malformed → rendered normally, `scorable:false`
with reason; `givenTrigger` sum outside 1 ± 0.02 → `scorable:false`; any
value outside [0,1] → `scorable:false`. No LLM normalisation.

**One commitment per settleable thing**, because each settles on its own
day and a receipt has one `status`. A run emits up to four kinds:

| id                      | settles when                 | scores            |
| ----------------------- | ---------------------------- | ----------------- |
| `<run-day>-<phase>-spy-t1` | ref + 1 bar               | `t1Brier`         |
| `<run-day>-<phase>-spy-t5` | ref + 5 bars              | `t5Brier`         |
| `<candidate-id>-entry`  | crossed, or deadlineBars out | `triggerBrier`    |
| `<candidate-id>-result` | resolved, or expiry          | `resolutionBrier` |

Candidate ids are already `ticker-day-phase-n` (`render/index.ts:991`),
unique across days. The same idea re-issued on consecutive days is several
correlated samples; V0 does not de-duplicate, the scoreboard says so in
its header.

`payload` carries the fields above plus ticker, legs, expiry.

### D3. Settler

`plugins/option-wizard/eval/settle.ts`, wired by `buildSettler(cfg)`. The
`markout`/`drift`/`recap` steps are deleted by helium-df's quality-loop
spec (same branch); `helium scoreboard` is the recap. The ledger reads no
prose from any step.

Calendar: the tenant manifest and `TenantToolConfig` gain
`calendar?: { weekdaysOnly, closed: string[] }` (helium-df). Settlement
still counts lake 1d bars; `calendar` is a cross-check only: a weekday not
in `closed[]` with no 1d bar is a lake gap → `pending`, never `not-entered`.

Data: livewire lake on the mini, DuckDB over
`~/market-warehouse/data-lake/bronze/asset_class=equity/symbol=<T>/{1d,1m}.parquet`.
Verified 2026-09-04/05 on the mini: SPY 1d and 1m through the prior
session; `bar_timestamp` is Asia/Hong_Kong and the 1m file is **extended
hours, ~850 bars per HKT date**, so one ET session spans two HKT dates.
The settler converts to ET first, keeps 09:30–16:00 only, and groups by ET
session. Never select bars by HKT date.

Rules in order:

1. **Coverage guard** — every ET session in the window needs its 1d bar and
   at least 380 RTH 1m bars; any session short → `pending`. Guards against
   lake gaps (the reason livewire-shepherd exists), not only "last bar
   missing". Never guess.
2. **Entry** — first RTH 1m bar whose high/low crosses `entry.level` on
   `entry.side` within `deadlineBars` sessions after `referenceClose.date`;
   none → `not-entered`. No `entry` field → entered at issue.
3. **Resolution** — walk RTH 1m bars **strictly after the entry bar**; first
   touch of any invalidation → `invalidationFirst`; of target →
   `targetFirst`; neither by `resolutionDeadline` → `unresolved`; both in
   one 1m bar → `ambiguous`.
4. **Direction** — 1d close at `ref + n` bars vs `referenceClose.value`,
   raw; ex-dividend inside the window recorded, not corrected (SPY goes
   ex around the third Friday of Sep, inside the first live window).
5. **Scores** — Brier, with formulas fixed as `evaluator-v0`:
   - binary (`t1Brier`, `t5Brier`, `triggerBrier`): `(p − o)²`, range 0–1;
   - three-class `resolutionBrier`: `Σ_k (p_k − o_k)²` over
     {targetFirst, invalidationFirst, unresolved}, range 0–2, emitted only
     when entered and not `ambiguous`.
     Keys never mix ranges; the scoreboard prints the range next to each.

Receipt `evidenceHash` = sha256 of the exact bar rows used, so a later lake
repair is detectable. Tenant-specific extras (`enteredAt`, `resolvedAt`,
`exDividend`, bar range) go in a `detail` field core ignores.

### D4. Baseline rows

One `baseline` record per run: `neutral: { t1Down: 0.5, t5Down: 0.5 }`
(scorable now), `uniform` per candidate `{ pTrigger: 0.5, givenTrigger:
1/3 each }` (scorable now, so candidate Briers have a floor to beat too),
and `argon: { signal, expectedReturn20d, confidence, dataDate }` raw,
`dataDate` verbatim from `ow_argon_metrics` (row-level market date, renamed
in PR #92) so a stale signal is never scored as that day's forecast.
No `med = 0.6` invention; a calibration map is evaluator-v1 once
`(signal, outcome)` pairs exist. This is what later shows whether the
multi-agent stack adds information over Argon alone.

## 6. Files

helium:

| Path                                                         | Change                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `packages/core/src/plugins.ts`                               | `Commitment`, `Receipt`, `Settler`                                       |
| `packages/core/src/ledger.ts`                                | jsonl append/read, outstanding()                                         |
| `packages/cli/src/runner.ts`                                 | settler call at DAG start; prompt keep; evidence write                   |
| `packages/cli/src/evidence.ts`                               | file writer                                                              |
| `packages/cli/src/scoreboard.ts` + `cli.ts`                  | `scoreboard` subcommand                                                  |
| `packages/cli/src/discovery.ts`                              | `loadSettler`: discover `buildSettler` export                            |
| `plugins/option-wizard/render/index.ts`                      | typed target, thesis, deadlines, forecast parsing, scorable, commitments |
| `plugins/option-wizard/render/html.ts`                       | thesis + probabilities                                                   |
| `plugins/option-wizard/team.yaml`                            | `scenarios` output fields only                                           |
| `plugins/option-wizard/eval/settle.ts`                       | D3                                                                       |
| `plugins/option-wizard/tools/index.ts`                       | `export function buildSettler(cfg)`                                      |
| `plugins/option-wizard/gates/as-of-verbatim.ts`              | cover `referenceClose.value`                                             |
| `plugins/option-wizard/contracts/brief-view-v2.fixture.json` | real producer fixture for argon                                          |
| `plugins/fake-tenant`                                        | declares a trivial settler so the seam proof covers it                   |

argon:

| Path                                     | Change                        |
| ---------------------------------------- | ----------------------------- |
| `web/components/flash/view.ts`           | mirror v2                     |
| `web/components/flash/CandidateCard.tsx` | thesis, target, probabilities |
| `web/components/flash/*.test.tsx`        | consume helium fixture        |

## 7. Tests

- core-neutrality still green; `fake-tenant` settler proves the seam with no
  core edit.
- Ledger: commitment appended before delivery intent (topology-boundary
  style); `outstanding()` excludes settled, includes `pending`.
- Renderer: prose → thesis; missing forecast → `scorable:false`, still
  rendered; sum 1.03 → `scorable:false`; deadline extension ignored,
  shortening honoured.
- Settler on frozen real SPY 1m bars (real ticker, real prices, as-of dated,
  per no-synthetic-data): not-entered, targetFirst, invalidationFirst,
  unresolved, same-bar ambiguous, stale → pending, HKT→ET boundary.
- Evidence: assembledPrompt equals the string handed to the executor; a run
  killed after step 3 leaves three steps on disk; header names the tool-io
  directory.
- Argon: v2 fixture renders `748 below`, thesis text, no `undefined`; a v1
  fixture (prose `target`) still renders, because argon deploys before
  helium and the two are not atomic.
- Settler RTH/timezone: a pre-market ET print through `entry.level` is
  ignored; an ET session split across two HKT dates is one session; a
  session with 200 1m bars → `pending`, not `not-entered`.
- Ledger: a `test` deployment run never appears in the default scoreboard.

## 8. Definition of done

1. Flash shows a numeric target for a real run.
2. A production premarket run appends commitments and a baseline row.
3. The next run's settler appends receipts for anything resolvable,
   `pending` otherwise.
4. `helium scoreboard option-wizard` prints from the live ledger.
5. Evidence file exists for that run with exact prompt and tool calls.
6. `fake-tenant` settler runs in CI.
7. Unit + contract suites green; deployed via `scripts/deploy.sh`.

## 9. Sequencing

One helium PR unless unreviewable. Concrete reason to split now: the
quality-loop review phase (helium-df item 6) codes against `readLedger` and
`summarise` and is blocked until they exist. If that blocks them in
practice, land core seam (types, ledger.ts, scoreboard.ts, fake-tenant
settler) first and option-wizard D1–D4 second; otherwise one PR.
One argon PR, merged first; its mirror accepts v1 and v2 until helium's
schemaVersion bump is deployed.

Lands **after** the PIT-replay work (session helium-df: regime persona +
as-of regeneration, master 635c700+), and reads the run context it defines.
helium-df does not touch the scenarios task, ledger, evidence,
scoreboard; this spec does not touch regime-analyst or the editor exemplar.

After deploy: **two weeks of silence.** No mutation, no judge. Then read the
scoreboard, name the dominant failure class, and let that name the first
experiment and the next piece of tooling.

## 10. Open items

- Which tool gives `referenceClose` verbatim (likely tape); confirm in
  implementation.
