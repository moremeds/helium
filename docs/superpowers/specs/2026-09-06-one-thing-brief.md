# "One Thing" daily brief + 5/10/21-day 复盘 — design spec

Design only, no code. Sources: `AGENTS.md` doctrine; `2026-09-06-brief-craft.md`
(template, selection rule, blueprint, persona contradictions — specified here,
not redesigned). Repo state read at merge of PR #92 into `master` (`1317718`);
the `quality-loop` worktree was removed mid-read, so paths below are master paths.

## Goal

Replace the flat five-equal-sections brief with one ranked lead item chosen by
renderer arithmetic, and close the loop by scoring yesterday's stated checks today.
Give the 复盘 fixed counters per window, with P/L confined to the 21-day one.

## Non-goals

No Unusual Whales backfill. No P/L in the 5- and 10-day windows. No model
arithmetic, re-ranking or number retyping. No renderer branching on a phase name.
No new provider, no core edit (core stays domain-free, doctrine 2). No change to
delivery targets: email (Gmail 102KB clip, Design 04 minimal-white) and argon
`/api/agent-runs`.

## Data flow

1. Tools run per the existing team tasks: `ow_macro_rates`, `ow_argon_policy_path`,
   `ow_uw_market_state`, `ow_uw_gex`, `ow_spot`, `ow_uw_calendar`, `ow_argon_metrics`.
2. Renderer **channel extraction** (new `render/channels.ts`): pulls one named
   scalar per channel out of `report.toolOutputs`, verbatim strings parsed once in code.
3. Renderer writes one **metric row per channel per run** via the existing
   `RunMetric[]` return of `render()` → `runner.ts:1428` `audit.appendMetric`
   (`metric` table, PK `(run_id, name)`, carrying `day` + `label`).
4. **History**: `AuditStore.metricsBetween(from, to)` over the trailing 20 sessions
   (trading days from `cfg.calendar`) supplies each channel's median `|move|`.
5. **Score + rank** (new `quality/select.ts`, deterministic).
6. **Model prompt**: the ranked list, pre-formatted, is injected into the editor's
   input. The model writes prose about row 1 only.
7. **Output JSON** (schema below) → renderer trim → sections → email HTML + text,
   `data` for argon.
8. Renderer writes the checks state file and scores yesterday's.

## Channel table

Move formula operands are copied strings parsed in code; the model never sees the
subtraction. `d1` = prior session's stored metric row for the same name.

| #   | Channel             | Source tool → field                                            | Move                                                            | Sign convention            | History day one               | History accumulated |
| --- | ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- | ----------------------------- | ------------------- |
| 0   | Invalidation breach | prior run's `changeMyMind.series/threshold` vs today's level   | breached / not                                                  | n/a — hard override        | n/a                           | n/a                 |
| 1   | Rates               | `ow_macro_rates` `liveNow` US10Y (replay: `series` DGS10)      | Δ bp vs `d1`                                                    | + = yields up              | `series` DGS10, 20 obs        | metric rows         |
| 1b  | Curve               | same, 2s10s                                                    | Δ bp                                                            | + = steepening             | `series` (DGS2 absent → skip) | metric rows         |
| 2   | Policy              | `ow_argon_policy_path` `meetings[0].payload` hike/cut prob     | Δ pp vs `d1`                                                    | + = more tightening priced | none                          | metric rows only    |
| 3   | Credit              | `ow_macro_rates` `fredDirect` BAMLH0A0HYM2                     | Δ bp                                                            | + = wider = risk off       | `series` BAMLH0A0HYM2, 20 obs | metric rows         |
| 4   | Vol                 | `ow_macro_rates` `liveNow` VIX (replay: `series` VIXCLS)       | Δ pts                                                           | + = vol up                 | `series` VIXCLS, 20 obs       | metric rows         |
| 5   | Dealer              | `ow_uw_gex` `gamma_flip`, `call_wall`, `put_wall` vs `ow_spot` | signed distance spot − flip, in pts; crossing zero = event      | + = above flip             | none                          | metric rows only    |
| 6   | Flow                | `ow_uw_market_state` `marketTide` net premium                  | Δ USD; sign flip = event                                        | + = net call premium       | none                          | metric rows only    |
| 7   | Divergence pair     | two channels above                                             | `min(score_a, score_b)` when signs oppose the stored convention | n/a                        | inherits both                 | inherits both       |
| 8   | Dated event         | `ow_uw_calendar` event dated today                             | fixed                                                           | n/a                        | none                          | none                |

