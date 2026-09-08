# 2026-09-04 close — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. **No direct user critique
of this page exists.** All three lines are `derived` — from the plan's failure
table and from what the frozen inputs contain.

**Must report** — how 2026-09-04 resolved against the morning's checks, with
2026-09-04's own numbers. The known fault of this page is that it printed
2026-09-03's VIX as the close of 2026-09-04: a figure carried over from
yesterday and presented as today's is the single failure this sample exists to
catch.
Source: derived — plan failure table, "close used 9/3 VIX for 9/4".

**Must not claim** — that a level is today's when the run only ever saw
yesterday's. Where the day's own datum is missing, the sentence is that it is
missing, not yesterday's number wearing today's date. Same for the candidate:
its id and structure are the ones the premarket published, not a third variant.
Source: derived — plan failure table (stale VIX); user, 2026-09-04 (the
cross-run id mismatch across the day's three phases).

**What the reader takes away** — the day settled or it did not, and the one
thing that carries into tomorrow morning.
Source: derived — plan, C shape: "close: how the day resolved, what carries to
tomorrow".

## Input reality

`ow_uw_headlines`, both `ow_uw_earnings` recordings and `ow_uw_calendar` are
`{"unavailable":"as-of"}` refusals. **News, earnings and the calendar are NOT
in this sample's inputs.** `ow_spot`, `ow_uw_gex` and `ow_argon_levels` are
refusals as well, which is precisely the condition under which a stale figure
gets substituted — so the must-not-claim line is fully testable here.

Data actually present: `ow_session_frame`, `ow_rotation`, `ow_macro_rates`,
`ow_uw_market_state`, `ow_argon_metrics`, `ow_argon_policy_path`,
`ow_prior_brief`.
