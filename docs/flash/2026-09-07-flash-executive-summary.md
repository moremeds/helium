# Flash — executive summary for external review

**Written:** 2026-09-07 · **For:** Codex Astra, reviewing cold · **Branch:** `fix/review-readability`
**Author's stance:** this is not a status report written to be approved. The operator read
yesterday's output and called it garbage. The purpose of this document is to hand a reviewer
everything needed to say where the design is wrong, not to defend it.

---

## 0. What we are asking the reviewer

Four questions, in order of how much we are stuck on them:

1. **Is the artifact the right artifact?** Flash currently renders a seven-section review
   document with a 23-row coverage table, a focus list, a dated-catalyst list and an open-call
   register — every weekday and once a week. A portfolio manager would not read this. What
   should a daily agent-written market briefing actually contain, and what should it drop?
2. **Should a language model write the prose at all?** Every number on the page is computed by
   code (§3.4). The model's remaining job is to say what the numbers mean, and it mostly restates
   them (§7.2). The alternatives are: better routing, renderer-supplied sentence frames the model
   only selects among, or no prose.
3. **Can a self-improvement loop exist without a human rater?** The loop we built (§4) settles
   numeric metrics only. The dimension that is failing — readability, judgement, "would a person
   read this" — has no settler, so the loop cannot see the actual defect. Four loops run so far,
   all `flat`.
4. **The layout.** The operator is dissatisfied with the page layout as well as the content
   (§6). The current design is a two-column panel grid transcribed from an approved mock. What
   is wrong with it, given the content it actually has to carry?

---

## 1. The product, in one page

**Flash** is a US-equity-options market briefing produced end to end by an agent team, on a
schedule, with no human in the loop. It is one operator's morning read, not a commercial product.

Five runs a day/week, each a full agent run:

| Phase       | Cron (HKT)    | ET        | What it produces                                      |
| ----------- | ------------- | --------- | ----------------------------------------------------- |
| `premarket` | `45 20 * * *` | 08:45     | the day's read before the open                        |
| `intraday`  | `0 1 * * *`   | 13:00     | midday update                                         |
| `close`     | `15 4 * * *`  | 16:15     | the day's close, and the day's calls                  |
| `weekly`    | `0 20 * * 0`  | Sun 08:00 | the week's 复盘 and the week ahead                    |
| `frank`     | `0 21 * * 1`  | Mon 09:00 | our weekly compared against an external writer's note |

Output goes three places: a markdown report on disk, an HTML email, and a `POST` to argon,
which renders it as a web page. The web page is the primary surface; the email is a summary
with a link.

**The rules the product is built on** (these are not negotiable and any redesign must keep them):

- **A language model never does arithmetic.** On 2026-09-03 an audit found 8 of 11 model-computed
  numbers in a brief were wrong. Every number on the page is now computed by the renderer from a
  tool payload. The model receives finished numbers and may not restate a level it was not given.
- **Every call is written down before it can be judged.** A verdict, a focus admission or an
  index forecast becomes a `Commitment` in an append-only ledger at the moment it is made, and a
  settler later scores it against real bars. Nothing is graded retroactively.
- **No positions, no P&L.** The operator's book never appears in Flash output.
- **Defined risk only.** No naked shorts anywhere in the proposals.
- **Point-in-time honesty.** A replay with `--as-of` sees only what existed at that timestamp; a
  datum older than the period it covers is labelled, not quietly used.

---

## 2. Where to look

**Live**

| Thing                     | Where                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| Production page           | `https://argon.rsiarc.com/flash`                                     |
| Local page, latest weekly | `http://127.0.0.1:3001/flash/2026-W36`                               |
| Local page, a daily       | `http://127.0.0.1:3001/flash/2026-W36/2026-09-04?phase=close`        |
| Production host           | Mac mini `macmini`, user `moremeds`; release `c7d86ed` is live today |
| Production logs           | `~/.helium/logs/option-wizard-<phase>.log` on the mini               |

**Code**