Day-one medians for 1/3/4 come from argon's **daily mirror**, which lags (measured
~9 days, 2026-09-02). That is a dispersion scale, not a level, so the lag is
tolerable — but the renderer records `channel.<id>.medianSource` (0 = series,
1 = metric rows) so a later reader can see which denominator was used.

## Selection algorithm

1. Extract every channel. A channel whose source threw, returned nothing, or whose
   `d1` is absent is **excluded** — it can never be the one thing and never appears
   in prose. Its metric row is written with `value: null` (which is not zero).
2. Channel 0: if a stored invalidation from any un-settled prior run is breached,
   it wins outright, mode = `invalidation`, no score computed.
3. Otherwise `score = |move| / median(|move|, trailing 20 sessions)`. A channel with
   fewer than 20 history points scores only on a **sign flip** (score 2.0) or a
   **dated event landing** (score 2.0); otherwise it scores `null` and is ranked last.
4. Rank by score descending; **ties break by the `#` column ascending** (rates before
   policy before credit …). Deterministic, no randomness, no clock.
5. **Threshold 2.0.** Top score ≥ 2.0 → mode `ratio`. Top score < 2.0 → mode
   `persistence`: the one thing is the longest-running unchanged condition, streak
   length computed by the renderer from metric rows (`"HY OAS inside 6bp for 14
sessions"`); §1 cap drops 180 → 90 words, §4 cap 5 → 3 lines. §2 and §3 stay
   mandatory. **Quiet days are shorter, never padded.**
6. If every channel is excluded, mode `no-data`: no §1, the footer says which
   sources were missing, §2/§3 still required from the prior run's standing view.

## Output schema (the editor returns exactly this)

```
headline        string   ≤14 words, one clause, exactly one number + direction, no colon
oneThing        string   ≤180 words (≤90 in persistence mode). Four beats in order:
                         what moved (≤40) · why this one, using the renderer's supplied
                         phrase (≤25) · mechanism, cause→effect (≤65) · who is hurt, ranked (≤50)
changeMyMind    object   { text: string ≤40 words,
                           series: string,        REQUIRED — a named series or level
                           threshold: string,     REQUIRED — copied verbatim, with units
                           horizon: string }      REQUIRED — sessions or a dated event
checks          array    EXACTLY 3 × { series: string, level: string (verbatim),
                           text: string ≤15 words }
everythingElse  array    ≤5 strings, ≤12 words each, one fact + one number, no connectives
rationales      array    [{ id: string, text: string ≤25 words }] — candidates only
```

No coverage field, no as-of field, no tool name, no section titles: titles are fixed
strings the renderer supplies. `changeMyMind` missing any of the triple → the section
is **dropped and flagged**, never padded.

## Renderer responsibilities

- **Caps are enforced by `trim()`, not by a gate.** `render/budget.ts` gains
  `ONE_THING_BUDGET` keyed by field name (never by phase) and a `measureOneThing()`
  twin of `measure()`, so `quality/index.ts#budgetViolations` and the advisory
  `flash-budget` gate keep measuring the same object. `trim()` cuts at the last
  sentence end inside the budget — which is why §1's beats are ordered so the trim
  takes "who is hurt" first.
- **Footer**, outside the prose budget and outside the model's reach: coverage by
  layer, each source's own as-of string copied verbatim, `queriedAsOf`/`dataDate`
  from `ow_argon_metrics`, `staleSeries` lags, and `degradationFrom(report)`.
