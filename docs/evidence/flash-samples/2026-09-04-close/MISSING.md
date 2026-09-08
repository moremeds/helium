# What is not in this sample

Source: scratchpad variant `review-v7`, run
`run-e7abdf17-ab5e-4dee-ac74-5d5450bea282`, as-of `2026-09-04T20:15:00.000Z`.
Eight variants recorded this phase (`review-v1` … `review-v8b`); `review-v7` is
frozen because it is the one whose rendered page and step JSON are already in
the repo at `docs/evidence/pit-replays/2026-09-06/review-v7/`.

**No point-in-time history (refused in the original run).** `tool-io/` holds a
recording for each of these, but its `raw` is the run's own
`{"unavailable":"as-of",...}` refusal, not market data. Replaying serves that
refusal back, which reproduces the exact context the model saw and adds no
history:

`ow_argon_levels`, `ow_argon_watchlist`, `ow_spot`, `ow_tv_watchlist`,
`ow_uw_calendar`, `ow_uw_earnings`, `ow_uw_gex`, `ow_uw_headlines`.

**Never called, so never recorded.** Every other tool in the tenant's
vocabulary — including `ow_frank`, `ow_ib_positions`, `ow_strike_check`,
`ow_tv_commodities`, `ow_uw_chain`, `ow_uw_iv_term`, `ow_uw_ticker_metrics`,
`ow_x_posts`.

**Errored calls.** None — every recorded call returned.

`steps.json` is the per-step evidence dump for this run; `report.md` and
`render.html` are the delivered markdown and the rendered page.
