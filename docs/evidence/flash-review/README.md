# Step 2 — the acceptance pass, calibrated before it sees a draft

`plugins/flash-review` is a tenant with one job: read one page as its reader
would, check it against a fixed rubric and the run's own frozen recordings, and
return a verdict. It was calibrated on 2026-09-07 against pages whose verdict
was already known — two the user rejected, and four single-defect mutations of
one of them — before any Step 1 draft existed. No draft was read, produced or
looked for while this was built.

Run one:

```bash
HELIUM_ENV_FILE=<provider env file> scripts/flash-review.sh \
  docs/evidence/flash-review/calibration/<page>/page.md \
  docs/evidence/flash-samples/<sample>/tool-io \
  <scratch state root> <label>
```

The verdict, the routed model and the token counts land in
`<page-dir>/review/<label>.md` and `<label>.audit.json`.

The reviewer has four tools: `fr_rubric`, `fr_page`, `fr_evidence` and
`fr_dated_events`. The last is a deterministic pre-pass added in round 4 — see
"the missing-event check" below for why a fourth tool earned its place.

## The calibration set

| directory                       | what it is                                                   | evidence                                            |
| ------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `rejected-2026-09-06-weekly`    | the weekly the user scored 1.5/10                            | `flash-samples/2026-09-06-weekly/tool-io`           |
| `rejected-2026-09-03-premarket` | the premarket page whose known failure is missed earnings    | `flash-samples/2026-09-03-premarket/tool-io`        |
| `m1-swapped-date`               | one date changed in the scenarios lead                       | the weekly's                                        |
| `m2-deleted-event`              | every mention of the 2026-09-16 FOMC removed                 | the weekly's                                        |
| `m3-unsourced-mechanism`        | one plausible unsourced mechanism sentence inserted          | the weekly's                                        |
| `m4-miss-as-hit`                | a "failed to trigger" rewritten as "behaved as called"       | the weekly's                                        |

Both halves are built by `scripts/flash-mutate.sh`: `page` strips a run
transcript to reader text, `mutate` applies the four fixed substitutions and
refuses to write a copy identical to its source. The hold-out
(`flash-samples/2026-09-02-close-holdout`) was never opened.

## Results

Every row is one `helium run flash-review`. Tokens are `in / out / cache-read`
from the `span` table; the model is the one the router chose, read from that
same table, not from the log.

| page                            | round | run id                                       | reviewer model         | tokens in/out/cache | usd     | wall | verdict  | signatures returned                                                                        | kept_inference |
| ------------------------------- | ----- | -------------------------------------------- | ---------------------- | ------------------- | ------- | ---- | -------- | ------------------------------------------------------------------------------------------ | -------------- |
| `rejected-2026-09-06-weekly`    | r1    | `run-d778cbcc-522e-44ea-bc55-142fd579fc8b`   | `dsh:claude-opus-4-8`  | 8 / 6199 / 41328    | $0.1550 | 85s  | **fail** | ledger-before-market; one-forecast-per-row; stale-as-today                                  | 3              |
| `rejected-2026-09-03-premarket` | r1    | `run-6b7a290b-bab4-46f8-83ff-9e2dca13b2cc`   | `dsh:claude-opus-4-8`  | 10 / 3541 / 86750   | $0.0886 | 54s  | **fail** | leads-with-the-conclusion; duplicated-content                                               | 5              |
| `m1-swapped-date`               | r1    | `run-b2b9a0fb-7f0f-4d70-b213-521e881733ae`   | `dsh:claude-opus-4-8`  | 10 / 5570 / 75085   | $0.1393 | 92s  | **fail** | **date-conflict** (blocking); one-forecast-per-row; unsourced-causal-story; stale-as-today  | 1              |
| `m2-deleted-event`              | r1    | `run-db46b984-0d3b-4b71-801c-e7ffcf18b2de`   | `dsh:claude-opus-4-8`  | 12 / 7928 / 156054  | $0.1983 | 113s | **fail** | stale-as-today; unsourced-causal-story ×2; one-forecast-per-row                             | 2              |
| `m2-deleted-event`              | r2    | `run-13ab93b8-3ec7-4668-bd34-3256a3726d02`   | `dsh:claude-opus-4-8`  | 12 / 8435 / 150907  | $0.2109 | 121s | **fail** | stale-as-today; unsourced-causal-story; leads-with-the-conclusion                            | 3              |
| `m2-deleted-event`              | r3    | `run-44ef292d-fecd-4757-a490-6efdd5d3dc97`   | `dsh:claude-opus-4-8`  | 14 / 9793 / 215911  | $0.2449 | 138s | **fail** | one-forecast-per-row; leads-with-the-conclusion                                             | 4              |
| `m2-deleted-event`              | r4    | `run-d8d3b17b-16cd-487e-8507-664a7fdd76e1`   | `dsh:claude-opus-4-8`  | 14 / 9634 / 250891  | $0.2409 | 126s | **fail** | **missing-major-event** (blocking); date-conflict; one-forecast-per-row                     | 3              |
| `m3-unsourced-mechanism`        | r1    | `run-c83745d6-8362-4758-a7f5-35b0d1a27481`   | `dsh:claude-opus-4-8`  | 8 / 4683 / 47197    | $0.1171 | 67s  | **fail** | leads-with-the-conclusion; weekly-is-our-review; **unsourced-causal-story**; one-forecast-per-row | 1        |
| `m4-miss-as-hit`                | r1    | `run-3c6c8caa-fe53-4318-8ad7-6d4505c0f5f8`   | `dsh:claude-opus-4-8`  | 8 / 4158 / 45171    | $0.1040 | 58s  | **fail** | **weekly-is-our-review** (blocking); one-forecast-per-row                                   | 2              |
| `m4-miss-as-hit`                | r4    | `run-ec4e374f-a826-4402-be99-d0cbfcf29d1b`   | `dsh:claude-opus-4-8`  | 14 / 8145 / 254673  | $0.2037 | 105s | **fail** | **weekly-is-our-review** (blocking); missing-major-event ×2                                  | 3              |