- **Scores yesterday's checks**: reads the prior session's checks file, re-extracts
  each named series today, and emits `hit` / `miss` / `not-observed` per check. The
  result is printed as the first line of §1's block and written as metric rows.
- Builds the candidate/positions table and discards anything the model wrote about a
  candidate other than `rationale`.
- Writes the metric rows listed below.
- Phase-ordered logic (prior session, streaks, check scoring) lives in
  `state/checks.ts` and `quality/select.ts`; `render/*.ts` only calls them, so
  `tests/render.spec.ts` "never branches on phase" still passes.

## State files

`<stateRoot>/option-wizard/<day>/<label>.checks.json`, a sibling of the existing
`<label>.regime.json`. Written by the **renderer**, not by core's `stateBlock` lift:
`TenantSpec.stateBlock` is singular and already spent on `regime-state`, and a second
fence from a later step would overwrite the first (`runner.ts:908-921`).

```
{ "day": "2026-09-03", "label": "close",
  "checks": [ { "series": "VIXCLS", "level": "15.20", "text": "…" }, … ],
  "invalidation": { "series": "BAMLH0A0HYM2", "threshold": "2.66", "horizon": "3 sessions" } }
```

Read back by `state/checks.ts` (prior open day from `cfg.calendar`) and by
`ow_review_window`, which already walks that directory with `STATE_FILE`; its regex
widens to `^([a-z0-9-]+)\.(regime|checks)\.json$`.

## Metrics added

Per run, alongside the existing `metaLeakHits` / `budgetViolations` / `causeTitleSimilarity`:

| Name                                               | Meaning                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `channel.rates.d10y_bp`, `channel.rates.d2s10s_bp` | today's move, bp                                     |
| `channel.policy.dprob_pp`                          | Δ front-meeting hike/cut probability, pp             |
| `channel.credit.dhyoas_bp`                         | Δ HY OAS, bp                                         |
| `channel.vol.dvix_pt`                              | Δ VIX, points                                        |
| `channel.dealer.spot_minus_flip`                   | signed distance to gamma flip, points                |
| `channel.flow.net_premium_usd`                     | market-tide net premium                              |
| `channel.<id>.score`                               | that channel's ratio score, `null` before 20 rows    |
| `channel.<id>.medianSource`                        | 0 = daily series, 1 = accumulated metric rows        |
| `select.top.score`                                 | winning score                                        |
| `select.mode`                                      | 0 ratio · 1 persistence · 2 invalidation · 3 no-data |
| `select.streak.sessions`                           | persistence-mode streak length                       |
| `checks.hit`, `checks.miss`, `checks.notObserved`  | yesterday's three checks, scored today               |
| `brief.proseWords`                                 | total model prose after trim                         |

## 复盘 spec

All three windows open with a renderer-built count sheet; the model writes one
paragraph and nothing else (counters before judgement).

**5 days — process only. P/L is forbidden in this document.** Counters from
`ow_review_window` + `metricsBetween`: one-thing hit rate (was the named channel still
rank 1 at +1 and +3 sessions?); `checks.hit/miss/notObserved` summed; invalidations
breached vs honoured; `budgetViolations`; sessions with a missing source.
One question, **≤200 words**: _which channel did I keep over-reading, and which did I
keep missing?_

**10 days — regime.** Counters: distinct one-things; longest run on one channel;
divergence-pair wins; `select.mode` histogram; the phase label **with its numeric
trigger**. One question, **≤250 words**: _did the regime change, and did I say so
before or after it changed?_ Still no P/L.

**21 days — outcome; the only window with P/L,** printed **beside** the same window's
5-day process stats, never below them. Counters: realised P/L by structure, win rate,
expectancy per unit risked, sample size. Under 30 closed trades the document prints
`sample too small to score edge` in place of a verdict. **≤250 words.**