| Thing                         | Path                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| Harness + doctrine            | `/Users/chenxi/projects/helium/AGENTS.md`                                 |
| The tenant                    | `/Users/chenxi/projects/helium/plugins/option-wizard/`                    |
| Team + personas (913 lines)   | `plugins/option-wizard/team.yaml`                                         |
| Config (374 lines)            | `plugins/option-wizard/tenant.yaml`                                       |
| Tools (5,235 lines, 29 tools) | `plugins/option-wizard/tools/index.ts`                                    |
| Renderer                      | `plugins/option-wizard/render/` (`index.ts`, `review.ts`, …)              |
| Ledger settlement             | `plugins/option-wizard/eval/`                                             |
| Self-improvement tenant       | `plugins/helium-self/`                                                    |
| Core seam (domain-free)       | `packages/core/src/` — `ledger.ts`, `plugins.ts`, `router.ts`             |
| The web page                  | `/Users/chenxi/projects/argon/web/components/flash/`                      |
| Ingest                        | `argon/src/uw_scan/api/routers/agent_runs.py`, table `uw_scan.agent_runs` |

**Size:** 21,077 lines of non-test TypeScript in the tenant tree, 15,944 lines of tests,
222 commits since 2026-09-01, 40 merged pull requests.

---

## 3. How it is built

### 3.1 The harness

Helium is a multi-agent harness whose stated purpose is recursive self-improvement: it must be
able to run an agent team against its own repository and land the result. Its constitution is
six doctrine points in `AGENTS.md`; the ones that bear on this review:

- **Core knows no domain.** A contract test fails the build if anything under `packages/core/src`
  names a provider or a business word. Options knowledge lives only in the tenant.
- **A role declares capabilities, never a model.** `requires: [reason.deep, long.context]`, and a
  router picks the cheapest model that satisfies them. This is the seam that produced defect §7.1.
- **Context and token accounting is built in, not bolted on.** Every agent step records model,
  tokens in/out, context size, wall time and cost to a queryable table. "Where did the tokens go"
  must be answerable in one query. Today it is not (defect §7.5).
- **Ceremony must earn its keep.** A gate or review pass stays only if it has caught a real defect.

### 3.2 The pipeline

```
cron trigger
  → team controller (deterministic reducer)
  → capability router → provider edge → isolated agent
  → step outputs (JSON, fenced)
  → deterministic renderer  ← every number is computed here
  → gates (budget, meta-leak, levels)
  → ledger: commitments minted
  → delivery: markdown + email + POST /api/agent-runs → argon
  → next run's settler scores yesterday's commitments against real bars
```

### 3.3 The team

12 roles, of which **10 are model-backed and 2 are deterministic**:

| Role                 | Job                                                         | Model-backed |
| -------------------- | ----------------------------------------------------------- | ------------ |
| `universe-builder`   | merge TradingView flags + argon watchlist into a ticker set | no           |
| `frame-clerk`        | rank channels, score events, read the ledger                | no           |
| `gex-reporter`       | fill the gamma table (levels only, never a direction)       | yes          |
| `overnight-reporter` | earnings and headlines since the last close                 | yes          |
| `regime-analyst`     | name the day's cause; tape tiles; schedule                  | yes          |
| `scenario-analyst`   | dated-catalyst scenarios                                    | yes          |
| `structure-designer` | propose defined-risk structures with real legs              | yes          |
| `risk-reviewer`      | adversarial pass, ≤5 proposals survive, writes the decision | yes          |
| `weekly-analyst`     | **the weekly 复盘 and 下周展望 prose**                      | yes          |
| `week-reviewer`      | reviews our own output over 5/10/21-day windows             | yes          |
| `frank-comparator`   | our weekly vs an external writer's note                     | yes          |
| `editor`             | sole author of the final brief prose                        | yes          |

29 tools, hitting Unusual Whales, argon's Postgres, apex (bars), FRED, TradingView via a CLI,
Massive (corporate actions), X, and Substack. Nine of the 29 are pure internal computation.

### 3.4 The review document

The current output shape, seven fixed sections, same on the daily and the weekly:

| §   | Title           | Who writes it                                   | Content                                               |
| --- | --------------- | ----------------------------------------------- | ----------------------------------------------------- |
| 1   | Scorecard       | renderer only, zero model words                 | what settled, hit rate, calibration, coverage gaps    |
| 2   | 上周复盘        | model                                           | what we got right and wrong                           |
| 3   | Coverage        | renderer + one model clause per row             | 23 rows: 12 macro channels, 10 sectors, N themes      |
| 4   | 下周展望        | model                                           | continue / reverse / strengthen per row               |
| 5   | Dated catalysts | renderer                                        | earnings, FOMC, corporate actions, with implied moves |
| 6   | Focus           | renderer ranks; model writes one `why` per name | 15 weekly / 5 daily names                             |
| 7   | Open calls      | renderer only, zero model words                 | every unsettled commitment and when it settles        |

Word budgets are enforced by the renderer, not requested in a prompt: 900 model words on the
weekly, 550 on the daily, and per-field caps down to 40 words for a focus `why`.

### 3.5 The ledger

`packages/core/src/ledger.ts` is an append-only JSONL per tenant with three record kinds:
`commitment`, `receipt`, `baseline`. A commitment carries `id, runId, tenant, issuedAt,
deployment, variant, codeSha?, asOf?, payload`. `codeSha` is stamped by the runner so the
scoreboard can group results by `variant@codeSha` — the same experiment run against two builds
is two rows, not one.

Three commitment kinds exist today: `coverage-verdict` (a `continue/reverse/strengthen/fade`
token with a probability, settled against the next observation and scored by Brier), `focus-admit`
(did the name move at least its implied move), `spy-direction`. A fourth, `scenario-base-case`,
was designed and cut: there was no row id to settle it against.

---

## 4. The self-improvement framework — and its limit

`plugins/helium-self/` is the tenant that experiments on Helium itself.

**How a loop runs.** A loop is a JSON file. `plugins/helium-self/experiments/<id>.json` declares a
hypothesis, the change, the metric, a baseline with its source, a window and a rule with fixed
thresholds. The renderer reads every file in that directory and mints one commitment per file,
deduped against the ledger. A settler later queries the metric's store and writes a receipt with
one of three verdicts: `improved`, `flat`, `regressed`. Thresholds are fixed at mint time and
never edited afterwards — that is the whole point.

The tenant has **no cron trigger**. A human names it or it does not run.

**What has actually run.** Five experiment files exist:

| Experiment                                    | Metric                                               | Result                                           |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `2026-09-06-density-arm-f`                    | `q05PinballRatio`, `meanPinball`                     | flat                                             |
| `2026-09-06-density-arm-h`                    | same                                                 | flat                                             |
| `2026-09-06-density-noise-floor`              | same (control, seed+1)                               | flat — measured a 0.0015 noise floor             |
| `2026-09-07-density-arm-skewt`                | same, tightened threshold                            | flat                                             |
| `2026-09-07-review-framework-failed-run-rate` | `failedRunRate`, baseline 0.2 over 5 production runs | **outstanding — no settler exists for its kind** |

**The honest limit.** Every settler in the repository scores a number pulled from a store that
already existed. There is no settler for a qualitative property — readability, judgement, whether
a person would read the page — and that is precisely the dimension on which the product is
currently failing. The four density loops all returned `flat`, which is a true answer to a
question nobody was asking. The fifth loop mints a commitment that can never settle, because its
`kind` has no implementation; the renderer's own comment says so.

So: the self-improvement machinery works, is honest, and is pointed at the wrong target. Whether
a loop can be built around a judgement metric without a human rater in it is open question 3.

---

## 5. Timeline

The product went from nothing to production in seven days. Merged pull requests, newest first:

| PR        | Date  | What                                                                  |
| --------- | ----- | --------------------------------------------------------------------- |
| #101      | 09-07 | the review framework's own commitment names its merge sha             |
| #100      | 09-07 | **review framework** — seven sections, focus list, themes, settlement |
| #99       | 09-07 | helium-self loops 2–3; scoreboard status counts                       |
| #98       | 09-06 | helium-self mints and settles its first argon experiment              |
| #97       | 09-06 | commitments carry `codeSha`; scoreboard groups `variant@codeSha`      |
| #95 / #93 | 09-06 | **outcome ledger v0** — commitment, settler, receipt, evidence        |
| #92       | 09-05 | quality loop — metrics, meta-leak gate, regime record, tool replay    |
| #91       | 09-05 | name the day's cause; point-in-time replay via `--as-of`              |
| #90       | 09-04 | flash format — renderer-enforced budget, cause citation, one editor   |
| #87       | 09-04 | the argon delivery channel and the versioned view schema              |
| #86 / #84 | 09-04 | editor step, data charts, prior-brief delta, newsletter redesign      |
| #82       | 09-03 | **only code derives numbers** — the arithmetic ban                    |
| #79       | 09-03 | the data tools: earnings, policy path, calendar, IV term, headlines   |
| #77       | 09-03 | five phases, phase-named delivery, quotable timestamps                |
| #62       | 09-02 | the team lane actually runs — execution, gates, delivery              |
| #60       | 09-02 | **Helium v2** — delete v1, rebuild the core                           |

