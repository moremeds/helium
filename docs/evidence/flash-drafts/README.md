# Step 1 candidate drafts (2026-09-07)

Three authors, seven frozen samples, one run each. Produced by
`scripts/flash-abc.sh <sample> <A|B|C|C-nonews> <state-root>` against
`docs/evidence/flash-samples/`. Step 1 of
`docs/flash/2026-09-07-flash-recovery-plan.md`.

**No draft is judged here.** Step 2 scores them blind, so this file records
only what ran, on what model, at what cost, on what inputs. Each sample's
`CRITERIA.md` — the three lines the user's own critique asks for — was written
and committed before any of these runs existed.

## The variants

| variant  | manifest                                   | difference from the one above it                                       |
| -------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| A        | `plugins/option-wizard/team.yaml`          | the shipping pipeline, unchanged                                       |
| B        | `plugins/option-wizard/team.B.yaml`        | `reason.deep` added to the `weekly` TASK's `requires`, nothing else    |
| C        | `plugins/option-wizard/team.C.yaml`        | B + news tools on `weekly-analyst` + rewritten `edit`/`weekly` prompts |
| C-nonews | `plugins/option-wizard/team.C-nonews.yaml` | C with the two news tools removed again                                |

`team.yaml` on disk IS variant A, and there is no per-run manifest flag
(`tenant.yaml` pins `team:`, and `--variant` is only a label), so the script
swaps a variant in and restores it in a trap. `teamYamlSha256` in each
`meta.txt` is the run's own proof of which manifest it read.

**Daily B is not run.** B changes only the `weekly` task, so a daily B run is
byte-identical to A by construction; the rows below say `= A` rather than
spending tokens to reproduce it.

## The runs

