# What is not in this sample

Source: scratchpad variant `review-v7`, run
`run-bf4b1795-b627-4df8-a5fe-b744ffb8e0d1`, run LIVE with no `--as-of` — the
weekly phase has no point-in-time instant. `weekend-2026-09-06` also recorded
this phase; `review-v7` is frozen because its rendered page and step JSON are
already in the repo at `docs/evidence/pit-replays/2026-09-06/review-v7/`.

**`--replay-from` serves this sample.** It did not when this file was written,
and the sentence that said so was structural at the time: the recordings-first
branch in `plugins/option-wizard/tools/index.ts` sat BELOW
`if (asOf === undefined) return built;` and substituted only the `AS_OF_BLIND`
tools, none of which the weekly calls. Commit `18a953a` moved that branch above
the as-of check, so a replay now substitutes the whole tool surface; and
`pit-replay.sh replay` takes the weekly's clock from `steps.json`'s
`run.startedAt` (`2026-09-06T21:26:55.076Z`) when `run.json` has no `asOf`.
Re-verified 2026-09-08, exit 0 in ~100s with a `pit coverage:` line — see the
"weekly replays now" section of `../README.md` for the two runs and their
hashes. The weekly called six tools — `ow_macro_rates`, `ow_reports`,
`ow_review_window`, `ow_rotation`, `ow_session_frame`, `ow_uw_market_state` —
and those six recordings are still the whole input set.

**Not recorded anywhere.** News: the weekly team calls no news tool
(`ow_frank`, `ow_uw_headlines`, `ow_x_posts` were never invoked). This matches
the recovery plan's inventory row.

**Errored calls.** One `ow_uw_market_state` call threw and was recorded with
`raw: null`. The other call to it returned.

`steps.json` is the per-step evidence dump for this run; `report.md` and
`render.html` are the delivered markdown and the rendered page.
