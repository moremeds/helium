# Style exemplar — the voice the `edit` step writes in

Extracted verbatim from the approved premarket mockup
(`premarket-mockup-2026-09-03.html`, 3 September 2026). That mockup was written
by one author holding all of the run's data at once; the pipeline writes the
same brief as seven small JSON fragments stitched by a template, and the gap
between the two is what the `edit` step exists to close.

This file is the exemplar quoted into the `edit` task prompt in `team.yaml`.
Keep the two in step: if this changes, the prompt changes.

**These are not facts about any future day.** Every number below belongs to
3 September 2026 and is here to show the SHAPE of a sentence, never to be
reused. Copying a number out of this file into a brief is the exact failure the
exemplar exists to prevent.

---

## Masthead — one sentence, the day's call

> Rates are still the first cause. No candidate ships today.

Short. Two clauses at most. It names the cause and the consequence. It would
read differently on a quiet day than on a violent one — a headline that would
not is not a headline.

## Bottom line — what to do, with the number that forces it

> The 10Y at 4.788% sits about 16bp above its 5 August level; 2s10s is
> +41.3bp. This is a bear-steepener. The market is repricing term premium and a
> firmer policy path, not a cut, and the longest-duration equity pays for it
> first.

> Credit is not corroborating the bearish story. HY OAS at 2.65% has tightened
> 10bp from 2.75% on 5 August, and the prior session closed net call premium
> +124M against net put −33M. Nobody is hedged defensively into tomorrow's
> number.

> **Call.** All eight structures produced today failed the strike-versus-spot
> arithmetic gate. Their strikes were priced against levels 15% to 84% away
> from where the underlyings actually trade. Not one sits near the market.
>
> **Action.** Reject all eight and send the book back to be repriced against
> today's spot. Nothing ships.
>
> **Aggression.** Zero. There is no structure that can be entered.

Note the pattern: number, then what the number means, then what it costs the
reader. Never the reverse, and never the meaning without the number.

## Macro read — a claim as a heading, the evidence under it

> **Rates are the first cause.** The 10Y is 4.788% and the 30Y 5.261%, while
> the 2Y at 4.375% has barely moved. That is a bear-steepener: what is being
> repriced is term premium and a firmer policy path, not a cut. Ranked by
> cash-flow duration, the damage runs in this order. First, the
> longest-duration, profitless story equity, where value is almost entirely
> terminal. Second, big-cap secular growth, where the multiple is the position.
> Third, rate-sensitive REITs and utilities. Short-duration cash-flow
> compounders are hurt least. A 10Y at 4.79% against a 30Y at 5.26% is the
> single most important fact on the tape going into a payrolls week.

> **The most anomalous divergence is gold.** Gold is $4,427.62, up 0.90%, in
> the same tape as a 10Y real yield of 2.44% that has itself climbed from 2.32%
> on 25 August. Gold rising while real yields rise is the anomaly; the bar it
> faced was "real carry is getting more expensive, fade me," and it cleared
> that bar anyway. With the futures path now pricing hike risk and the dollar
> soft at 99.215 (−0.36), gold is trading as a policy-mistake and debasement
> hedge rather than as a real-rate instrument. That is a different buyer from
> the one pricing the 10Y.

> **The "beat-and-raise that closed down" tag is left unassigned today.** The
> label requires three things verified together — the beat, the raise, and the
> red close. This run received no per-name earnings prints or closing changes
> for the watchlist, and the flow and tide data is the prior session, frozen.
> Rather than name a candidate on pattern alone, the tag is recorded as
> unassigned.

A tag left unassigned, with the reason, is a finished paragraph. Reaching for a
name the data does not support is not.

## Scenarios — a trigger band, a curve, an equity consequence

> **A · Base case.** NFP +20k to +90k, unemployment 4.0–4.1%. 2Y grinds up a
> few bp, 10Y and 30Y lead higher; 2s10s steepens toward the mid-40s.
> Longest-duration cohort de-rates, short-duration compounders bleed least;
> gold holds its bid on a soft dollar.

> **B · Hot.** NFP above +90k, or unemployment ticks to 4.0%. 2Y gaps toward
> and through 4.45%, 10Y clears 4.85%, 30Y presses past 5.30%; if the front
> outruns the long end it flattens, and that is the tell that separates B from
> A. Duration equity gaps down; watch whether HY OAS breaks back above 2.70%.

> **Confirms A.** NFP +20k to +90k **and** unemployment 4.0–4.1% **and** 2s10s
> holds or steepens toward the mid-40s **and** HY OAS stays at or below 2.70%.
> All four together, or it does not count.

> **Reverse risk.** The base case is a bear-steepener that grinds duration
> equity lower, so the risk that deserves its own space is a dovish resolution
> that squeezes exactly the cohort path A is short. Prior-session positioning
> closed net call positive, which means the pain trade is up, not down, and
> lightly hedged books get run over on a downside-yield surprise. Two things
> compound it. The 10Y real yield we are leaning on was last observed on
> 1 September, two days stale, so the anchor may already have moved. And
> frozen prior-session flow tells you nothing about how books are hedged into
> 12:30Z tomorrow.

Every path names the observable that separates it from its neighbour. "Both
have a point" is not a scenario.

## Word budget

The exemplar is short on purpose. The 3 September brief that shipped ran to
1,747 rendered words; the reader scans for twenty seconds. Every one of these
is a ceiling, enforced by nothing but this file and the `edit` prompt that
quotes it:

| Field                      | Ceiling   |
| -------------------------- | --------- |
| `headline`                 | 30 words  |
| each `sections` body       | 60 words  |
| each `decision` value      | 25 words  |
| each candidate `rationale` | 40 words  |
| the whole brief            | 800 words |

## What the exemplar never does

- No sentence without a number that came out of a tool this run.
- No "as we noted", "it is worth remembering", "in summary", "going forward".
- No restatement of a level already given in the tape strip or the schedule.
- No hedge that survives every outcome ("markets could go either way").
- No number the author computed. Percentages, spreads and differences are
  quoted as a tool returned them or not written at all.
- No tool name (`ow_spot`, `ow_gex`, `ow_ib_positions`, any `ow_*`) and no HTTP
  status code. The reader does not run the harness: "existing book exposure is
  unverified" is the sentence, not "no ow_ib_positions call".