Ledger reads go through `readLedger(stateRoot, "option-wizard", { since })` +
`summarise(records, { deployment?, variant? })` — the defensive dynamic import already
in `ow_review_window` becomes a literal once the peer PR lands. Every cited candidate
is printed by the **renderer**, never model-paraphrased, in exactly this form:

```
<commitmentId> · issued <YYYY-MM-DD phase> · <status> · said p=<forecast> · got <outcome> · Brier <score> (<range>) · bars <sha256 first 8>
<id> · issued <YYYY-MM-DD phase> · pending (<n> of <deadlineBars> bars seen)
```

An absent ledger is one coverage line, not an error.

## Persona rewrite (not appended — replaced; ≤4000 chars each)

**`regime-analyst`** must say: name the cause, cite a verbatim headline, copy every
number, emit the `regime-state` fence. Must **no longer** say: the four-tag menu
(CAUSE/DIVERGENCE/REACTION FUNCTION/BEAT-AND-RAISE) (contradiction 3); "2Y/10Y is a
MANDATORY datapoint every day" (4); "at most FIVE sections, choose the five that
matter" (2); the Layer Coverage table instructions (8 — it moves to the footer); the
uniform 60-word cap (1).

**`editor`** must say: you write about row 1 of the ranked list the renderer handed
you and you may not re-rank; open by scoring yesterday's three checks from the line
supplied; `changeMyMind` needs series + threshold + horizon or it is dropped; the
per-field caps above. Must **no longer** say: "say what CHANGED" without a supplied
delta (7); "choose the five that matter" (2); anything about coverage or as-of (8);
the flat 60-word section cap (1).

**`week-reviewer`** must say: the counters are given to you, answer the one question
for this window, cite settled candidates only by the renderer's line. Must **no
longer**: compute, average, or mix P/L into the 5- and 10-day windows (13).

## Gates

Keep unchanged: `as-of-verbatim`, `cause-citation`, `regime-state`, `design-spot`,
`ib-preflight`. Retarget: `flash-budget` measures `ONE_THING_BUDGET` instead of the
flat 60. Keep `meta-leak` — it becomes near-silent by construction once coverage
leaves prose, and that is exactly the regression detector for the footer move (it has
caught real refusals, so it earns its keep). **One new gate:
`invalidation-triple`** — advisory, `appliesTo: ["editor"]`, refuses when
`changeMyMind` is missing `series`, `threshold` or `horizon`. It is the only rule the
trim cannot enforce, because a missing field is not a length.

## Acceptance

1. As-of replay of **2026-09-03 close** produces the blueprint's structure: headline,
   one 180-word lead, invalidation triple, three checks, ≤5 else-lines, footer.
2. `brief.proseWords` ≤ 420 (blueprint measured ≈235 against 1,747 shipped).
3. `metaLeakHits` = 0.
4. Every channel metric row present in `metric` for the replay run, `null` where the
   source was absent, and `select.mode` recorded.
5. **Two-day replay pair 09-03 → 09-04** proves the check-scoring path: the 09-03 run
   writes `close.checks.json`; the 09-04 run reads it and emits non-null
   `checks.hit/miss/notObserved`.
6. `pnpm typecheck && pnpm test && pnpm test:contracts` green; `core-neutrality`
   unaffected (nothing added under `packages/core/src`).

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

## Rollout — **drop the flag**

No `brief.format: one-thing` extension. A flag means two renderers, two budget tables
and two persona sets alive for a week to protect a path that `git revert` already
protects, and the PIT replay harness can run the old format from the prior sha
whenever a comparison is wanted — that is ceremony without a caught defect (doctrine
6). Instead: run the new format under two as-of replays on the laptop
(`HELIUM_TENANT_DELIVERY` unset, `[TEST]` subject) before `scripts/deploy.sh`, and
roll back with `ln -sfn <old sha> current` if the first live session reads wrong.
Ship as one PR after #92, code + tests + spec together.