On the argon side: #416 (ingest + daily page, 09-04), #418 (brief view v2, 09-06), #422 (week
strip, 09-07), **#424 (brief view v3, open)**.

---

## 6. Current state, unvarnished

**Production is live and mostly idle.** Release `c7d86ed` is deployed on the mini and contains
the review framework. The last weekday `close` run **failed** on a provider `overloaded_error`
with no retry; the two weekend days correctly skipped; the last two weekly runs completed in
three steps each.

**The operator's verdict on the 2026-09-06 weekly, quoted:** "这他妈的是人话？", "这都是什么垃圾啊",
"全部都是无效信息", "为什么你会觉得这种东西会有人读". Specifically:

- §1 Scorecard and §7 Open calls printed all 24 ledger commitment ids verbatim, twice over.
- §3 Coverage printed 23 rows each carrying an id, a band, a settlement condition and a member
  list — a wall of text.
- §5 printed implied moves to four decimal places (`6.9333%`).
- §2 and §4 restated §3's numbers back with no judgement in them.
- Three stale "regime record missing" cards were appended below the document.
- Two things were called good, and both were the operator's own design: the themes card, and the
  focus list's `why` column.

**What was changed today** (branch `fix/review-readability`, two commits, not merged): §1 reduced
to four lines, §7 to one line per call with no ids, §3 to four fields per row, §5 to one decimal,
the trailing cards removed, and the focus `why` prompt rewritten from a template into a request
for the analyst's own judgement. Tests: 1,084 passing, 3 skipped, core untouched. The result,
verbatim from the page:

```
1 · Scorecard
Nothing settled yet — first settles 2026-09-08 · calibration n=0, not yet scorable
24 open calls
Focus: 0 of 0 moved ≥ implied · 5 open
Coverage gaps: 3 rows (rates.front, curve.shape, commodities)

3 · Coverage
- rates.long · 4.77 → -2 bp · CONTINUE · Quiet hold near 4.77 into hike decision
- policy.path · 55.7 → +5.0 pp · STRENGTHEN · Hike moved +5 pp to 55.7; tilt visible
- vol · 14.32 → -0.88 pts · FADE · Compression to 14.32 suggests dealer gamma long

6 · Focus (why column)
ASML — Earnings 2026-09-14 pre, 27 sessions out; ivRank 27.98 is depressed by distance.
Semi-Cap/EDA fading -1.6% this week contradicts ASML strength in other frameworks.
Equipment cycle lags fab cycle.

7 · Open calls
rates.long · CONTINUE p=0.70 · settles 2026-09-08
policy.path · CONTINUE p=0.55 · settles 2026-09-08
```

**The operator's verdict on that, this morning: still not satisfied — with the layout and with
the result.** That judgement stands unrebutted and is the reason this document exists.

---

## 7. Diagnosed causes, with evidence

### 7.1 The weekly prose is written by the cheapest model in the pool

The `weekly` task declares `requires: [tool.use, long.context]` and omits `reason.deep`. The
router therefore picks the cheapest model satisfying those two tags. From the audit table of the
two runs that produced the text above (`weekly-analyst` and `week-reviewer` are weekly-run rows,
`editor` and `regime-analyst` daily-run rows):

| Role                 | Model                  | Output tokens | Cost   |
| -------------------- | ---------------------- | ------------- | ------ |
| `editor`             | `claude-opus-4-8`      | 3,800         | $0.095 |
| `regime-analyst`     | `claude-opus-4-8`      | 2,246         | $0.056 |
| `week-reviewer`      | `claude-opus-4-8`      | 1,223         | $0.031 |
| **`weekly-analyst`** | **`claude-haiku-4-5`** | **3,043**     | $0.015 |

