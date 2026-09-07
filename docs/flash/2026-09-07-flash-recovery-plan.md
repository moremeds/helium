# Flash recovery plan (2026-09-07)

Companion to `2026-09-07-flash-executive-summary.md`. Written after the Codex
review of that summary. Status: draft for the user; nothing here is executed.

## Diagnosis in one paragraph

The last week optimised Flash for what code can check: seven sections, a
verdict on every one of 23 rows, word caps, a banned-word filter, a ledger.
None of those is what a PM reads for, and every acceptance pass counted JSON
instead of reading the page. Doctrine 6 says a ceremony stays only if it has
caught a real defect; these caught none and produced the pages the user
rejected. The model was reduced to captioning tables, and the weekly author
has no news tool at all, so even a stronger model can only restate the rows.

Codex's two-part review is agreed with two corrections:

- M1 (rubric) and M2 (prove a good report) collapse into one step. A rubric
  written before a good report exists is a guess. The rubric is extracted from
  the user's own critiques of 9/3, 9/4, 9/5, 9/6, 9/7.
- Version B (routing only) is a half-day control, not a milestone.

## Step 0 — freeze the inputs (half a day)

Correction (2026-09-07, after checking the disk): the runner already records
every tool call of every run, verbatim, under
`<stateRoot>/runs/<runId>/tool-io/` (`packages/cli/src/tool-io.ts`), and
`helium run --replay-from <runId>` serves a run from them. The earlier
version of this table said the tool outputs were missing; they are not.
What is missing is that the recordings live in a session-scoped scratchpad a
fresh session cannot see. Inventory as of 2026-09-07:

| sample                                  | recorded runs (raw tool outputs) in the scratchpad | rendered page / step JSON in the repo                                              | not recorded anywhere                    |
| --------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| 2026-09-03 premarket, intraday          | `item4` (2 runs)                                   | none                                                                               | —                                        |
| 2026-09-03 close                        | `fix-v1`, `argon-local`                            | `docs/evidence/pit-replays/2026-09-05/pit-v3/`                                     | —                                        |
| 2026-09-04 premarket, intraday          | none                                               | premarket page in `pit-v3/`                                                        | both runs (recorder landed after pit-v3) |
| 2026-09-04 close                        | `review-v1` … `review-v8b`                         | `docs/evidence/pit-replays/2026-09-06/review-v1/`, `review-v7/` (with step JSON)   | —                                        |
| 2026-09-06 weekly                       | `review-v1` … `review-v7`, `weekend-2026-09-06`    | `review-v7/` (with step JSON)                                                      | news (the weekly has no news tool)       |
| 2026-09-02 close (hold-out)             | none                                               | none                                                                               | the whole run                            |

Step 0 therefore: move `run-pit-review.sh` into the repo as
`scripts/pit-replay.sh` with a `record` mode (live run, as-of, named state
root) and a `replay` mode (seed a fresh state root from a frozen sample and
run `--replay-from`); copy the chosen recording of each sample, plus its log,
rendered page and step JSON, to `docs/evidence/flash-samples/<sample>/`; fetch
the two missing 2026-09-04 phases and the 2026-09-02 hold-out live with their
original as-of instants, accepting that any tool without point-in-time
history is a partial replay. Each sample carries a `MISSING.md` naming what
was not recorded. The hold-out is never shown to the author or the reviewer
during tuning.

Done 2026-09-07 on `feat/flash-step0` (`docs/evidence/flash-samples/`,
`scripts/pit-replay.sh`). Two limits every later step must respect:

- An as-of replay only sees the tools that have point-in-time history
  (13–14 of 29); the other 10–11 recordings are the refusal the model was
  shown, not data. A/B/C in Step 1 compare authors on those thin inputs.
  The production run sees all 29, so a draft that reads well on a frozen
  sample is not yet proven on production inputs; Step 4 is where that is
  judged. The 2026-09-03/04 production runs predate the recorder, so their
  full inputs cannot be recovered.
- The weekly runs with no as-of and cannot be `--replay-from`ed; its six
  recordings are read directly.

## Step 1 — candidate drafts from the frozen inputs (1–2 days)

| sample                                  | known failure                                                           |
| --------------------------------------- | ----------------------------------------------------------------------- |
| 2026-09-03 premarket + intraday         | AVGO / SNOW earnings missed; AVGO paragraph is the one positive example |
| 2026-09-04 premarket → intraday → close | Waller speech missed; close used 9/3 VIX for 9/4                        |
| 2026-09-06 weekly                       | ledger first, restated rows, repeated Focus, unsourced gamma story      |

