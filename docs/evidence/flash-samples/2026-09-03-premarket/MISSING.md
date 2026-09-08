# What is not in this sample

Source: scratchpad variant `item4`, run `run-c8698f88-05f1-45a9-ac69-81fa4b311f12`,
as-of `2026-09-03T12:45:00.000Z`. The original run was itself a point-in-time
replay with no earlier recording to draw on, so nine of its tools refused.

**No point-in-time history (refused in the original run).** `tool-io/` holds a
recording for each of these, but its `raw` is the run's own
`{"unavailable":"as-of",...}` refusal, not market data. Replaying serves that
refusal back, which reproduces the exact context the model saw and adds no
history:

`ow_argon_levels`, `ow_ib_positions`, `ow_spot`, `ow_tv_commodities`,
`ow_tv_watchlist`, `ow_uw_calendar`, `ow_uw_chain`, `ow_uw_earnings`,
`ow_uw_headlines`.

**Never called, so never recorded.** Every other tool in the tenant's
vocabulary — including `ow_frank`, `ow_strike_check`, `ow_uw_gex`,
`ow_uw_iv_term`, `ow_uw_ticker_metrics`, `ow_x_posts`. Their absence is the
model's routing, not a gap in the freeze.

**Errored calls.** One `ow_macro_rates` call threw and was recorded with
`raw: null`; `loadRecordings` does not index an error, so that call is live on
replay. The successful `ow_macro_rates` calls are indexed.

**Step JSON.** None: `item4` predates the per-step evidence dump. `report.md`
and `render.html` are the delivered markdown and the rendered page.
