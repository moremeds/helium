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

## Step 1 — three frozen samples, one hand-run good version (1–2 days)

Samples, all with tool outputs already frozen under the pit scratchpad:

| sample                                  | known failure                                                           |
| --------------------------------------- | ----------------------------------------------------------------------- |
| 2026-09-03 premarket + intraday         | AVGO / SNOW earnings missed; AVGO paragraph is the one positive example |
| 2026-09-04 premarket → intraday → close | Waller speech missed; close used 9/3 VIX for 9/4                        |
| 2026-09-06 weekly                       | ledger first, restated rows, repeated Focus, unsourced gamma story      |

For each sample, three lines from the user's critique: must report / must not
claim / what the reader takes away.

Produce version C outside the pipeline: a one-off script, Opus, input =
frozen tool outputs + the raw news items + the previous phase's view. New
shape with a fixed page budget, the same for all four phases:

| share | content |
| --- | --- |
| 30% | what we track: status of the focus names, themes and the previous phase's calls (never real positions or PnL) |
| 30% | what changed this period, with source and time |
| 40% | looking forward: continue / reverse conditions, next observation point, what would make us hold, add or drop |

The budget is the author's writing guide and a soft renderer check, not a
hard gate. Coverage, ledger and the full Focus table stay as an appendix.
Intraday and close are increments on premarket, not standalone documents.

Control B: same samples, only `reason.deep` added to the `weekly` task. Half
a day. Settles whether Haiku was the cause.

Exit: the user reads C for the weekly and one daily triple and says the
direction is right. Only human step in the plan until Step 3's exit.

## Step 2 — an acceptance pass that rejects v8b (1 day)

Eight failure signatures, each a concrete check against page text and the
frozen evidence: date conflict; stale data presented as today's; missing
major event; unsourced causal story; duplicated content; ledger before market;
one forecast per row; empty or mechanical Focus reasons. Plus four mutations
of the C draft: swapped date, deleted main event, inserted plausible unsourced
mechanism, "not triggered" rewritten as "correct".

Rules: reviewer model differs from author model; reviewer sees page text,
evidence and rubric only, never JSON counts or the author's self-report;
findings cite the sentence and the evidence.

Exit: rejects v8b, passes C, catches all four mutations, keeps labelled
inference.

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

Old and new run on the same production inputs; only one is delivered. Hold
back one sample from tuning. Readability score and forecast hit rate are
reported separately and never substitute for each other. Only after the
reviewer from Step 2 is stable does it become a helium-self settler.

Token accounting (cache read/write split in `fold.ts`) is a separate PR and
does not count as content improvement.

## What changes in how work is accepted

Before anything is shown to the user: the author's output is read as a page,
by a different model with the Step 2 rubric, and by the session itself. JSON
counts are never reported as evidence of quality again.
