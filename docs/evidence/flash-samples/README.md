# Frozen inputs for the Flash recovery (Step 0)

Nine samples. Each directory holds everything a fresh session needs to
re-produce one option-wizard run from this repo alone:

| file           | what it is                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| `run.json`     | `{runId, date, phase, asOf, source}` — `asOf` is `null` for the weekly       |
| `tool-io/`     | the run's tool calls verbatim, as the runner wrote them (`NNNNN-<tool>.json.gz`) |
| `run.log`      | the run's stdout/stderr                                                     |
| `report.md`    | the delivered markdown, when the run produced one                           |
| `render.html`  | the rendered page from the render dump, when the run produced one           |
| `steps.json`   | the per-step evidence dump, on runs late enough to have one                 |
| `MISSING.md`   | what is not here, and why                                                   |

Replay one:

```bash
HELIUM_ENV_FILE=<path to the tenant env file> \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/<sample> <scratch state root>
```

`replay` copies `tool-io/` to `<state root>/runs/<runId>/tool-io`, which is
where `--replay-from` looks, and re-runs the phase at the sample's `asOf`.

## What "served" means here

`served` is the pit-coverage list of tools that answered from the recording
instead of the network. **A recording of an as-of-blind tool holds the original
run's `{"unavailable":"as-of",...}` refusal, not market data** — the samples
were all taken from runs that had no earlier recording to draw on. Serving it
back reproduces the exact context the model saw; it does not add history. That
is the right fidelity for an A/B/C comparison and the wrong thing to read as
"the data is here".

`unavailable` is the complement: as-of-blind tools with no recording for the
arguments this run asked with.

## Reproduction check (2026-09-07)

Every sample was replayed once from the repo with the command above. All eight
runs completed (exit 0). `served` is the count of tools that answered from the
frozen recording.

| sample                     | source (variant / recorded run)                | as-of                      | served | unavailable | partial |
| -------------------------- | ---------------------------------------------- | -------------------------- | ------ | ----------- | ------- |
| `2026-09-03-premarket`     | `item4` / `run-c8698f88…b311f12`               | `2026-09-03T12:45:00.000Z` | 4      | 11          | yes     |
| `2026-09-03-intraday`      | `item4` / `run-e9598f22…3218d5`                | `2026-09-03T17:00:00.000Z` | 3      | 10          | yes     |
| `2026-09-03-close`         | `argon-local` / `run-5d8362f1…f66a8e`          | `2026-09-03T20:15:00.000Z` | 2      | 10          | yes     |
| `2026-09-04-premarket`     | live record 2026-09-07 / `run-49226246…045dd`  | `2026-09-04T12:45:00.000Z` | 6      | 11          | yes     |
| `2026-09-04-intraday`      | live record 2026-09-07 / `run-f305044a…4cdaad` | `2026-09-04T17:00:00.000Z` | 5      | 10          | yes     |
| `2026-09-04-close`         | `review-v7` / `run-e7abdf17…5450bea282`        | `2026-09-04T20:15:00.000Z` | 5      | 10          | yes     |
| `2026-09-06-weekly`        | `review-v7` / `run-bf4b1795…4b311f12`          | none (live weekly)         | n/a    | n/a         | n/a     |
| `2026-09-02-close-holdout` | live record 2026-09-07 / `run-d2f22b4b…c0e481` | `2026-09-02T20:15:00.000Z` | 5      | 10          | yes     |
| `2026-09-06-weekly-v2`     | live record 2026-09-08 / `run-7d888bb3…1a895a` | `2026-09-06T12:00:00.000Z` | 5      | 2           | yes     |

Served / unavailable in full, per sample:

