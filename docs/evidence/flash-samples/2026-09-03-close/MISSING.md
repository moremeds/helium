# What is not in this sample

Source: scratchpad variant `argon-local`, run
`run-5d8362f1-fd45-4e83-9972-6f8fc66f08ae`, as-of `2026-09-03T20:15:00.000Z`.
Two variants recorded this phase — `fix-v1` (10/25 available) and
`argon-local` (11/25). `argon-local` is frozen here because it is the strictly
richer of the two; `fix-v1` is not carried.

**No point-in-time history (refused in the original run).** `tool-io/` holds a
recording for each of these, but its `raw` is the run's own
`{"unavailable":"as-of",...}` refusal, not market data. Replaying serves that
refusal back, which reproduces the exact context the model saw and adds no
history:

`ow_argon_levels`, `ow_ib_positions`, `ow_spot`, `ow_strike_check`,
`ow_tv_commodities`, `ow_tv_watchlist`, `ow_uw_calendar`, `ow_uw_chain`,
`ow_uw_headlines`.

**Never called, so never recorded.** Every other tool in the tenant's
vocabulary — including `ow_frank`, `ow_uw_earnings`, `ow_uw_gex`,
`ow_uw_iv_term`, `ow_uw_ticker_metrics`, `ow_x_posts`.

**Errored calls.** One `ow_macro_rates` call threw and was recorded with
`raw: null`; `loadRecordings` does not index an error, so that call is live on
replay. The successful `ow_macro_rates` call is indexed.

**Step JSON.** None: `argon-local` predates the per-step evidence dump. The
rendered page for this day already in the repo is
`docs/evidence/pit-replays/2026-09-05/pit-v3/`, from a different variant;
`report.md` and `render.html` here are this run's own.
