# rejected-2026-09-03-premarket

    scripts/flash-mutate.sh page \
      docs/evidence/flash-samples/2026-09-03-premarket/report.md \
      docs/evidence/flash-review/calibration/rejected-2026-09-03-premarket/page.md

Evidence: `docs/evidence/flash-samples/2026-09-03-premarket/tool-io/`.

There is no 2026-09-03 premarket page in
`docs/evidence/pit-replays/2026-09-05/pit-v3/` — that directory holds
`2026-09-01-intraday`, `2026-09-03-close` and `2026-09-04-premarket`. The
frozen sample's own `report.md` (variant `item4`,
`run-c8698f88-05f1-45a9-ac69-81fa4b311f12`) is the 2026-09-03 premarket page,
and it is the one used here.

## Why it is in the calibration set

The recovery plan's Step 1 table records the known failure for this sample:
**AVGO / SNOW earnings missed**. The user rejected the page.

## The one thing this page proves that the weekly does not

Most of its tool calls were as-of refusals, so much of the page is the author
explaining what it could not fetch. That is a different failure shape from the
weekly's — a page that leads with its own plumbing rather than with a market
conclusion — and it is what `leads-with-the-conclusion` and `terse-but-complete`
exist to catch. A reviewer that passes it is reading the apology as content.

`page` removed the same run metadata it removed from the weekly; see that
sample's `SOURCE.md`.