For each sample, three lines from the user's critique: must report / must not
claim / what the reader takes away. These are written before any draft.

Three versions per sample, same evidence, same cutoff, same length target:

| version | change                                    | question it answers                  |
| ------- | ----------------------------------------- | ------------------------------------ |
| A       | current pipeline                          | the baseline                         |
| B       | only `reason.deep` on the `weekly` task   | was Haiku the cause                  |
| C       | strong model + evidence input + new shape | is the product design the bottleneck |

The added news input is part of C only; its effect is reported separately
from the shape change (run C once without news to isolate it).

C's shape: lead with the market conclusion; then the content each phase
owes its reader (premarket: prepare the day; intraday: what changed since the
morning, short if nothing did; close: how the day resolved and what carries
to tomorrow; weekly: 2–3 lines of the week, cross-asset evidence, next week's
conditions). Length follows the phase's job, not a fixed ratio. The
30/30/40 split (tracked items / changes / outlook) is the writing guide for
the weekly and premarket, where all three parts exist; it is not enforced by
the renderer and not applied to intraday or close. "Tracked items" means the
focus names, themes and the previous phase's calls, never real positions or
PnL. Coverage, ledger and the full Focus table stay as an appendix.

Exit: three drafts per sample exist with their inputs recorded. No human
reads them yet.

## Step 2 — an acceptance pass, calibrated before it sees C (1 day)

The rubric is fixed before any draft is scored. Eight failure signatures,
each a concrete check against page text and the frozen evidence: date
conflict; stale data presented as today's; missing major event; unsourced
causal story; duplicated content; ledger before market; one forecast per
row; empty or mechanical Focus reasons. Calibration set: the A pages the user
rejected, plus four mutations of a draft: swapped date, deleted main event,
inserted plausible unsourced mechanism, "not triggered" rewritten as
"correct".

Rules: reviewer model differs from author model; reviewer sees page text,
evidence and rubric only, never JSON counts, version labels or the author's
self-report; A/B/C are scored blind in shuffled order; findings cite the
sentence and the evidence; at most two author revisions, then the draft is
returned, not passed.

Exit: rejects every A page and all four mutations, keeps labelled inference,
and produces a per-sample verdict for B and C. C may fail. Only drafts that
pass go to the user: one weekly and one daily triple, with the blind scores
beside them. That is the first human read in the plan.

## Step 3 — wire the shape back into the pipeline (2–3 days)

- `team.yaml`: `weekly` task requires `reason.deep`; weekly role gets the news
  tool input; delete the "one sentence if nothing settled" persona rule, the
  per-row outlook rule, the restate fault and `FOCUS_BANNED_PATTERNS`; word
  caps become structure caps (lead ≤ 3 lines of thesis).
- Renderer: `lead / body / appendix`. Appendix holds coverage, ledger,
  diagnostics. `BriefView` v4 agreed with argon once, before code. First
  screen is the market conclusion; duplicate panels removed.
- Author → fact check (dates, numbers, sources, time boundary, cross-section
  contradictions) → editor (omissions, repetition, unsupported causality) →
  at most two revision rounds → otherwise returned, never marked accepted.
- Verification: Playwright reads the argon page for all four phases, desktop
  and mobile; page text equals approved text.

Exit: the user reads one weekly and one daily triple on the real page.

## Step 4 — shadow week, then helium-self (one trading week)

Old and new run on the same production inputs; only one is delivered. The
hold-out sample fixed in Step 0 is scored once here, never during tuning.
Readability score and forecast hit rate are
reported separately and never substitute for each other. Only after the
reviewer from Step 2 is stable does it become a helium-self settler.

Token accounting (cache read/write split in `fold.ts`) is a separate PR and
does not count as content improvement.

## Step 5 — model comparison under the fixed framework (after Step 4)

Starts only once Step 4 has produced acceptable reports on consecutive days.
Same frozen samples, same prompts, same renderer, same Step 2 reviewer; the
only variable is the model behind the author role (and, separately, behind
the reviewer role). Each candidate is one helium-self experiment: variant =
model, scoreboard grouped by `variant@codeSha`, blind readability score and
cost per run reported side by side. The router normally picks the cheapest
model that satisfies the task's capabilities, so the comparison needs a
per-run model pin that bypasses that choice without editing `team.yaml`;
whether the runner already has one is checked at the start of this step.
Never compare a model on a sample it was tuned on.

## What changes in how work is accepted

Before anything is shown to the user: the author's output is read as a page,
by a different model with the Step 2 rubric, and by the session itself. JSON
counts are never reported as evidence of quality again.
