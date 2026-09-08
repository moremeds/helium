# 2026-09-03 intraday — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. **No direct user critique
of this page exists.** All three lines are `derived` — from the plan's failure
table (`docs/flash/2026-09-07-flash-recovery-plan.md`, Step 1) and from what
the frozen inputs contain.

**Must report** — what changed between the 08:45 note and now, and nothing
else; if nothing changed, that sentence is the whole answer and it is a
legitimate one. Where an overnight print (AVGO, SNOW) had been missed in the
morning, the intraday note is the second chance to carry it.
Source: derived — plan failure table, "2026-09-03 premarket + intraday: AVGO /
SNOW earnings missed"; and the C shape in the plan, "intraday: what changed
since the morning, short if nothing did".

**Must not claim** — a fresh cause, a new level or a new verdict that no step
of this run produced; and not a re-run of the morning's document under a new
timestamp. Restating the premarket read at intraday length is the failure, not
the fix.
Source: derived — plan diagnosis, "the model was reduced to captioning tables".

**What the reader takes away** — whether the morning's read still holds at
midday, and if it does not, which observable broke it.
Source: derived.

## Input reality

`ow_uw_headlines` is recorded as an `{"unavailable":"as-of"}` refusal; there
is no `ow_uw_earnings` and no usable `ow_uw_calendar` datum. **News and
earnings are NOT in this sample's inputs.** The morning's miss cannot be
recovered here without fabricating it.

Data actually present: `ow_macro_rates`, `ow_uw_market_state`,
`ow_argon_policy_path`, `ow_prior_brief`.

Consequence for Step 2: the AVGO/SNOW half of the must-report line is **not
testable on this sample**. The "what changed since the morning" half is,
because `ow_prior_brief` is real.
