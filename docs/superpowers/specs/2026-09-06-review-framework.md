# Review framework spec — weekly 复盘+下周展望 and daily close/premarket

Research 2026-09-06. Acceptance criterion: `weekly-review-structure-feedback-2026-09-06`
(user rated run-735e656b weekly 1.5/10). No market number below is new — every
figure is copied from a fetched Frank post or from a brief under
`$S/pit/weekend-2026-09-06/reports/`.

---

## A. Frank's weekly structure

**Corpus: 6 weekly posts, 2026-07-27 → 2026-08-31, English editions** — every dated
post the opencli reader lists (14 rows = 6 weeks × EN/ZH + 2 evergreen stubs;
`--limit 200` returns the same 14 and `/p/weekly-recap-and-outlook` is a 912-byte
stub with no back-links, so 6 weeks is the whole listable archive). ZH is a partial
translation (08/31: 15,246 B vs 32,593 EN); 07/27 is paywall-truncated. Saved as
`$S/research/frank/frank-2026-MM-DD-en.md`.

**Stable spine, all 6 posts, in this order:**

**I. Strategy Review / Strategy Recap** — 244, 253, 285, 289, 317, 367 words
(mean 292). Question: _what did we hold, what did we do with it, and did our
execution hold?_ Position-by-position, each with a named outcome. He always names
the loser — "The only underperformer was the LLY long" (08/31) — and closes on a
process lesson, not P/L: "protecting profits is every bit as important as getting
the direction right" (08/24). Zero market recap. **This is the section our weekly
does not have.**