### Did the finding point at the right sentence?

| page                            | verdict as required | finding names the defect                                                                 |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `rejected-2026-09-06-weekly`    | yes — rejected      | yes: `ledger-before-market` cites "Process statistics first."                             |
| `rejected-2026-09-03-premarket` | yes — rejected      | partly, see below                                                                          |
| `m1-swapped-date`               | yes — rejected      | **yes**, verbatim: "…the SPY ETF tide underlying at the final 2026-09-02 print: 770.19."   |
| `m2-deleted-event`              | yes — rejected      | **r1-r3 no; r4 yes** once `fr_dated_events` existed — see below                             |
| `m3-unsourced-mechanism`        | yes — rejected      | **yes**, verbatim: "Dealers rebalanced into the Friday close, and that hedging flow is…"   |
| `m4-miss-as-hit`                | yes — rejected      | **yes**, verbatim in both r1 and r4: "…vol behaved as called, extending below 14.25 as expected…" |

Labelled inference was kept every time: 1–5 sentences per run in
`kept_inference`, none of them reported as a finding.

## The missing-event check: three failed rounds, then a tool

**`m2-deleted-event` is now caught, in round 4, for the right reason.** Three
prompt rounds could not get there; a fourth prompt round was not tried. What
changed is that the enumeration moved out of the model and into code.

What each round taught:

1. **r1 — the mutation was the defect, not the reviewer.** The first M2 removed
   only the catalysts sentence. The page went on naming "9/16" in three other
   places, so there was no missing event to find and the reviewer was right not
   to report one. The mutation was rewritten to remove all four mentions, and
   `flash-mutate.sh` now refuses to write an M2 that still says `FOMC` or
   `9/16`. The old version is recorded in `m2-deleted-event/MUTATION.md` rather
   than quietly replaced: a calibration item that cannot be failed teaches the
   rubric nothing.
2. **r2 — the reviewer read the page attentively and never worked backwards.**
   An omission is invisible to a reader of the page alone. So the rubric's
   signature 3 was rewritten from a description into a mandatory procedure
   (enumerate every dated item in the evidence, then search the page for each),
   and the output schema gained a required `events_checked` array so the work
   has to be shown.
3. **r3 — the procedure ran and still missed it.** `events_checked` came back
   with 15 dated items, every one an EARNINGS date from the session frame's
   focus block. The FOMC on 2026-09-16 — which `00001-ow_session_frame.json.gz`
   and `00009-ow_review_window.json.gz` both carry — is absent from the list.
   Ten of the fifteen entries are `in_page: false` (far-dated Q4 earnings) and
   the reviewer raised no finding for any of them, which is the right call for
   those and the reason it did not notice the one entry that should have been
   there.

