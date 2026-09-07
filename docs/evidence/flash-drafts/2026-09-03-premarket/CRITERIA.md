# 2026-09-03 premarket — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. Step 1 of
`docs/flash/2026-09-07-flash-recovery-plan.md`. Three lines, each with its
source: a verbatim user critique, or `derived` (from the plan's failure table
and from what the frozen inputs actually contain).

**Must report** — the earnings that printed after the 2026-09-02 close and
matter to this universe (AVGO, SNOW), and the day's dated macro: initial
jobless claims today, non-farm payrolls tomorrow.
Source: user, 2026-09-03 — "昨天盘后有avgo 和snow的财报其实还挺重要的把 你没写";
"今天有初请失业。明天有nfp 你也没写".

**Must not claim** — that the day's cause is a recurring headline. "Rates are
still the first cause" as a title that reads the same every morning is not a
claim about this day; the title has to be this day's own conclusion or it is
not one. Nor may the page grow its data-coverage list: that block is to be
smaller, not fuller.
Source: user, 2026-09-03 — "Rates are still the first cause. 这个title 每天会变么？";
"这些内容可以缩小".

**What the reader takes away** — what he has to prepare for before the open:
which overnight prints moved something he holds a view on, which dated numbers
hit the tape today and tomorrow, and what that does to yesterday's calls.
Source: derived, from the two quotes above (both are omissions of preparation
material, not of analysis).

## Input reality — the frozen sample cannot supply the must-report line

Every `ow_uw_headlines`, `ow_uw_earnings` and `ow_uw_calendar` recording in
`docs/evidence/flash-samples/2026-09-03-premarket/tool-io/` is the original
run's `{"unavailable":"as-of"}` refusal, not data. **News, earnings and the
economic calendar are NOT in this sample's inputs.** A draft written from this
sample therefore cannot name AVGO, SNOW, initial claims or NFP without
inventing them, and inventing them is a worse fault than omitting them.

What the sample does carry as data: `ow_macro_rates`, `ow_uw_market_state`,
`ow_argon_metrics`, `ow_argon_policy_path`, `ow_prior_brief`.

Consequence for Step 2: score the must-report line as **not testable on this
sample**. It is testable only on a production run (Step 4). What IS testable
here is the must-not-claim line and the reader takeaway — including whether
the draft says plainly that it has no news, rather than filling the gap.