The single role that writes §2 复盘, §4 展望, all 23 coverage clauses and all 15 focus `why`
lines — every model word on the weekly page — runs on Haiku, while a role that writes 41 tokens
of review runs on Opus. This is not a bug in the router; the router did exactly what the manifest
asked. It is a bug in the manifest, and it went unnoticed for two days because nothing in the
pipeline reports which model wrote the words a human is unhappy with.

### 7.2 Prose written from a finished table restates the table

The model is handed a computed frame and asked to say what it means. §4, verbatim:

> "Rates.long continues into the 9/16 FOMC window; the -2 bp move held within the recent range…
> Policy.path strengthens toward hike from the 50.7 coin-flip because Friday's move to 55.7…
> Credit continues mild—the single basis-point tightening signals no stress…"

Every clause names a row and repeats its number. The renderer records a fault for restating a
level, but only records it. This is the structural question behind review question 2: an
arithmetic ban plus a fixed 23-row frame plus a word cap leaves the model very little room to do
anything except narrate the table it was given.

### 7.3 The page flattened every line break (fixed today, argon side)

argon's `parseBlocks` split section bodies on blank lines only, so schema-3 bodies — which are
block-level markdown joined by single newlines — arrived as one paragraph. §1's four statements
rendered as one run-on line; every `- ` bullet rendered inline. Fixed in argon commit `2b42a8d5`
on PR #424, verified on the local page. Roughly half of the "wall of text" complaint was this.

### 7.4 A content filter silently eats whole judgement sentences

`FOCUS_BANNED_PATTERNS` drops any focus `why` containing `target|upside|downside|rally|crash|
squeeze|breakout`. It predates the new prompt. Now that the `why` asks for a 40-word judgement,
two of five names (MU, TSM) lost their entire sentence and print `—`. The filter's intent was to
stop the model from making price calls; its effect is to delete the analysis.

### 7.5 Token accounting is wrong, and doctrine says it must not be

Doctrine point 4 requires that "where did the tokens go" be answerable in one query. The audit
table records `input_tokens` of **2** for spans whose `context_size` is 23,000 and whose
`cache_read_tokens` is 22,730. Input is being under-recorded by three to four orders of
magnitude; cost is therefore also wrong. Any budget or cheapest-model decision resting on that
column is resting on nothing.

### 7.6 Two view keys are emitted and nothing renders them

Today's change moved coverage detail (bands, members, settle conditions) off the visible page
into `coverageDetail`, and non-review sections into `otherSections`. Neither key exists in
argon's `BriefView` interface. They are POSTed, stored, and never shown. Either argon renders
them or the renderer should stop computing them.

### 7.7 A production tool is dead

`ow_massive_actions` (splits, ex-dividends) needs `MASSIVE_API_KEY` and `MASSIVE_BASE_URL`. The
mini's environment file has 24 variable names and neither of those is among them. Corporate
actions are silently absent from every production run.

---

## 8. What we cannot decide ourselves

1. **The artifact.** A 23-row coverage table with a verdict per row is a complete, honest,
   scoreable record of a desk's opinions. It is also not something a person reads. Is the answer
   fewer rows, a different shape (a diff against last week rather than a level table), or a split
   into a short human page over a full machine record?
2. **The prose.** Options: route the weekly to a strong model and see if judgement appears;
   restrict the model to selecting among renderer-generated sentence frames; or accept that the
   page is a data product and drop prose entirely.
3. **The loop.** What is the cheapest honest settler for "this page is worth reading"? A human
   rating once a week is one answer and makes the loop human-paced. A model-as-judge is another
   and is circular. We have not found a third.
4. **The layout.** Two-column panel grid, transcribed from an approved mock, on a dark palette
   with a monospace face. It was designed for a daily brief with a decision block and structure
   cards; the weekly review is a different animal that inherited the same shell.

---

## 9. Session history

Every session that built this. Transcripts are JSONL under
`~/.claude/projects/<repo>/`; the eight-character prefix is the file name.