**II. Market Analysis** — 3,212–6,513 words. Three fixed children:
_(1) Weekly Review_ — index % first ("S&P 500 fell 1.43% to 7,674, the Nasdaq
dropped 2.05% to 26,180, and the Dow declined 0.85% to 53,277", 08/24), then
sector leaders/laggards, then one causal thesis. Its sub-coverage **varies by
week**: Fund Flows (07/27); Global Equity Indices, Commodities (Crude /
Gold-Silver / Industrial Metals), Yield Curve 2Y/5Y/10Y/30Y (08/03, 07/27);
Credit Markets, Major Currencies (08/03); Tech deep-dive (5 of 6); vol (08/17).
_(2) GEX / DEX Structure_ — 5 of 6 posts. Named levels with named roles: "0DTE
call resistance and gamma wall", "full-expiry put support—the true structural line
of defense" (08/31).
_(3) Key Focuses / Key Events This Week_ — 2–3 **dated** catalysts only (PANW Tue
close, AVGO Wed close, nonfarm Fri open — 08/31).

**III. Trading Strategy / Plan for Next Week** — 127–1,063 words. Explicit
positions with the reason ("short XBI, IWM, and CRWV. These three share the same
thesis…", 08/31).

**Scenario device (08/31):** Scenario A/B/C/D, each with a transmission order and
one flagged "**my base case**". Our `scenario-analyst` already copies this.

**Continue/reverse/strengthen vocabulary, counted across the 6 posts:**
`continue` 35, `accelerate*` 24, `reverse/reversal` 16, `confirm` 6, `strengthen`
3, `fade` 3. His word for _strengthen_ is **accelerate**.

**Two findings that set our spec:** (1) his own-review is **first, short, and
length-stable** (~292 words, ~5% of the note) — brevity there is a fixed budget,
not a judgement call; (2) his coverage is **not** actually fixed week to week.
Where the user requires fixed coverage, we must diverge from Frank, not copy him.

---

## B. What the other sources add

| Source                                   | Section / device                                                                                                                                                                                                                                                                    | Scores past vs forecasts                                                                   | URL                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steenbarger, journal method (2 posts)    | entry = one distinctive thing + a goal, and **the next entry reviews that goal**; process and idea journals kept separate                                                                                                                                                           | scores last entry's goal; keeps process review out of P/L                                  | [2019](http://traderfeed.blogspot.com/2019/05/trading-psychology-techniques-1-keeping.html) · [2014](http://traderfeed.blogspot.com/2014/04/the-power-of-trading-journals.html) |
| SpotGamma, Options Key Levels            | same **five** objects every session (Call Wall, Put Wall, Zero Gamma, Vol Trigger, implied move); invalidation = "sustained move through" a named level; base rates 76% / 65%                                                                                                       | forecasts, with a printed base rate                                                        | https://spotgamma.com/options-key-levels-explained/                                                                                                                             |
| Reuters Morning Bid                      | ~400–450-word essay → chart of the day → flat "events to watch" list                                                                                                                                                                                                                | forecast; catalysts are a bottom list, never the body                                      | https://finance.yahoo.com/markets/articles/morning-bid-september-storm-103452894.html                                                                                           |
| 新浪《怎么系统性复盘》                   | fixed count sheet first (涨停/跌停数, 涨跌5%家数, 成交额档位, 振幅档位), judgement after                                                                                                                                                                                            | scores the past by counters before prose                                                   | https://finance.sina.com.cn/tech/roll/2024-11-22/doc-incwxsyk0641841.shtml                                                                                                      |
| 新浪《A股周期情绪战法》                  | 情绪周期 four phases, each with a **numeric** trigger (冰点 涨停<20 连板≤2; 回暖 涨停>30; 高潮 涨停>50; 退潮 龙头跌停)                                                                                                                                                              | a phase label is a forecast only because a number defines it                               | https://finance.sina.com.cn/wm/2026-04-26/doc-inhvvuye8438682.shtml                                                                                                             |
| SpotGamma quarterly report card          | per dated call, a 3-part micro-template: **"Call:" → "What Happened:" → "how it gave traders an edge"**, each anchored to a numeric trigger / "Risk Pivot" level. Vocabulary: "flip to risk-off", "flip back to bullish", "continuing", "extending", "stalling out", "vol snapback" | scores the past, one row per call                                                          | https://spotgamma.com/spotgamma-quarterly-report-card/                                                                                                                          |
| Commoncog on Tetlock, _Superforecasting_ | a call is scorable only if it is (1) unambiguous yes/no, (2) deadline-bearing, (3) probability-bearing, (4) revised only by logging a **new dated forecast**, never overwritten. Brier decomposes into calibration and resolution                                                   | scores the past; explicitly warns humans "construct perfect little stories after the fact" | https://commoncog.com/how-do-you-evaluate-your-own-predictions/                                                                                                                 |
| 情绪周期 stages (eastmoney)              | fixed stage order 冰点→启动→主升→衰退→修复; transition test is **先一致后分歧** (consensus, then divergence decides continue vs reverse)                                                                                                                                            | forecast, gated on a named stage transition                                                | https://m.eastmoney.com/blog/article/928490207                                                                                                                                  |
| Axios Smart Brevity                      | "What's new" → "Why it matters", always in that order                                                                                                                                                                                                                               | neither; ordering rule                                                                     | https://www.axioshq.com/research/smart-brevity-communication-checklist                                                                                                          |
| Howard Marks memos                       | one titled idea per memo                                                                                                                                                                                                                                                            | neither; ranking rule                                                                      | https://www.oaktreecapital.com/insights/memos                                                                                                                                   |

Every row above was fetched (six re-used from `2026-09-06-brief-craft.md`).
**Two families could not be verified and are deliberately absent:** buy-side PM
weekly-memo structure, and an exact Morning Bid / Bloomberg "Week Ahead" table of
contents — searches returned only landing and podcast pages. The spec does not
depend on either. The only hard review-to-outlook ratio we have is Frank's (§A): ~5%.

---

## C. THE SPEC

### C.0 Two rules that generate everything else

1. **A number in the brief is rendered, never narrated.** The model writes _why_
   clauses only. This is the 8/11-wrong-numbers rule already in `editor`.
2. **A verdict is a stored commitment.** Anything the brief asserts about the
   future is appended to the outcome ledger at write time and scored from the
   ledger next period. Nothing is scored from prose.

### C.1 Ledger binding (doctrine 1 & 4)

`readLedger(stateRoot, tenant, {since?})` returns `{commitments, receipts,
baselines}` (`packages/core/src/ledger.ts`, PR #93). At **write** time each
verdict mints a commitment; at **score** time the settler writes a receipt. The
review section is rendered from those rows with the agreed citation line:

```
<id> · issued <YYYY-MM-DD phase> · <status> · said p=<forecast> · got <outcome> · Brier <score> (<range>) · bars <sha256 first 8>
pending: <id> · issued … · pending (<n> of <deadlineBars> bars seen)
```

Direction legs print `t1`/`t5` and `referenceClose.value` in place of `said p`.
**The model never re-narrates a citation line.** A call with no commitment row is
not scored and does not appear — this is what keeps the review small without
letting it drop coverage.

### C.2 Fixed coverage list — declarative, in `tenant.yaml`

Lives beside the existing `extensions.review.windows: [5,10,21]` so helium-self
can diff it (doctrine 2; the host never opens the block):

```yaml
extensions:
  review:
    windows: [5, 10, 21]
    coverage: # ORDER IS THE PRINT ORDER. Rows are never dropped.
      - rates.front # 2Y level + bp change
      - rates.long # 10Y / 30Y level + bp change
      - curve.shape # steepen / flatten, bull or bear
      - policy.path # dated meeting, hike/cut odds
      - credit # HY OAS
      - vol # VIX + term structure
      - dealer.positioning # call wall / put wall / zero gamma
      - flow # ETF tide, sector tide
      - commodities # gold, crude
      - fx # DXY
      - equity.internals # index %, sector leaders/laggards
      - calls.open # our published candidates and forecasts still pending — NEVER real positions/size/PnL (argon page is public; 仓位 is a separate, private project)
    # Focus sectors (user 2026-09-06: 半导体、网络安全、软件、大科技 — "就是我
    # argon watchlist里面的sector相关的股票"). Each entry is an argon
    # watchlist chain name, verbatim from argon `GET /watchlist/chains`
    # (uw_scan/watchlist_taxonomy.py is the source of truth; members come
    # from `GET /watchlist?chain=<name>` via OW_ARGON_API_BASE). One coverage
    # row per entry, same verdict token, same ≤15-word clause. Members and
    # weekly % are renderer-filled from the tool, never model-recalled.
    sectors:
      - Computer/GPU
      - Semi-Logic/ASIC
      - Foundry
      - Semi-Cap/EDA
      - Memory/Storage
      - Cybersecurity
      - Software/SaaS
      - Cloud/Hyperscaler
      - Foundation-Model-Proxy
      - Devices/Endpoint
    verdicts: [continue, reverse, strengthen, fade, untested]
    caps: { weeklyModelWords: 900, dailyModelWords: 300, reviewWords: 300 }
```

`untested` is the only honest way to keep a row when the data was absent — it
prints, it costs one clause, and it is counted as a coverage gap. **This is the
mechanism that makes "terse, never dropped" enforceable rather than aspirational.**

### C.3 Weekly template

| #   | Section             | Purpose                                                                                    | Writer                    | Cap           |
| --- | ------------------- | ------------------------------------------------------------------------------------------ | ------------------------- | ------------- |
| 1   | **Scorecard**       | every call issued last week, settled                                                       | renderer, from ledger     | 0 model words |
| 2   | **上周复盘**        | what held, what missed, the one biggest miss                                               | model                     | ≤300 w        |
| 3   | **Coverage**        | 12 macro rows + one row per `sectors` chain (10), verdict token each; sector members/weekly % renderer-filled from argon | renderer + model clause   | ≤15 w/row     |
| 4   | **下周展望**        | the _why_ behind each non-`continue` verdict                                               | model                     | ≤400 w        |
| 5   | **Dated catalysts** | scheduled events that can flip a verdict                                                   | renderer calendar + model | ≤150 w        |
| 6   | **Open calls**      | published candidates/forecasts still pending — never positions, size, PnL (page is public) | renderer, from ledger     | 0 model words |

Section 1 prints citation lines only. Section 2 may discuss **only** ids that
appear in section 1, and must name exactly one largest miss (Frank's discipline:
a week with no loser was not read carefully). Section 3 is the fixed list — every
row prints even on a quiet week. Section 5 is **one** section, never the outlook
(the 1.5/10 weekly made a CPI/FOMC four-path essay the entire outlook).

**Continue/reverse/strengthen rule.** Each coverage row gets exactly one token
from the closed `verdicts` set, plus one clause of _why_, plus one **observable
that settles it**. Token semantics, fixed:

- `continue` — the same sign and roughly the same magnitude as last period
- `reverse` — sign flips
- `strengthen` — same sign, larger magnitude (Frank's _accelerate_)
- `fade` — same sign, smaller magnitude, trending to nil
- `untested` — the datum was unavailable; counts as a coverage gap

Each token+observable pair is minted as a commitment (§C.1), so **next week's
section 1 scores this week's verdicts**. That is the recursion the user asked for
and the loop doctrine 1 wants.

### C.4 Daily template

Same six sections at one third the size, one phase behind:

- **close** scores that morning's premarket verdicts and today's session against
  them; **premarket** scores yesterday's close.
- Caps: section 2 ≤120 w, section 4 ≤180 w, coverage rows ≤10 w. Total model
  words ≤300.
- Sections 1, 3 and 6 are byte-identical machinery to the weekly — only the
  ledger `since` window changes.

### C.5 How our own calls are pulled and scored

Four sources, all already on disk, all rendered not narrated:

| Source              | Field                                   | Scored as                                                  |
| ------------------- | --------------------------------------- | ---------------------------------------------------------- |
| brief `headline`    | the day's asserted cause                | yes / no / not-observed vs next session's headline         |
| `decision` block    | kept proposals with ids                 | settled from receipt: filled / not triggered / invalidated |
| `overnight` bullets | overnight observations                  | scored only if they carried a threshold                    |
| `regimeState` JSON  | cause, rate levels, tide, thesis        | held / replaced, per `ow_review_window`                    |
| `spyForecast`       | `t1Down` / `t5Down` vs `referenceClose` | Brier, from the receipt                                    |

`yes / no / not-observed` is three-valued on purpose: a call whose trigger never
printed is **not-observed**, never a loss, and never quietly dropped.

**Scorability gate (Tetlock).** A call enters the ledger only if it is unambiguous,
deadline-bearing and probability-bearing; a changed view mints a **new dated
commitment**, never an overwrite. "Rates are the first cause, and the sign flipped
again" should have been three dated commitments, not one re-narrated sentence.

### C.6 Renderer vs model share

Renderer/deterministic: sections 1, 3 (numbers), 5 (calendar), 6, and every figure
everywhere. Model: sections 2 and 4 plus the _why_ clause per coverage row — ≤900
words weekly, ≤300 daily. Holding the model share to roughly one page is what makes
a prompt iteration cheap to A/B via `--replay-from`: tool I/O is recorded, so a
changed prompt is re-scored on identical inputs (doctrine 6).

---

## D. Worked skeleton — week 2026-08-31 → 09-04

Bodies are stubs; only calls found in the copied briefs, no new numbers. Honest
constraint: **only 09-03, 09-04, 09-05 briefs exist in the copied set** — 08-31,
09-01, 09-02 are absent, so those rows print `untested`, not "blank".

**1. Scorecard** (renderer)

- `SPY-2026-09-03-2` · issued 2026-09-03 close · bull call 772/778, inval 765 below · <status from receipt>
- `QQQ-2026-09-03-1` · issued 2026-09-03 close · bull call 716/722, inval 710 below · <status>
- `SLV-2026-09-03-3` · issued 2026-09-03 close · bull call 61/64, inval 60 below · <status>
- spyForecast · issued 2026-09-04 · referenceClose 2026-09-04 = 770.19 · said t1Down=0.50, t5Down=0.55 · pending

**2. 上周复盘** (≤300 w)

- Held: "Rates are the first cause" — carried 09-03 → 09-05 as the named cause.
- Missed: the _sign_, twice. 09-04 premarket "…and the sign flipped"; 09-05
  premarket "…and the sign flipped again" — we kept the cause and lost the direction.
- Largest miss: 09-03 called a 60% 9/16 **HIKE** with SPY +8.01 to 773.17; by 09-05
  odds were 55.7% "up from a 49.3% coin-flip" — the level was re-narrated three
  times and never scored.
- Not-observed: SLV entry required spot >61; brief records spot 60.55 at call.

**3. Coverage** (12 macro rows + 10 sector rows, one line each)

- rates.front — 2Y 4.33% → 4.374% (+3.4bp) — **reverse**
- rates.long — 10Y 4.77% → under 4.77%, 30Y −2.6bp to 5.226% — **fade**
- curve.shape — bull-steepen → bull-flatten → front-end selloff — **reverse**
- policy.path — 9/16 hike odds 49.3% → 55.7% — **strengthen**
- credit — _untested_ (no HY OAS print in this week's briefs)
- vol / dealer.positioning / flow / commodities (gold $4,486) / fx (DXY −0.7) /
  equity.internals (SMH +2.61%, XLY/XLV/XLF sold; TSLA −5.9%, AAPL −2.5%) / book —
  one line each, same shape.

**4. 下周展望** (≤400 w) — one _why_ per non-`continue` row above, each with the
observable that settles it.

**5. Dated catalysts** (≤150 w) — FOMC 9/16–9/17; the CPI path the 09-06 weekly ran.

**6. Book** — the three 09-03 candidates and the 09-04 spyForecast, still pending.

---

## E. Gap list — what has to change

**New tool `ow_argon_watchlist` (read-only).** Reads argon `GET /watchlist/chains`
and `GET /watchlist?chain=<name>` through `OW_ARGON_API_BASE` for each
`extensions.review.sectors` entry; returns `{chain, members[], asOf}`. Weekly %
per member comes from the existing bars tool (`ow_apex_bars` / `ow_uw_ticker_metrics`),
never from the model. A chain name not present in argon's rail prints the row as
`untested (chain unknown)` and counts as a coverage gap — same mechanism as macro rows.
`ow_argon_levels`-style env gating applies (unconfigured on the laptop by design).

**Privacy check (user 2026-09-06: argon page is public).** `universe-builder`
still reads `ow_ib_positions`. team.yaml already forbids quantity/size/account
value, but the held ticker NAMES can still reach a public page. Decide: drop the
tool from the role, or keep it and add a renderer gate that refuses any brief
naming a ticker that appears only in positions. Open item, user's call.

**`weekly-analyst`.** Today it is told to "write the week … which calls worked,
which did not" from `ow_reports` prose. It must instead read the **ledger** for
section 1 and be forbidden from settling anything not in it. Its tool list gains a
ledger read; its persona loses "settle each of the week's numbered calls by name"
(the renderer does that) and gains the ≤300-word cap and the one-largest-miss rule.
Its `下周展望` prompt must be re-specified from "A/B/C/D with a base case" to
"one verdict token per coverage row"; A/B/C/D moves to section 5, bounded.

**`week-reviewer`.** Two changes. (a) Its three windows (5/10/21) are the right
denominator but produce a _process_ report; it must feed section 1's counters, not
write its own page. (b) **Defect to fix first:** `ow_review_window` builds a
session from `stateRoot/option-wizard/<day>/*.json` regime-state records, which
only began being written in PR #92 (merged 1317718, 2026-09-06). For every earlier
day the record dir is absent, and the persona's rule "a window whose sessions are
empty is reported as empty" turned that into the 09-06 weekly's claim that
20 of 21 sessions were "not written" — while the briefs for those days exist on
disk. **A missing regime-state block must report as `regime: unavailable`, never
as a missing session**, and session existence must be decided by the report file.

**`scenario-analyst`.** Keep it — its A/B/C/D with transmission order is the one
part of the 09-06 weekly that was any good. Demote it: it produces section 5 only,
under the ≤150-word cap, and its base case is minted as a commitment so next week
scores it.

**Also required:** the `extensions.review.coverage` block (§C.2); a settler that
writes receipts for verdict commitments; and section 1/3/6 renderers.

---

## F. How helium-self measures that a change here was an improvement

Re-using the agreed "improved" definition (`option-wizard-quality-loop-2026-09-05`):
a commitment is minted when the PR **opens**, carrying
`{id: prNumber, payload: {headSha, backlogItem, metric, direction, window, baseline}}`.
The agent picks the backlog item; **it never picks the yardstick**.

New `metric` rows (core table `metric(run_id, name, value, ts, day, label)`),
alongside the existing `metaLeakHits` / `budgetViolations` / `causeTitleSimilarity`:

| name                  | label                            | direction |
| --------------------- | -------------------------------- | --------- |
| `callsScored`         | phase                            | up        |
| `callsOutstanding`    | phase                            | down      |
| `callHitRate`         | window (5/10/21)                 | up        |
| `verdictBrier`        | coverage row id                  | down      |
| `coverageGaps`        | phase — count of `untested` rows | down      |
| `reviewModelWords`    | section id                       | down      |
| `ledgerCitationCount` | phase                            | up        |

**Settlement.** Window = N production runs after the merge sha; baseline = the
same metric over the N runs before the base sha. `deployment=production,
variant=live` only; `span.code_version` ties runs to the merge sha. Not merged by
window end → `not-merged`; fewer than N production runs since merge → `pending`;
else `improved | regressed | flat` with `{delta, baseline, after, n}`. Mean over N,
no significance test in V0.

**The one query.** "Did the prompt change improve the brief" =
`SELECT name, avg(value) FROM metric WHERE name IN ('callHitRate','verdictBrier','coverageGaps','reviewModelWords') GROUP BY name`
over the two spans. Because verdicts are commitments (§C.3), `verdictBrier` and
`callHitRate` can only improve if the brief got _more right_ — not merely more
fluent. That is what the 1.5/10 weekly lacked, and what doctrine 1 needs the next
Helium iteration to be able to check on itself.

## G. Focus list — 15 weekly / 5 daily, deterministic (added 2026-09-06)

User: "每周 shortlist 15只股票重点关注，每天shortlist 5只，注意需要的methodology而不是拍脑袋那种每次run都会不一样。关注的意思是财报、重大事件、corporate action、拆股、进出指数等等，不一定是会涨跌。"

### G.0 Two rules
1. **The list is computed, never chosen.** A renderer step (`focus-clerk`, `requires: []`, same shape as `frame-clerk`) scores every ticker in the universe from dated event feeds with fixed weights. The model writes one "why watch / what would matter" line per name and nothing else. Same inputs → same 15, byte-identical. `--replay-from` proves it.
2. **Stickiness.** A name stays on the weekly 15 until its admitting event has settled (event date + 1 session). Churn is a printed metric (`focusChurn` = names dropped that had not settled), target 0.

### G.1 Universe
argon watchlist (all chains in `extensions.review.sectors` ∪ `pinned`) ∪ TV flag lists. Same source as tickers of interest (Addendum B); nothing outside it can be on the list, so a hallucinated ticker cannot enter.

### G.2 Event feeds (all already tools or one call away)
| event | source | horizon field |
|---|---|---|
| earnings | `ow_uw_earnings` (`daysToEarnings`) | days |
| index add/remove, split, rebalance, dividend | UW `get_market_events` / calendar (`ow_uw_calendar`) — verify shape before use | days |
| macro on the tape that names the sector (FOMC, CPI, tariff dates) | `ow_uw_calendar` | days |
| flow / IV anomaly | `ow_uw_ticker_metrics`, `ow_uw_iv_term` (IV rank ≥ 80 or 30d vol ratio ≥ 2×) | today |
| theme membership | §H register | horizon of theme |
| open ledger call on the name | `readLedger` commitments | settle date |

### G.3 Score (fixed, in `tenant.yaml extensions.review.focus`)
```yaml
focus:
  weekly: 15
  daily: 5
  weights:            # points; event inside window earns full, decays linearly to 0 at horizon
    earnings:      10   # window 0–7 sessions
    corporate:     8    # split / index / rebalance / spin — window 0–10 sessions
    macroNamed:    4    # sector-named macro print, 0–5 sessions
    openCall:      6    # we have a pending commitment on it
    theme:         3    # per active theme it belongs to
    flowAnomaly:   3    # today only, no decay
    pinned:        2    # argon pinned
  tieBreak: [score, daysToNearestEvent, ticker]   # ticker alphabetical last, so ties are stable
```
Weekly 15 = top 15 by score computed Sunday from the coming 10 sessions. Daily 5 = the 5 of those 15 (fall back to universe if <5) with the nearest event, recomputed each morning; a name whose event is today always ranks first.

### G.4 Output row (renderer)
`TICKER · event (date, session pre/post) · why it matters (model, ≤ 20 words) · IV rank · our open call if any`. Coverage rule from C.0 applies: exactly 15 / exactly 5 rows, or the row says why not.

### G.5 Settlement — was it worth watching
Each admitted name mints a commitment `kind: "focus-admit"`, claim: |move over event window| ≥ 1× the ATM implied move (from `ow_uw_iv_term`). Settled by the settler like verdicts. Metric `focusHitRate` printed in Scorecard §1. This is what turns "关注" from a feeling into a number, and lets a future weight change be judged (§F).

### G.6 Not in the list
No direction. No sizing. No "hot stock" reasoning from the model. Names outside the universe are proposals (§H.3), not admissions.

## H. Theme / rotation register (added 2026-09-06)

User: "板块轮动，比如最近厄尔尼诺 所以中长期利好农产品这样的".

### H.1 Declarative, in `tenant.yaml extensions.review.themes`
```yaml
themes:
  - id: el-nino-ag-2026
    thesis: "El Niño 2026 tightens soft/grain supply; medium-term bid for ag inputs and grain"
    horizon: 6m
    entered: 2026-09-06
    instruments: [DBA, MOS, NTR, DE]          # what we watch, not what we hold
    evidence:                                 # pollable — balder's admission gate
      - "NOAA ONI monthly ≥ +0.5 for 3 consecutive months"
      - "CBOT corn/wheat front-month vs 20d"
    kill: "ONI < +0.5 two months running, or instruments underperform SPY by 10% over 60 sessions"
```
Admission gate (from balder): a theme lands only with a pollable evidence source, a horizon, and a kill condition. No kill condition, no theme.

### H.2 Each theme is a coverage row
Appended to the 22 coverage rows (12 macro + 10 sector + N themes). Weekly verdict per theme {continue, reverse, strengthen, fade, untested} minted as a commitment, settled at horizon or at kill, Brier-scored like everything else. The verdict line prints the excess-move triple: instruments basket vs SPY over the week and since `entered`, computed by renderer from `ow_apex_bars` / `ow_spot` (LLM never does arithmetic).

### H.3 Proposals
The model MAY propose a theme (in §4 outlook) as `PROPOSED: <id> — <thesis> — evidence: <source>`. A proposal is not a row and never enters focus scoring; the operator promotes it by editing the yaml (a PR, so it is reviewed and dated). This keeps the register stable across runs and keeps the model from inventing rotations each Sunday.

### H.4 Rotation view (renderer, no model)
One table per weekly: 11 sector ETFs + theme baskets, 1w / 4w / 12w return relative to SPY, from `ow_apex_bars`. Rank order is the rotation signal; the model gets one sentence on whether this week's leadership confirms or contradicts each active theme.

## I. Supplements the PM will want (added 2026-09-06, my additions)
Ordered by cheapness; all fit G.2 as extra event rows or H as themes.
1. **Options-specific dates**: monthly OPEX / quad witching, ex-dividend inside an open call's window (assignment risk), FOMC blackout. All calendar-derived, zero model.
2. **Lockup expiries and secondary offerings** for recent IPOs in the universe — a corporate event with a known date and a known direction of supply.
3. **Index rebalance dates** (S&P quarterly, Nasdaq-100 annual in Dec, Russell June) as macroNamed events for every universe member, so the week is flagged even when no specific add/remove is announced.
4. **Analyst/product days** (GTC, WWDC, re:Invent, earnings-adjacent investor days) — needs a hand-kept list in yaml; only worth it if G.5 shows they move names.
5. **Seasonality as a base rate**, not a call: UW `get_market_seasonality` / `get_average_return_per_month_by_ticker` printed as "n years, mean, hit rate" next to the name. Pure conditional base rate with n — the balder method — and the first place `ow_base_rate` (Addendum C5) can land.
6. **Focus-list settlement drives weights.** After ~8 weeks of `focusHitRate` by event type, re-weight G.3 from data; until then weights are a declared prior, printed as such.

## J. The complete shape (added 2026-09-06; supersedes C.3/C.4 section tables where they differ)

### J.1 Weekly (Sunday, pre-session)

```
header   as-of · code sha · run id · "complete since <first commitment>, none deleted"   [renderer]

1  Scorecard              [renderer, 0 model words]
   n issued / n settled / n untested (excluded from denominator, printed)
   callHitRate · verdictBrier · focusHitRate · coverageGaps · focusChurn
   one citation line per settled call:  id · claim · outcome · Brier
   calibration sentence (≥10 receipts): "we said 70%, it happened 55% — too confident"
   "what we left out": rows marked untested and why

2  上周复盘               [model ≤300 w]
   only ids from §1; exactly one biggest miss; one claim we killed
   "figures not to quote": stale numbers the renderer flagged

3  Coverage               [renderer rows, model ≤15 w clause]
   3a  12 macro rows       verdict token · why · observable that settles it · prints vs forecast
   3b  10 sector rows      + member count · weekly % (argon) · same verdict shape
   3c  N theme rows        + basket vs SPY 1w / since entered · verdict · kill-distance
   3d  rotation table      11 sector ETFs + theme baskets: 1w 4w 12w vs SPY, ranked   [0 model words]

4  下周展望               [model ≤400 w]
   the why behind every non-continue verdict in §3
   one sentence per theme: this week's leadership confirms / contradicts
   PROPOSED: <id> — <thesis> — evidence: <pollable source>     (rendered, never scored)

5  Dated catalysts         [renderer calendar + model ≤150 w]
   next 10 sessions: macro prints, OPEX/quad witching, index rebalance dates, FOMC blackout
   admission gate: pollable source · watching-for · bounded outcomes

6  Focus 15                [renderer list, model ≤20 w per row]
   rank · TICKER · event (date, pre/post) · IV rank · implied move · our open call id · why watch
   sticky flag (carried from last week) · exactly 15 rows or the row says why not

7  Open calls              [renderer, 0 model words]
   pending candidates / forecasts / verdicts / focus-admits with settle dates
   never positions, size, PnL

footer   tokens in/out · model per role · cost · wall time   [renderer, metric table]
```

Model words total ≤ 900 (§2 + §4 + row clauses + focus lines).

### J.2 Daily (premarket 08:45 ET and close)

Same seven sections, one phase behind, one-third size:

```
1  Scorecard      yesterday's close verdicts (premarket) / this morning's verdicts (close)
2  复盘 ≤120 w    one miss, one kill
3  Coverage       same 22+N rows, clause ≤10 w; rotation table 1d/1w only
4  展望 ≤180 w    non-continue rows only; no PROPOSED (weekly only)
5  Catalysts      today + next session
6  Focus 5        the 5 of the weekly 15 with nearest event; today's event ranks first
7  Open calls     same machinery, ledger `since` = last phase
```

Model words ≤ 300.

### J.3 What each section mints and who settles it

| section | commitment kind        | claim                                         | settled by          | metric        |
| ------- | ---------------------- | --------------------------------------------- | ------------------- | ------------- |
| 3a/3b   | coverage-verdict       | token + observable + threshold                | next period settler | verdictBrier  |
| 3c      | coverage-verdict       | theme token; kill condition                   | horizon / kill      | verdictBrier  |
| 4       | (none)                 | PROPOSED is prose                             | operator via PR     | —             |
| 5       | (none)                 | calendar is input, not a call                 | —                   | —             |
| 6       | focus-admit            | \|move over event window\| ≥ ATM implied move | event date + 1      | focusHitRate  |
| brief   | headline / spyForecast | as C.5                                        | next session        | callHitRate   |

Every number on the page comes from a tool or the renderer. The model contributes: §2, §4, one clause per coverage row, one line per focus name. Nothing else.

### J.4 Declarative surface (tenant.yaml `extensions.review`)

```yaml
review:
  verdicts: [continue, reverse, strengthen, fade, untested]
  macro: [...12 rows...]
  sectors: [...10 argon chains...]
  themes: [...H.1 entries, each with evidence + kill...]
  focus: {weekly: 15, daily: 5, weights: {...G.3...}, tieBreak: [score, daysToNearestEvent, ticker]}
  caps: {weeklyModelWords: 900, dailyModelWords: 300}
```

Changing the brief = editing this block or a prompt; both are replayable via `--replay-from` and scored by §F.

## K. Notes 2026-09-06 (later)
- User: corporate actions (拆股/spin-off) are only reliably known from company filings; massive.com carries executed splits and ex-dividends but no guaranteed pre-announcement. Index rebalance is the one worth digging into properly — **not now**, follow-up.
- Deliverable the user actually wants next: the PROMPT shape (what each role is handed, writes, may not do) and the REPORT shape (the rendered page as a template), not the task table. Written into the v2 plan as Task 15 personas + §J; presented in chat 2026-09-06.