| sample                 | variant  | run id                                     | author model       | tokens in / out | cache read | served     | news in inputs         | draft                         |
| ---------------------- | -------- | ------------------------------------------ | ------------------ | --------------- | ---------- | ---------- | ---------------------- | ----------------------------- |
| `2026-09-03-premarket` | A        | `run-c84d65e3-8ec7-41a8-a821-678c706b1256` | `claude-opus-4-8`  | 6 / 4047        | 43016      | 4          | no (as-of refusal)     | `2026-09-03-premarket/A/`     |
| `2026-09-03-premarket` | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-03-premarket` | C        | `run-1d943fda-4fbb-4072-b7d2-ffb9dd2c3ce4` | `claude-opus-4-8`  | 6 / 3404        | 44802      | 3          | no (as-of refusal)     | `2026-09-03-premarket/C/`     |
| `2026-09-03-intraday`  | A        | `run-8ccf6932-04a9-426b-835f-fb0bb97401b0` | `claude-opus-4-8`  | 6 / 3520        | 40352      | 3          | no (as-of refusal)     | `2026-09-03-intraday/A/`      |
| `2026-09-03-intraday`  | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-03-intraday`  | C        | `run-470da90d-3b26-4580-b55d-f4cd045a3e9f` | `claude-opus-4-8`  | 6 / 3650        | 41659      | 4          | no (as-of refusal)     | `2026-09-03-intraday/C/`      |
| `2026-09-03-close`     | A        | `run-32306119-462c-4221-9771-014a207fe9eb` | `claude-opus-4-8`  | 6 / 3651        | 43703      | 3          | no (as-of refusal)     | `2026-09-03-close/A/`         |
| `2026-09-03-close`     | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-03-close`     | C        | `run-b036938b-49ce-4ee8-9500-85509db43aa4` | `claude-opus-4-8`  | 6 / 3453        | 44004      | 3          | no (tool never called) | `2026-09-03-close/C/`         |
| `2026-09-04-premarket` | A        | `run-49f3d3e2-dc1a-472b-8df7-804630347f2e` | `claude-opus-4-8`  | 4 / 3966        | 22194      | 6          | no (as-of refusal)     | `2026-09-04-premarket/A/`     |
| `2026-09-04-premarket` | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-04-premarket` | C        | `run-5c3c9ddc-e12d-41a1-9913-e2f9197da0c9` | `claude-opus-4-8`  | 4 / 3456        | 23371      | 6          | no (as-of refusal)     | `2026-09-04-premarket/C/`     |
| `2026-09-04-intraday`  | A        | `run-33d281e9-d069-4ef1-9d54-86c4d5ed7662` | `claude-opus-4-8`  | 4 / 3749        | 20468      | 5          | no (tool never called) | `2026-09-04-intraday/A/`      |
| `2026-09-04-intraday`  | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-04-intraday`  | C        | `run-4927a14a-623f-4f52-a6fd-0f15074bbe5b` | `claude-opus-4-8`  | 4 / 3296        | 21090      | 4          | no (tool never called) | `2026-09-04-intraday/C/`      |
| `2026-09-04-close`     | A        | `run-13e5c71d-33b4-406e-8b60-0a9103c50a7c` | `claude-opus-4-8`  | 4 / 3686        | 21601      | 5          | no (as-of refusal)     | `2026-09-04-close/A/`         |
| `2026-09-04-close`     | B        | = A                                        | = A                | = A             | = A        | = A        | = A                    | —                             |
| `2026-09-04-close`     | C        | `run-b1abafe8-9912-4ef3-a997-c576c9f65588` | `claude-opus-4-8`  | 4 / 3377        | 21951      | 4          | no (as-of refusal)     | `2026-09-04-close/C/`         |
| `2026-09-06-weekly`    | A        | `run-90b3885c-63fe-4987-9507-0e51f3711cc9` | `claude-haiku-4-5` | 8 / 2542        | 22712      | n/a (live) | no (no news tool)      | `2026-09-06-weekly/A/`        |
| `2026-09-06-weekly`    | B        | `run-effdd006-2ce9-4043-9176-e020344662a3` | `claude-opus-4-8`  | 6 / 3572        | 60281      | n/a (live) | no (no news tool)      | `2026-09-06-weekly/B/`        |
| `2026-09-06-weekly`    | C        | `run-c344b3d9-56ae-4032-8fb0-fbfd6ef02417` | `claude-opus-4-8`  | 4 / 3952        | 31390      | n/a (live) | **yes**                | `2026-09-06-weekly/C/`        |
| `2026-09-06-weekly`    | C-nonews | `run-e450fc6d-f8cb-4a5a-8b37-6afd9657ad58` | `claude-opus-4-8`  | 6 / 4881        | 61658      | n/a (live) | no (tools removed)     | `2026-09-06-weekly/C-nonews/` |

Paths are relative to this directory. Every run exited 0. `tokens in / out`
and `cache read` are the author role's own spans, summed from the run's
`audit.db` (`span.input_tokens`, `output_tokens`, `cache_read_tokens`);
almost all of the input is served from cache, which is why the `in` column
looks impossibly small next to the 40 KB assembled prompt beside it.

`served` is the count of tools that answered from the frozen recording on that
run, from the run's own `pit coverage:` line — it moves by one or two between
variants because the model asks with slightly different arguments each time.
The full served/unavailable lists are in each draft's `pit-replay.out`.

Each draft directory holds:

| file                | what it is                                                         |
| ------------------- | ------------------------------------------------------------------ |
| `report.md`         | the rendered markdown the delivery channel was handed              |
| `render.html`       | the rendered page                                                  |
| `author.prompt.txt` | the author step's `assembledPrompt`, verbatim                      |
| `author.output.txt` | the author step's raw `output`, before the renderer touched it     |
| `steps.json`        | the run's whole per-step evidence file                             |
| `run.log`           | the run's stdout/stderr                                            |
| `meta.txt`          | run id, model, tokens, `teamYamlSha256`, timings, `pit coverage`   |
| `pit-replay.out`    | the replay wrapper's own output, with the served/unavailable lists |

## Failures

One run failed and was re-run:

- `2026-09-04-close` / C, first attempt `run-39ce454a-135c-4181-8658-6a2f0a181c9f`,
  12:55:21Z. Exact error from the run log:
  `outcome: FAILED provider-error — dsh subagent failed: TRANSPORT — Connection error.`
  It aborted after the `gex` step, so no author step ran and no draft was
  produced. A transport fault, unrelated to the variant. Re-run clean as
  `run-b1abafe8-9912-4ef3-a997-c576c9f65588`; that is the row in the table.

No other run failed.

## What the frozen inputs could and could not supply

**No daily sample contains news, earnings or an economic calendar.** In all six
daily samples every `ow_uw_headlines`, `ow_uw_earnings` and `ow_uw_calendar`
recording is the original run's `{"unavailable":"as-of"}` refusal — the
endpoints have no history, so an as-of replay can only reproduce the refusal
the model was shown. The `news in inputs` column says `as-of refusal` where the
tool was called and refused, and `tool never called` where the author never
reached for it.

What the daily samples do carry as data: `ow_session_frame`, `ow_rotation`,
`ow_macro_rates`, `ow_uw_market_state`, `ow_argon_metrics`,
`ow_argon_policy_path`, `ow_prior_brief`.

Consequences Step 2 must respect, each also written into the sample's
`CRITERIA.md`:

- The "missing major event" failures the user named — AVGO/SNOW after the
  2026-09-02 close, initial claims and NFP on 2026-09-03/04, the Waller speech
  on 2026-09-04 — are **not reachable from the frozen inputs**. A draft that
  names one has invented it. Those criteria become testable only on production
  inputs, at Step 4.
- **The daily A→C comparison isolates prompt shape and nothing else.** The
  `edit` task already required `reason.deep` in A, so A and C route the daily
  author to the same model (`claude-opus-4-8`), and neither had news.
- **The weekly A→B comparison isolates the model and nothing else**, and B→C
  adds the shape plus news together — which is what `C-nonews` separates.

## The weekly runs are live, and were run back to back

The weekly runs with no `--as-of`, so `--replay-from` is inert for it (see
`docs/evidence/flash-samples/2026-09-06-weekly/MISSING.md`). All four weekly
variants are therefore LIVE runs, taken in one sitting inside a nine-minute
window on 2026-09-07:

| variant  | started (UTC) | finished (UTC) | wall  |
| -------- | ------------- | -------------- | ----- |
| A        | 12:19:12      | 12:21:02       | 1m50s |
| B        | 12:21:02      | 12:23:41       | 2m39s |
| C        | 12:23:41      | 12:26:06       | 2m25s |
| C-nonews | 12:26:06      | 12:28:41       | 2m35s |

Two things follow. Their numbers differ by however much the market data moved
between them — little, over nine minutes on a Monday morning UTC, but not
nothing. And the report day the runner resolved is **2026-09-07**, not
2026-09-06: a live weekly takes its day from the clock.

The news C saw is likewise live 2026-09-07 news. Only `ow_uw_headlines` was
called (one call, `{"limit":15}`, 3,466 bytes of rows); `ow_uw_earnings` was
available to the role and never called. Neither tool takes a window or an
as-of — `ow_uw_headlines` has no date filter and returns only the newest rows
(limit max 25); `ow_uw_earnings` returns each ticker's NEXT scheduled date —
so **neither can cover a week**, and C's prompt says so rather than pretending
otherwise.

## Renderer word caps

`extensions.review.caps` in `tenant.yaml` IS honoured at runtime: the caps
travel to the renderer through `ow_session_frame`'s payload and
`render/review.ts` trims `review`, `outlook` and `catalysts` to them. It is
honoured only from `tenant.yaml` itself — tenant discovery is
`existsSync(join(dir, name, "tenant.yaml"))` in `packages/core/src/tenant.ts`,
a literal filename, so a `tenant.C.yaml` sibling would never be read (and, for
the same reason, could never be picked up as a second tenant).

No `tenant.C.yaml` was written and no cap was raised. Every variant is
therefore rendered under the same caps, which keeps A/B/C comparable, and
where a cap did trim C the untrimmed text is in that draft's
`author.output.txt`. Judge C on the raw step output where the rendered text
ends mid-section.

## Reproducing one

```bash
HELIUM_ENV_FILE=<path to the tenant env file> \
  scripts/flash-abc.sh 2026-09-03-premarket C /tmp/some-state-root
```

The weekly cannot be reproduced — it is a live run and the week has moved on.
