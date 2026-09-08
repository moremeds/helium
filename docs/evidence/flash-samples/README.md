# Frozen inputs for the Flash recovery (Step 0)

Eight samples. Each directory holds everything a fresh session needs to
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
