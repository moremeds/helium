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

<!-- TABLE -->

## The hold-out

`2026-09-02-close-holdout` is not shown to the author or the reviewer during
tuning. It exists to be run once, at the end, against a framework that was
never fitted to it.