- `2026-09-03-premarket` — served `ow_tv_watchlist, ow_uw_calendar, ow_uw_earnings, ow_uw_headlines`; unavailable `ow_argon_levels, ow_argon_watchlist, ow_frank, ow_spot, ow_strike_check, ow_uw_chain, ow_uw_earnings, ow_uw_gex, ow_uw_headlines, ow_uw_iv_term, ow_uw_ticker_metrics` (18/29). Replay run `run-4c0434f3-4525-4bc2-83ba-a9a6c5c380a7`.
- `2026-09-03-intraday` — served `ow_tv_watchlist, ow_uw_calendar, ow_uw_gex`; unavailable `ow_argon_levels, ow_argon_watchlist, ow_frank, ow_spot, ow_strike_check, ow_uw_chain, ow_uw_earnings, ow_uw_headlines, ow_uw_iv_term, ow_uw_ticker_metrics` (19/29). Replay run `run-11287b2f-6171-4280-8bee-4e475230b3a1`.
- `2026-09-03-close` — served `ow_tv_watchlist, ow_uw_calendar`; unavailable `ow_argon_levels, ow_argon_watchlist, ow_frank, ow_spot, ow_strike_check, ow_uw_chain, ow_uw_earnings, ow_uw_gex, ow_uw_iv_term, ow_uw_ticker_metrics` (19/29). Replay run `run-db89498b-76df-4209-a78c-e04f5c502538`.
- `2026-09-04-premarket` — served `ow_argon_watchlist, ow_spot, ow_tv_watchlist, ow_uw_calendar, ow_uw_gex, ow_uw_headlines`; unavailable `ow_argon_levels, ow_frank, ow_ib_positions, ow_spot, ow_strike_check, ow_tv_commodities, ow_uw_chain, ow_uw_earnings, ow_uw_iv_term, ow_uw_ticker_metrics, ow_x_posts` (18/29). Replay run `run-19ecdc19-85b3-48f4-bd94-1becb0bcc66e`.
- `2026-09-04-intraday` — served `ow_argon_watchlist, ow_spot, ow_tv_watchlist, ow_uw_calendar, ow_uw_gex`; unavailable `ow_argon_levels, ow_frank, ow_ib_positions, ow_strike_check, ow_tv_commodities, ow_uw_chain, ow_uw_earnings, ow_uw_headlines, ow_uw_iv_term, ow_uw_ticker_metrics` (19/29). Replay run `run-5dfd5542-b477-4c55-88b7-97c78f819ed1`.
- `2026-09-04-close` — served `ow_argon_watchlist, ow_spot, ow_tv_watchlist, ow_uw_calendar, ow_uw_gex`; unavailable `ow_argon_levels, ow_frank, ow_ib_positions, ow_spot, ow_strike_check, ow_tv_commodities, ow_uw_chain, ow_uw_headlines, ow_uw_iv_term, ow_uw_ticker_metrics` (19/29). Replay run `run-ba84cb95-c0a6-468a-b695-b8be6777cc57`.
- `2026-09-06-weekly` — no `pit coverage` line at all. The weekly runs without `--as-of`, and the tenant only substitutes recordings on the as-of path, so `--replay-from` is inert here. Replay run `run-02838164-4633-4d59-89be-8214aacf2fe5` completed; see this sample's `MISSING.md` for why that is structural rather than a gap.
- `2026-09-02-close-holdout` — served `ow_argon_watchlist, ow_tv_watchlist, ow_uw_calendar, ow_uw_gex, ow_uw_headlines`; unavailable `ow_argon_levels, ow_frank, ow_ib_positions, ow_spot, ow_strike_check, ow_tv_commodities, ow_uw_chain, ow_uw_iv_term, ow_uw_ticker_metrics, ow_x_posts` (19/29). Replay run `run-fb206ede-47dc-4795-8ee1-d1bb98a6ec4f`.

A tool can be in BOTH lists: the model calls it more than once, one argument
set hits the recording and another does not.

## The hold-out

`2026-09-02-close-holdout` is not shown to the author or the reviewer during
tuning. It exists to be run once, at the end, against a framework that was
never fitted to it.

## The weekly replays now (2026-09-08)

The 2026-09-07 table row above and `2026-09-06-weekly/MISSING.md` both say the
weekly cannot be `--replay-from`'ed. **That is no longer true, and no code was
changed to make it true** — two commits after those notes were written already
fixed it, and nobody re-ran the sample to notice:

