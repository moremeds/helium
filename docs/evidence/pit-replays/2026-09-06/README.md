# Review framework — acceptance replay, 2026-09-06

**The question.** Does the seven-section review document render from the ledger,
the session frame and the rotation table, on a real run, with the coverage list
complete and every number written by code?

**What came back.** Both documents carry all seven sections in order, 23
coverage rows each (`12 + 10 sectors + 1 theme`, computed from the shipped
`extensions.review` declaration and never a constant), a 15-row focus table on
the weekly and a 5-row one on the close, a 12-row rotation block on the weekly
and none on the close. The ledger moved: 12 commitments and 5 receipts. Three
acceptance bullets could not be verified and are recorded as blocked below,
each with the reason.

**Why it matters.** Section 1 is now the previous period's score, printed at
zero model words, and section 3 cannot shrink. Four defects were found by this
run that no unit test had caught — they are listed at the end, and each one is
a commit on this branch.

---

## What was run

|              |                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / sha | `feat/review-framework` @ `b922f6b`                                                                                                                                                                |
| Runner       | `run-pit-review.sh` (a copy of `run-pit.sh` repointed at `.worktrees/review-framework`, plus `OW_ARGON_API_BASE` mapped from `ARGON_BASE_URL`)                                                     |
| State root   | `$S/pit/review-v5` (`$S` = this session's scratchpad)                                                                                                                                              |
| Delivery     | markdown + the LOCAL argon (`HELIUM_TENANT_DELIVERY=1`, `HELIUM_DEPLOYMENT` unset, so any mail would carry `[TEST] `). Email delivery failed on purpose: `helium-nomail.env` sets no `to` address. |
| Sources      | live Unusual Whales, live local argon, live apex. `MASSIVE_API_KEY` absent.                                                                                                                        |

| variant            | run                                        | phase  | as-of                         | outcome   |
| ------------------ | ------------------------------------------ | ------ | ----------------------------- | --------- |
| `review-v5`        | `run-936e7d89-81ac-4207-9ad1-94b73aed7988` | close  | `2026-09-04T20:15:00Z`        | completed |
| `review-v5`        | `run-091729d0-cce5-4627-9721-9989f26c69f6` | weekly | live (no `--as-of`)           | completed |
| `review-v5-replay` | `run-76a4152d-0237-4005-8679-2e300f79685a` | weekly | `--replay-from run-091729d0…` | completed |
| `review-v6`        | `run-ff4af333-a2b7-4321-8a45-01424aa77fd3` | close  | `2026-09-04T20:15:00Z`        | completed |
| `review-v6`        | `run-347fbbd9-706c-4a6c-a9cf-e2f3860887ff` | weekly | live (no `--as-of`)           | completed |

Earlier variants `review-v1` … `review-v4` were the same pair re-run after each
defect below was fixed; only the final pair is kept here. `n = 1` per variant:
no A/B was run, and no null is claimed.

Artifacts in `review-v1/`: both rendered reports, the full `metric` dump
(`metrics.txt`, 108 rows), and the ledger (`ledger.json`).

## The acceptance bar — fourteen bullets

| #   | Bullet                                                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Artifact                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Every §J.1 section present, in order, seven fixed titles, both documents                                                             | **pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `review-v1/option-wizard-2026-09-0{4-close,6-weekly}.md` |
| 2   | Coverage rows = `12 + \|sectors\| + \|themes\|` = 23, declared order, both documents                                                 | **pass** — 23 lines counted out of the rendered section 3 on both                                                                                                                                                                                                                                                                                                                                                                                                                                                                | same                                                     |
| 3   | Model words within caps                                                                                                              | **pass** — weekly `reviewModelWords` 587 ≤ 900, `.s2` 169 ≤ 300, `.s4` 168 ≤ 400; close 483 ≤ 300? **see note**                                                                                                                                                                                                                                                                                                                                                                                                                  | `metrics.txt`                                            |
| 4   | Metric rows written, `null` not `0` where a source was absent                                                                        | **pass** — `callHitRate`, `verdictBrier`, `focusHitRate` and (on the close) `rotationRows` are empty, i.e. `null`                                                                                                                                                                                                                                                                                                                                                                                                                | `metrics.txt`                                            |
| 5   | `coverageGaps` honest: every `untested` row counted, one `left out:` line each                                                       | **pass** — 18 `UNTESTED` rows, 18 `left out:` lines, `coverageGaps` 18, on both                                                                                                                                                                                                                                                                                                                                                                                                                                                  | rendered section 3                                       |
| 6   | The ledger moved; the close run's settler wrote a verdict receipt naming a real row                                                  | **partial** — 12 commitments (10 `coverage-verdict`, 2 `spy-direction`), 5 receipts, every one `pending` with the reason `no later observation of <rowId> yet`. See "why nothing settled" below.                                                                                                                                                                                                                                                                                                                                 | `ledger.json`                                            |
| 7   | `metaLeakHits` = 0                                                                                                                   | **pass** — 0 on both runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `metrics.txt`                                            |
| 8   | `<state root>/option-wizard/2026-09-04/close.regime.json` carries exactly three `checks` and an `invalidation`                       | **pass** — `checks` length 3, `invalidation` keys `series, threshold, horizon`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | state tree                                               |
| 9   | Exactly 15 focus rows on the weekly, exactly 5 on the close                                                                          | **pass** — 15 and 5 counted out of the rendered markdown; no `shortfall` printed, so the universe was large enough                                                                                                                                                                                                                                                                                                                                                                                                               | rendered section 6                                       |
| 10  | The focus list is byte-identical on replay                                                                                           | **pass for the computed half** — the 15 names, their order, IV rank, implied move and open-call columns are identical between `run-091729d0` and its `--replay-from` replay. The `why` column differs: it is the MODEL's words, and a replay replays tool recordings, not the model. Nothing computed moved.                                                                                                                                                                                                                     | both weekly evidence JSONs                               |
| 11  | N theme rows present; 3d rotation on the weekly with `\|sectorEtfs\|+\|themes\|` rows plus the benchmark footer, absent on the close | **pass** — 12 rotation rows (11 sector ETFs + 1 theme) and one `benchmark SPY …` footer line on the weekly; no `3d rotation` block on the close                                                                                                                                                                                                                                                                                                                                                                                  | rendered section 3                                       |
| 12  | The focus ledger moved: one `focus-admit` per admitted scorable name, each naming its threshold source                               | **fail (no mint), and the reason is data, not code** — 0 `focus-admit` commitments. All 15 focus rows carried a threshold after the second pass, but NONE carried a dated event (`nearest.day` undefined on all 15: no earnings inside the 7-session window, no admitted macro event dated to a name, and no corporate action because `MASSIVE_API_KEY` is absent). A focus admission needs an event WINDOW to settle over, so no commitment can be minted. The threshold half is exercised and verified; the event half is not. | `ledger.json`, frame payload                             |
| 13  | The new metric rows written, `null` where a source was absent                                                                        | **pass** — `focusChurn` 0 (a first period carries nothing, by construction), `focusHitRate` null, `focusWhyRejected` 0, `focusWhyMissing` 10 on the weekly, `themeRows` 1, `themesProposed` 0, `rotationRows` 12 / null, `staleRowsQuoted` 0                                                                                                                                                                                                                                                                                     | `metrics.txt`                                            |
| 14  | `ow_massive_actions` exercised, or its absence recorded                                                                              | **blocked** — **corporate/assignmentRisk unexercised: no `MASSIVE_API_KEY` on this machine.** The frame printed the `actions` layer as `skipped` and the run completed. The tool's live response shape is still transcribed from the provider's documentation and its named `it.skip` still stands; the open question — does `/stocks/v1/splits` return an ANNOUNCED-but-unexecuted split? — is still unanswered.                                                                                                                | frame `coverage`                                         |

### Note on bullet 3

`reviewModelWords` on the close run is **483 against a 300-word `dailyModelWords`
cap**. The per-FIELD caps were all respected (`.s2` 95 ≤ 120, `.s4` 147 ≤ 180);
the overage is entirely `.s3` = 241, which is the sum of the model's per-row
`why` and `observable` clauses across 23 coverage rows. `caps.dailyModelWords`
was written before the coverage table existed and does not budget for 23 rows ×
2 clauses. Recorded rather than adjusted: the number to change is a declaration
in `tenant.yaml`, and changing it to make an acceptance bullet pass would be
scoring the test rather than the work.

### Why nothing settled (bullet 6)

Every receipt is `pending` with `no later observation of <rowId> yet`, and that
is structural for a same-day replay:

- `settleVerdict` compares `commitment.issuedAt` — the REAL instant the runner
  stamped — not the replayed `as-of` day. Both runs happened on 2026-09-06, so
  `openDaysBetween` is 0 for every pair and `settleAfterOpenDays` can never be
  met inside one calendar day.
- The runner settles BEFORE the DAG, so when the weekly's settler ran, the
  weekly's own observation of each row had not been minted yet.

In production the two runs are a day apart and both conditions clear. A replay
harness that wants to close the loop in one sitting would have to settle
against the observation's own `as-of` rather than the issue instant — recorded
as a follow-up, not changed here, because changing the settlement clock to make
a laptop replay close is exactly the kind of test-shaped change doctrine 6
warns about.

### §J.1's footer — which of the four fields exist

§J.1 asks the footer for `tokens in/out · model per role · cost · wall time`.
Checked before writing anything: the `RunReport` step records carry only
`task`, `role`, `mode`, `assembledPrompt` and `output` — **none of the four**.
All four live in the audit `span` table (`input_tokens`, `output_tokens`,
`model`, `cost_usd`, `latency_ms`), which is a query, not a field on the report.
The renderer therefore prints **no** footer usage line and estimates nothing.
For this run the span table says: `weekly-analyst` claude-haiku-4-5 8 in /
2039 out / 22.8 s; `scenario-analyst` claude-opus-4-8 4 / 771 / 38.8 s;
`week-reviewer` claude-opus-4-8 4 / 1079 / 18.0 s.

## Defects this run found that no unit test had

1. **A deterministic step's tool output never reached the renderer.**
   `packages/cli/src/runner.ts` pushes a deterministic step's report row without
   `toolOutputs`; the results live in `step.text` as `<toolName> -> <json>`
   lines. `frameFrom` looked only at `toolOutputs`, so the frame was invisible:
   the first weekly reached argon with no review sections, no focus block and an
   empty masthead. Fixed renderer-side (`toolPayloadStrings`) rather than in
   `runner.ts`, which belongs to another change. — `6ac349f`
2. **`implied_move_perc` is a FRACTION, not a percent.** Verified live against
   AVGO on 2026-09-06: the 2026-09-09 expiry carried `implied_move`
   `8.45730425844076` and `implied_move_perc` `0.02363365728221534` against a
   spot near 357.9. Without the ×100 every focus name cleared a 0.02% bar and
   `focusHitRate` would have read 1.00 for ever. — `f2facc1`
3. **A row the author called `untested` printed `UNTESTED` but was not counted.**
   The document disagreed with itself: 19 `UNTESTED` rows over a `coverageGaps`
   of 16. — `b922f6b`
4. **`ow_uw_iv_term` was never called.** The frame declared the layer skipped
   with "no reader yet"; §G.5's implied move had no source at all. Wired as a
   second pass over the names the frame just chose, with `realizedThreshold`
   over real apex bars as the fallback. — `e9c23e8`

## review-v6 — the same pair after twelve fixes, 2026-09-07

`review-v5` was read defect-by-defect off the delivered `view` JSON rather than
off the markdown step dump, and twelve findings came out of it. All twelve are
fixed on this branch, each with a unit test; four more were found by the v6
rerun itself and are fixed too. `review-v6` is the same pair (`close`
`2026-09-04T20:15:00Z`, then `weekly` live) re-run at `e41c5cb` into a fresh
state root, so the weekly reads the close's own stored levels and the close's
own ledger.

| #   | v5 defect                                                                     | Root cause                                                                                                                                             | v6                                                     |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | `ow_uw_earnings` refused: `Too big: expected array to have <=12 items`        | The frame handed it the whole 45-name universe; the 12 cap is the tool's own model-facing schema guard, and it already makes one round trip per ticker | batched at 12 — `earnings=ok`, 15 of 15 focus rows dated |
| 2   | The delivered `sections[]` opened with the scenario step's own §5             | `buildView` concatenated `[...base.sections, ...review.sections]`                                                                                      | the seven lead, the three windows follow §7            |
| 3a  | Zero calendar rows admitted although both dated sources answered ok           | `ow_uw_calendar` / `ow_argon_policy_path` are frame SIBLINGS: their payloads never reach `report.toolOutputs`                                           | 3 admitted rows, the 9/16 FOMC among them              |
| 3b  | §5 printed "FOMC decision 2026-09-16 … 50.7% hold" over an empty admitted set | the rule lived only in the prompt                                                                                                                      | enforced; the v6 weekly's §5 paragraph was dropped     |
| 4   | `policy.path`, `dealer.positioning`, `flow` printed UNTESTED                  | gex's per-ticker `unavailable: []` read as the payload-level marker (`String([])` is `""`); and nothing ever wrote or read the three prior LEVEL metrics | all three answered; `policy.path` `55.7 → +5.0 pp`     |
| 5   | all ten sector rows UNTESTED                                                  | the frame never supplied `themeBars`, `weekFrom` or the benchmark                                                                                      | all ten priced, `n of n` members, dated by the bars    |
| 6   | `calls.open` asked of the model, answered `untested`                          | it is the ledger's own count, read three lines from where the row is built                                                                             | `- calls.open — 10 — printed from the ledger`          |
| 7   | theme row `untested` / excess `—` beside a priced rotation basket             | same missing bars as 5                                                                                                                                 | `+6.5% (1w)`, equal to the rotation table's `excess1w` |
| 8   | raw floats: `+2.9089`, `2.3634%`, `118.7479 → +0.3896`, `1.3037037037037023`  | `String(n)` everywhere; per-call-site `digits`                                                                                                         | one `quality/units.ts` table, payloads rounded too     |
| 9   | five-field untested row, four fields saying the same nothing                  | —                                                                                                                                                      | three fields, and a priced row prints its number       |
| 10  | `dailyModelWords` 300 against a measured 483                                  | written before the coverage table existed                                                                                                              | 550, with the arithmetic in the yaml                   |
| 11  | §2 cited "receipt DGS10 at 4.77%" over `0 scored`                             | the prompt asked for exactly one largest miss unconditionally                                                                                          | zero-scored is its own one-sentence branch             |
| 12  | "ledger scoreboard unavailable" in all three windows                          | `@helium/cli` was not a dependency — which is why the import went through a `const cliSpecifier: string`; `summarise` was not exported either            | read; empty ledger is `{byGroup: {}}`                  |

Four the rerun itself found: the §2 drop keyed on title PLUS body while
`enforceBudget` trims the body afterwards (`7a70269`); the three-field untested
line said "no datum this period" beside ten rows the frame had just priced
(`9b8ff38`); §5's admitted haystack ignored the row's own `forecast`, so a
correct paragraph was dropped for saying "HOLD" (`e41c5cb`); and `calls.open`'s
level of `0` matched the "9/16" in §4 and faulted the paragraph for restating
a level (`60b476a`, after the v6 weekly ran).

### What the v6 weekly delivered

Sections `1 · Scorecard` … `7 · Open calls` in order, then the week reviewer's
three windows; no scenario block. 23 coverage rows, `coverageGaps` 14. 12
rotation rows plus the benchmark footer, as of 2026-09-04 (`XLE` untested: its
series really does stop at 2026-07-13). 15 focus rows, **all 15 carrying a
dated event** — which is what bullet 12 of the acceptance table could not get.

**The ledger moved, and the focus half of it minted for the first time.** 30
commitments over the pair: 13 `coverage-verdict`, **15 `focus-admit`**, 2
`spy-direction`. 10 receipts, all `pending` — the same-day settlement clock
documented above is unchanged, and was not changed to make this pass.

Two faults on the weekly, both the renderer refusing something:

- `下周展望 restates the level 55.7, which section 3 already printed` — real,
  and the strengthened §4 rule did not stop the model doing it.
- `dated catalysts names ADBE, ORCL, 2026-09-10, … which the admitted rows do
  not carry — the paragraph is dropped` — the author wrote §5 about the focus
  names' earnings dates. Those are dated and real, but they are not on the
  admitted CALENDAR, and whether §5's admitted set should include the focus
  list's own events is a design question, left open.

Tokens per role on the v6 pair (audit `span`, both runs): `editor` opus 4 in /
2717 out / 39.8 s; `regime-analyst` opus 6 / 2259 / 41.7 s; `weekly-analyst`
haiku 3 / 1872 / 22.5 s; `scenario-analyst` opus 6 / 1198 / 34.1 s;
`week-reviewer` opus 4 / 1189 / 19.5 s; `structure-designer` opus 6 / 1106 /
18.7 s; `risk-reviewer` opus 4 / 545 / 9.7 s; `gex-reporter` haiku 3835 / 160 /
3.7 s. 253.7 s of model wall time over the two runs.

### Still open after v6

- **The author answers the macro rows and stops.** All ten sector rows and the
  theme row came back `not called this period` on BOTH v6 documents, over a
  frame that had priced every one of them. The rows print their numbers and
  count as gaps, so the document is honest — but 11 of 23 rows carry a verdict.
  A prompt change, not a renderer one.
- **Nothing settles inside one sitting.** 10 receipts, all pending. Structural,
  documented above, deliberately not changed.
- `MASSIVE_API_KEY` is still absent, so `corporate` and `assignmentRisk` are
  still unexercised.

## Deploy step — not optional

`~/.config/helium/helium.env` on the mini does **not** carry `MASSIVE_API_KEY`
or `MASSIVE_BASE_URL` as of 2026-09-06 (argon holds them elsewhere). **Add both
before the first production weekly after this merge**, or the `corporate` and
`assignmentRisk` focus weights silently score zero in production while a laptop
run looked fine. `OW_ARGON_API_BASE` must also be present on the mini — the pit
runner maps it from `ARGON_BASE_URL`, and that mapping is the acceptance
runner's, not the tenant's.
