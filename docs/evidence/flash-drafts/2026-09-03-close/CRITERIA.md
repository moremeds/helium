# 2026-09-03 close — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. **No direct user critique
of this page exists.** All three lines are `derived` — from the plan's failure
table, from the fault this run is named for in
`plugins/option-wizard/team.yaml`, and from what the frozen inputs contain.

**Must report** — how the day resolved against the three checks the morning
run wrote, and what carries into tomorrow. When no structure was priced, the
decision block says so in one line and stops.
Source: derived — plan, C shape: "close: how the day resolved, what carries to
tomorrow"; `team.yaml` editor persona, "WHEN THERE IS NO BOOK".

**Must not claim** — a book that never existed. On this run both design and
review returned no proposals and the brief still described strikes far from
spot and a gate failing on every leg; it had never seen a leg. Nor may a step
ship a question to the reader: the same run put "To proceed, I need
clarification: Should I…" into the mail as the GEX section.
Source: derived — `plugins/option-wizard/team.yaml`, editor persona
("On 2026-09-03 close both steps returned no proposals and the brief still
claimed every structure priced strikes far from spot") and gex-reporter
persona ("which is what happened on 2026-09-03 close").

**What the reader takes away** — the day's resolution in a sentence, and the
one thing he should look at first tomorrow morning.
Source: derived.

## Input reality

`ow_uw_headlines` and `ow_uw_calendar` are recorded as `{"unavailable":"as-of"}`
refusals; there is no `ow_uw_earnings` recording. **News, earnings and the
calendar are NOT in this sample's inputs.** `ow_uw_gex`, `ow_spot`,
`ow_uw_chain` and `ow_strike_check` are also absent or refused, so this sample
structurally cannot price a book — which makes it the right sample for testing
the must-not-claim line and the wrong one for testing candidate quality.

Data actually present: `ow_macro_rates`, `ow_uw_market_state`,
`ow_argon_metrics`, `ow_argon_policy_path`, `ow_prior_brief`.
