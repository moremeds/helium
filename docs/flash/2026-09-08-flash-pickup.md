# Flash implementation pickup — 2026-09-08

This continues the paused Claude Code task through implementation and real-page
examples. It supersedes the conflicting product and acceptance instructions in
the September 7 recovery plan; it does not turn the earlier scoring runs into
valid evidence.

## Product decision

Flash reports markets: what happened, why it matters, the evidence behind the
interpretation, and what to watch next. Premarket prepares the day; intraday and
close report the useful increments; weekly explains the market week and its
implications. Length follows that job, not a fixed 30/30/40 ratio or a forecast
for every coverage row.

Our own forecast review, outcomes and scorecard remain internal saved evidence.
They are **not a subsection of the public weekly**, even a small one. Complete
coverage remains available as supporting detail, not the opening argument.
Focus and themes keep useful market judgement; low IV alone does not imply a
directional trade.

## Implemented

- Main, C and C-without-news prompts share that product definition. Internal
  review still runs and remains in saved task outputs. The market author no
  longer has to write about its own calls or fill one forecast per row.
- The producer uses the newest successful nonempty task output, including
  retries. An ordinary editor document cannot be mistaken for a formal market
  review merely because both contain `coverage`. Formal prose survives a missing
  historical frame, with the missing frame stated rather than invented data.
- Argon retains schema 3. Public prose leads the page; weekly supporting coverage
  is a closed native details element. Exact repeated leads and empty supplement
  placeholders are removed. There is no new API, storage schema or dependency.
- Replay serves every tenant tool from saved responses and refuses missing
  recordings. Weekly uses its recorded clock. Delivery is disabled and existing
  input/draft directories are not overwritten.
- The reviewer distinguishes events sharing a date, paginates evidence without
  silently losing events, and still checks factual premises inside labelled
  inference. Saved verdicts must pass citation/page-completeness validation.
- Real Argon routes can read a local adapter serving the actual delivery-channel
  payload. Capture checks both run ID and canonical view hash, saves reader-visible
  text and desktop/mobile images, and checks horizontal overflow. It does not
  score a task transcript or the short email teaser.

## Evidence and limits

See `../evidence/flash-pickup/2026-09-08/README.md` for the exact runs, captures,
checks and replay commands. Each example carries its final `view`, raw recorded
inputs, page text and capture hashes. Rerendered historical author outputs are
identified separately from a fresh model run.

The four old weekly A/B/C/C-without-news recordings were recovered from their
own recorded paths and verified against their raw hashes. They were live runs,
not a controlled same-input comparison; recovery does not change that fact.

The thin daily historical samples contain refusals for news/calendar/earnings.
They cannot establish recovery of missing real-world events. The weekly snapshot
also carries old word caps and data failures; its original gate warnings remain.

## Acceptance order from here

1. Read the actual weekly and daily pages with their limitations visible.
2. Calibrate the reviewer on an accepted positive page and explicit negative
   mutations, using that page's own inputs. Then conduct any blind comparison on
   identical recordings and clocks.
3. Merge/deploy only when authorized. A production shadow week needs fresh
   recorded inputs and separate runtime checks; local tests and screenshots do
   not establish it.

The third batch scoring pass and production deployment remain paused. No claim
is made that a model won, that omitted-news coverage is proven, or that a shadow
week has completed.