**Helium** — `/Users/chenxi/.claude/projects/-Users-chenxi-projects-helium/<id>.jsonl`

| Session    | Window                    | Msgs  | What happened                                                       |
| ---------- | ------------------------- | ----- | ------------------------------------------------------------------- |
| `9c85ea1d` | 08-31 09:13→14:34         | 62    | "这个 project 已经 evolve 很多" — the state-of-the-world summary    |
| `bf554cff` | 08-31 14:34→09-01 08:58   | 472   | weekend executive summary; Helium/Livewire split                    |
| `8a2a44f6` | 09-01 09:00→09-02 06:41   | 717   | **option-wizard is born** — the first daily agent job               |
| `9094f76b` | 09-02 02:14→13:40         | 1,481 | v2 doctrine; delete v1; the over-engineering purge                  |
| `dde1f7aa` | 09-02 13:41→09-03 09:05   | 936   | "你现在的内容属于完全不可读" — the first readability rewrite        |
| `02cf2882` | 09-03 09:07→09-04 01:41   | 291   | issue #78 reviewed against the new master                           |
| `d28b9782` | 09-03 09:24→09:46         | 34    | did the laptop and the mini actually send the mail                  |
| `10e64f69` | 09-03 10:48→09-04 11:57   | 590   | **the layout** — first-principles redesign, mobile + desktop        |
| `abb3c6ab` | 09-04 13:47→09-07 01:17   | 391   | **the self-improvement framework** — helium-self, loops, scoreboard |
| `04ed705b` | 09-04 12:02→09-07 ongoing | 885   | quality loop, outcome ledger, **the review framework**, this doc    |

**Argon** — `/Users/chenxi/.claude/projects/-Users-chenxi-projects-argon/<id>.jsonl`

| Session    | Window                  | Msgs | What happened                                            |
| ---------- | ----------------------- | ---- | -------------------------------------------------------- |
| `7bda7fd9` | 09-04 04:31→06:05       | 69   | the "Recursive Self-improvement Agent Analytics" framing |
| `c7101c9c` | 09-04 06:31→09-05 16:33 | 206  | **the Flash page** — ingest, daily brief, week strip     |
| `a6bb2705` | 09-06 14:03→09-07 02:40 | 107  | brief view v2 then **v3 adapter** (PR #424)              |

Earlier argon sessions built the analytics platform Flash reads from (watchlists, IV surfaces,
policy path, macro pages) and are background rather than Flash history; the largest are
`94cad715` (08-10→08-31, 6,081 messages) and `9de875d6` (08-14→08-26, 5,269 messages).

**Cross-session coordination.** Three Claude sessions worked on this simultaneously and messaged
each other directly: this one (helium review framework), a second helium session (`codeSha`,
helium-self, deploy), and the argon session (the page). Agreements reached that way are recorded
in the memory file `review-framework-pr100-2026-09-07.md`.

---

## 10. Reproducing the output

```bash
# in the helium repo
pnpm install --frozen-lockfile
find packages plugins -name tsconfig.tsbuildinfo -delete && pnpm build
pnpm typecheck && pnpm test

# a point-in-time replay of one close and one live weekly, delivered to a local argon
bash scratchpad/run-pit-review.sh 2026-09-04 close  review-v8b
bash scratchpad/run-pit-review.sh 2026-09-04 weekly review-v8b

# what it produced
sqlite3 <state>/audit.db "select role, model, output_tokens, context_size, cost_usd from span where model!='none';"
```

Evidence from the last accepted round, including rendered reports, the metric dump and the
ledger, is in `docs/evidence/pit-replays/2026-09-06/`.

---

## 11. What a reviewer should not spend time on

- **Core neutrality.** A contract test already fails the build if `packages/core/src` names a
  provider or a business word. It holds.
- **Number correctness.** The arithmetic ban is enforced by the renderer and by gates; the
  remaining number defects are formatting, not correctness.
- **Whether the ledger is honest.** It is append-only, thresholds are fixed at mint, and nothing
  settles inside the sitting that made it. That part works.
- **Test coverage as a number.** 1,084 tests pass. They did not catch a single one of the seven
  defects in §7, which is the more interesting fact.
