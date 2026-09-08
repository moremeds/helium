# What is not in this sample

Nothing was recorded for this phase in 2026-09-04 (the tool-io recorder landed
after `pit-v3`), so it was **re-fetched live on 2026-09-07** with
`scripts/pit-replay.sh record 2026-09-04 premarket <state root>`, at
`2026-09-04T12:45:00.000Z`. Run `run-49226246-88d2-46fe-8ce4-0339744045dd`,
pit coverage 14/29. This is a partial replay: three days had passed, so every
live-only source refused.

**No point-in-time history — refused at the replayed instant.** Fifteen tools
were marked unavailable by the run:

`ow_argon_levels`, `ow_argon_watchlist`, `ow_frank`, `ow_ib_positions`,
`ow_spot`, `ow_strike_check`, `ow_tv_commodities`, `ow_tv_watchlist`,
`ow_uw_calendar`, `ow_uw_chain`, `ow_uw_earnings`, `ow_uw_gex`,
`ow_uw_headlines`, `ow_uw_iv_term`, `ow_uw_ticker_metrics`.

Eight of them were actually called, so `tool-io/` holds a recording whose `raw`
is the `{"unavailable":"as-of",...}` refusal rather than market data:
`ow_argon_levels`, `ow_argon_watchlist`, `ow_spot`, `ow_tv_watchlist`,
`ow_uw_calendar`, `ow_uw_earnings`, `ow_uw_gex`, `ow_uw_headlines`.

**What IS real data** (dated stores that can answer for a past day):
`ow_argon_metrics`, `ow_argon_policy_path`, `ow_macro_rates`, `ow_prior_brief`,
`ow_rotation`, `ow_session_frame`, `ow_uw_market_state`.

**What can never be recovered for 2026-09-04 premarket.** The live quote route,
the TradingView reads, the Unusual Whales chain/GEX/earnings/IV-term/news
endpoints and the argon live rails as they stood at 08:45 ET that morning. No
archive of them exists, here or upstream. The frozen sample is therefore an
input set with a hole in it, and the hole is the same one the 09-03 samples
have — which is what makes them comparable.

**Errored calls.** None.
