# 2026-09-04 premarket — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. Step 1 of
`docs/flash/2026-09-07-flash-recovery-plan.md`.

**Must report** — the day's dated catalysts, including the Waller speech, and
what carries from 2026-09-03's calls. A candidate that appears at premarket
carries the same id and the same structure through intraday and close; the
premarket put spread and the intraday/close bull call spread were the same
trade wearing two names.
Source: user, 2026-09-04 (the cross-run id mismatch he flagged between the
premarket put spread and the intraday/close bull call spread); plan failure
table, "2026-09-04 premarket → intraday → close: Waller speech missed"
(`derived` for the Waller half).

**Must not claim** — a source line beside every figure, and three single names
in a section that is not about single names. Neither is analysis; both are
page furniture the reader did not ask for.
Source: user, 2026-09-04 — "不用写source"; three single names "有点不合适放在这里".
The price box grouping is the same complaint one level up: "price box 可以重新
group一下".

**What the reader takes away** — one coherent view of the day before the open:
grouped prices, dated events, and the same trade identity he will see again at
midday and at the close.
Source: derived, from the three quotes above.

## Input reality — the Waller speech is not reachable from this sample

Both `ow_uw_headlines` recordings, the `ow_uw_earnings` recording and the
`ow_uw_calendar` recording in
`docs/evidence/flash-samples/2026-09-04-premarket/tool-io/` are
`{"unavailable":"as-of"}` refusals. **News, earnings and the economic calendar
are NOT in this sample's inputs**, so the Waller speech cannot be named from
this sample without inventing it. `ow_spot`, `ow_uw_gex`, `ow_tv_watchlist`
and `ow_argon_watchlist` are also refusals, so the price box has thin material.

Data actually present: `ow_session_frame`, `ow_rotation`, `ow_macro_rates`,
`ow_uw_market_state`, `ow_argon_metrics`, `ow_argon_policy_path`,
`ow_prior_brief`.

Consequence for Step 2: the Waller half of the must-report line is **not
testable on this sample**; the cross-phase id consistency half is testable
against the 2026-09-04 intraday and close drafts of the same variant.
