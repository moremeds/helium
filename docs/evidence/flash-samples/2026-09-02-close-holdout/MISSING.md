# What is not in this sample

**Hold-out. Do not read this run's `report.md`, `render.html` or `steps.json`
while tuning the framework.** It exists to be run once, at the end, against a
framework that was never fitted to it.

The 2026-09-02 close was never run at the time and never recorded, so it was
**fetched live on 2026-09-07** with
`scripts/pit-replay.sh record 2026-09-02 close <state root>`, at
`2026-09-02T20:15:00.000Z`. Run `run-d2f22b4b-d9ca-4f15-8ffa-a3e8f3c0e481`,
pit coverage 13/29 — one lower than the 09-04 samples because `ow_x_posts` was
also called and refused here. This is a partial replay: five days had passed,
so every live-only source refused.

**No point-in-time history — refused at the replayed instant.** Sixteen tools
were marked unavailable by the run:

`ow_argon_levels`, `ow_argon_watchlist`, `ow_frank`, `ow_ib_positions`,
`ow_spot`, `ow_strike_check`, `ow_tv_commodities`, `ow_tv_watchlist`,
`ow_uw_calendar`, `ow_uw_chain`, `ow_uw_earnings`, `ow_uw_gex`,
`ow_uw_headlines`, `ow_uw_iv_term`, `ow_uw_ticker_metrics`, `ow_x_posts`.

Nine of them were actually called, so `tool-io/` holds a recording whose `raw`
is the `{"unavailable":"as-of",...}` refusal rather than market data:
`ow_argon_levels`, `ow_argon_watchlist`, `ow_spot`, `ow_tv_watchlist`,
`ow_uw_calendar`, `ow_uw_earnings`, `ow_uw_gex`, `ow_uw_headlines`,
`ow_x_posts`.

**What IS real data** (dated stores that can answer for a past day):
`ow_argon_metrics`, `ow_argon_policy_path`, `ow_macro_rates`, `ow_prior_brief`,
`ow_rotation`, `ow_session_frame`, `ow_uw_market_state`.

**What can never be recovered for 2026-09-02 close.** Everything in the refused
list, as it stood at 16:15 ET that day.

**Errored calls.** None.
