# 2026-09-04 intraday — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. **No direct user critique
of this page exists.** All three lines are `derived` — from the plan's failure
table, from the user's 2026-09-04 premarket critique where it binds the whole
day, and from what the frozen inputs contain.

**Must report** — what changed between the morning note and midday, and the
Waller speech if it lands inside that window. The candidate ids from the
premarket carry through unchanged.
Source: derived — plan failure table, "2026-09-04 premarket → intraday →
close: Waller speech missed"; user, 2026-09-04 (the premarket put spread and
the intraday bull call spread were the same trade under two ids).

**Must not claim** — a rewrite of the morning at midday length. Where the tape
did not move the thesis, the honest intraday note is short, and shortness here
is a finding rather than a failure to fill the page.
Source: derived — plan, C shape: "intraday: what changed since the morning,
short if nothing did".

**What the reader takes away** — whether to act now or wait for the close.
Source: derived.

## Input reality

This sample has **no `ow_uw_headlines`, no `ow_uw_earnings` recording at all**,
and `ow_uw_calendar` is an `{"unavailable":"as-of"}` refusal. News, earnings
and the calendar are NOT in this sample's inputs; the Waller speech cannot be
named from it without inventing it. `ow_spot`, `ow_uw_gex`,
`ow_argon_watchlist` and `ow_tv_watchlist` are refusals too.

Data actually present: `ow_session_frame`, `ow_rotation`, `ow_macro_rates`,
`ow_uw_market_state`, `ow_argon_policy_path`, `ow_prior_brief`.

Consequence for Step 2: the Waller half is **not testable on this sample**;
"what changed since the morning" and the id continuity are.