4. **r4 — the enumeration moved into code and the check passed.**
   `fr_dated_events` walks every recording, pulls every `YYYY-MM-DD` and every
   bare `M/D` (resolving the year from the recording's own timestamp, never
   guessing), returns `{date, token, tool, file, snippet≤160}` deduplicated to
   one row per date-tool-spelling, ordered by date, capped at
   `MAX_DATED_EVENTS` with a `truncated` flag and a `from`/`to` window. The
   rubric's signature 3 became "call it, then mark `in_page` on every row it
   returned, and raise a finding for every `false` row whose snippet shows a
   scheduled or macro event". The reviewer now CHECKS a list instead of
   BUILDING one.

   Result on M2 r4: **`missing-major-event`, blocking**, with
   `events_checked` carrying 52 rows including
   `{"event":"FOMC 9/16 (HIKE 55.7%)","date":"2026-09-16","in_page":false}` —
   the row all three model-built enumerations had omitted. The finding cites the
   page sentence that should have carried the event ("No calendar rows were
   admitted to this run — no event arrived carrying a time, a named event and a
   forecast or prior.") against the recording that contradicts it verbatim.

   One measurement was needed to make it work. Deduplicating on the whole row
   returned **793 rows for 23 distinct days** — the weekly's session frame
   writes `9/16` in six different surroundings — the 80-row cap fell on the
   earliest dates, and every forward event including the FOMC was cut off the
   end. Deduplicating on `date|tool|token` instead gives **65 rows, no
   truncation, FOMC present in both spellings**. The wrong dedup granularity
   would have shipped a tool that looked right and hid the same event.

Read plainly: the reviewer is good at faults **visible on the page** and was
poor at faults **defined by absence**, and the fix for the second kind is to
stop asking a model to be exhaustive and give it an exhaustive list.

### Regression check, and a new strictness to watch

`m4-miss-as-hit` was re-run once under the same build (r4). It still returns
`weekly-is-our-review` **blocking** on the rewritten sentence, verbatim — no
regression from the new tool.

It also returns two NEW `missing-major-event` findings, for the FOMC meetings
on 2026-10-28 and 2026-12-09 that the session frame carries and the page never
names. Those are true by the rubric as written, but they are a warning: the
pre-pass makes the reviewer materially stricter about forward policy events,
and a daily page that legitimately scopes to the next week will now trip this
signature. Whether "scheduled and in the evidence" should mean "must appear on
every page" is a question for Step 3, not something to quietly soften here. The
severity it assigned (`major`, not `blocking`) is at least the proportionate
half of the answer.

**`rejected-2026-09-03-premarket` — the known failure is not checkable from
its own evidence.** The recovery plan records this sample's fault as "AVGO /
SNOW earnings missed". Neither ticker appears anywhere in that sample's 22
recordings: `ow_uw_earnings` returned a 120-byte as-of refusal, not an earnings
list. The reviewer cannot find an omission the evidence does not carry, and the
page is rejected on other grounds instead. This is the Step 0 thin-input limit
(`flash-samples/README.md`) landing on a calibration item, not a reviewer
defect.

## Reviewer model vs author model

The router picked `dsh:claude-opus-4-8` for the reviewer on all eight runs —
the cheapest target carrying `reason.deep`, `long.context` and `tool.use` under
the credentials available on this laptop. There is no model pin, and no
`team.yaml` names a model.

**The plan's "reviewer model differs from author model" rule is only half
satisfied, and it is not being worked around.** Both source pages were written
by more than one model:

| source page          | author models on the page                                    |
| -------------------- | ------------------------------------------------------------ |
| 2026-09-06 weekly    | `dsh:claude-opus-4-8` ×2 sections, `dsh:claude-haiku-4-5` ×1 |
| 2026-09-03 premarket | `dsh:claude-opus-4-8` ×5 sections, `dsh:claude-haiku-4-5` ×2 |

So the reviewer is a different model from the `weekly` author (haiku) and the
SAME model as the `scenarios` and `week-review` authors (opus). Nothing in the
harness can currently fix that: Step 5 of the recovery plan already records
that a per-run model pin does not exist. Stated here so a later reader does not
mistake a same-model review for an independent one.

## Blindness — the check, and its result

The reviewer is handed the page, the recordings and the rubric, and nothing
else. The claim is checked against the runner's own evidence file, which stores
the exact string handed to the executor:

```bash
python3 - <<'PY'
import json,glob
BAD=['r1','r2','m1-','m2-','m3-','m4-','swapped','calibration','claude','opus',
     'haiku','gpt','dsh:','flash-samples','tool-io','2026-09-06-weekly',
     '2026-09-03-premarket','quality:','pit coverage','helium audit','run-']
for p in glob.glob('<state root>/pit/step2-r*/evidence/*.json'):
    d=json.load(open(p)); pr=d['steps'][0]['assembledPrompt']
    print(d['run']['variant'], len(pr), [w for w in BAD if w in pr])
PY
```

Result: **every assembled prompt is byte-identical within a build, with zero
hits** — 3058 characters across the seven r1/r2 runs, and again identical
across the r4 pair after the `fr_dated_events` instruction was added. The prompt holds the run clock, the budget
line, the persona and the task instruction — no variant label, no page path, no
sample name, no model name, no metrics line, no gate refusal, no run id. The
variant label reaches the audit table and never the model, which is why the
same prompt served a rejected page and a mutation of it.

The second half of the blindness is upstream, in `flash-mutate.sh page`: the
calibration pages themselves carry no model name, no `quality:` line, no pit
coverage line and no gate refusal, because the extractor drops them. Verified:

```bash
grep -rniE "claude|gpt-|opus|sonnet|haiku|dsh:|quality: leaks|pit coverage|gate \`|run-[0-9a-f]{8}|variant|helium audit" \
  docs/evidence/flash-review/calibration/*/page.md   # no matches
```

## Cost

Ten runs, $1.70 total, 16.0 minutes of wall time. A review costs about
$0.09-$0.25 and one to two minutes. Cache reads dominate the token count
(41k-255k) because the rubric, the page and the recordings are re-read across
the tool loop; output is 3.5k-9.8k tokens. The `fr_dated_events` pre-pass adds
roughly 40k cache-read tokens and no measurable wall time — it is one file walk
over ~80 KB of gzip, done in-process before the model's first turn on the
question.
