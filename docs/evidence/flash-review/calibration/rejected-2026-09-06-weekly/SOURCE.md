# rejected-2026-09-06-weekly

    scripts/flash-mutate.sh page \
      docs/evidence/pit-replays/2026-09-06/review-v7/option-wizard-2026-09-06-weekly.md \
      docs/evidence/flash-review/calibration/rejected-2026-09-06-weekly/page.md

Evidence: `docs/evidence/flash-samples/2026-09-06-weekly/tool-io/` (9
recordings; the weekly runs live, so none of them is an as-of refusal).

## Why it is in the calibration set

The user scored this weekly 1.5/10 on 2026-09-06. Named faults, from the
recovery plan's own table and the critique behind it: ledger first, restated
rows, repeated Focus reasons, an unsourced gamma story, and a review section
that recaps the market instead of reviewing our own calls with a
continue / reverse / strengthen decision and a reason each.

A reviewer that passes this page has not been calibrated. This is the
denominator.

## What `page` removed

The delivered markdown is a run transcript, not a reader's page. The extractor
drops the run id, the outcome line, the `quality:` metrics line, the pit
coverage line, every gate refusal, the routed model on each section, and the
per-step tool byte counts — all of it the author's self-report, which Step 2
forbids the reviewer to see. What remains is the section text as delivered,
including the author's own structured JSON, because that JSON IS the page's
content here and the `one-forecast-per-row` and `mechanical-focus-reason`
checks are about exactly it.

This is the honest limit of the sample: the reader's real surface was the
rendered page, and what survives here is its text.