1. `18a953a` moved the recordings-first branch in
   `plugins/option-wizard/tools/index.ts` ABOVE `if (asOf === undefined) return
   built;`. A replay now replaces the WHOLE tool surface with a recording
   lookup — not only the `AS_OF_BLIND` list — so a tool that reads a dated
   store is served from the frozen response like any other, and a call with no
   recording returns `{"unavailable":"as-of",...}` instead of reaching the
   network. There is no live fallback on this path.
2. `pit-replay.sh replay` falls back to `steps.json`'s `run.startedAt` when
   `run.json` has no `asOf`. The weekly's is `2026-09-06T21:26:55.076Z`, so the
   run gets the recorded clock the live run had, and `pit coverage:` is printed
   (it is gated on the run having an as-of at all).

Verified by running it twice from one sample, changing only the prompt file:

```bash
# A — team.yaml as it stands
HELIUM_ENV_FILE=~/.config/helium/helium.env \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-06-weekly <state root A>

# B — the same replay with a different prompt manifest swapped in
FLASH_DRAFTS_DIR=<scratch> HELIUM_ENV_FILE=~/.config/helium/helium.env \
  scripts/flash-abc.sh 2026-09-06-weekly B <state root B>
```

| run | manifest      | `teamYamlSha256` | run id                                  | exit | wall | pit coverage                                                                                          |
| --- | ------------- | ---------------- | --------------------------------------- | ---- | ---- | ----------------------------------------------------------------------------------------------------- |
| A   | `team.yaml`   | `3221618c…a9a9d8` | `run-1b5e867d-52ca-4a07-9672-dfbed9494efd` | 0    | 106s | 29/30 — served `ow_reports, ow_review_window, ow_rotation, ow_session_frame`; unavailable `ow_uw_headlines` |
| B   | `team.B.yaml` | `2499b3dd…e7046`  | `run-d8acb771-e092-4055-b9c2-4038ff4b2a5e` | 0    | 96s  | 30/30 — served `ow_macro_rates, ow_reports, ow_review_window, ow_rotation, ow_session_frame, ow_uw_market_state` |

Both rendered a weekly page, and the two differ:

    cf48ec44d973aef8b87e1b8e4f16569eb1b11b5e8cf39dc4dd4f7777b1647d18  A render-dump/option-wizard-2026-09-06-weekly.html (5180 B)
    e901f9a7e9d1917fc8a7ede8dccfd4bcab3b1b3bbff23adc52896ac23499ffb0  B render-dump/option-wizard-2026-09-06-weekly.html (4945 B)

Read this for exactly what it proves: **one recorded weekly input can be
re-authored under a different prompt in under two minutes, offline.** It is NOT
a controlled A/B — one run each, and a model re-run of the SAME manifest would
also differ. What is controlled is the input: both runs read the same nine
recordings under the same recorded clock.

`ow_uw_headlines` in run A is the honest half of the mechanism. The recorded
weekly never called that tool, so there is nothing to serve and the replay
refuses rather than fetching today's headlines into a 2026-09-06 page. A tool
whose arguments differ from the recorded ones refuses the same way — which is
why A and B, having chosen different arguments, have different coverage.

## `2026-09-06-weekly-v2` (added 2026-09-08)

The ninth sample. It exists because the older `2026-09-06-weekly` recording
predates `ow_stock_week` (#106 Loop 1a / #107 item 1), so a replay of the
current tenant against it refuses that tool for want of a recording. Replayed
once from the repo: exit 0, `run-3818ab81-bdbe-4d0d-adbe-5161acc3a1dd`, 29/31 —
served `ow_reports, ow_review_window, ow_rotation, ow_session_frame,
ow_uw_earnings_report`; unavailable `ow_stock_week, ow_uw_headlines` (both
argument mismatches, the mechanism described above). Its own README records the
apex version, which data path the tool took, and the UW vintage limit.
