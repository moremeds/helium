# What is not in this sample

Source: scratchpad variant `review-v7`, run
`run-bf4b1795-b627-4df8-a5fe-b744ffb8e0d1`, run LIVE with no `--as-of` — the
weekly phase has no point-in-time instant. `weekend-2026-09-06` also recorded
this phase; `review-v7` is frozen because its rendered page and step JSON are
already in the repo at `docs/evidence/pit-replays/2026-09-06/review-v7/`.

**`--replay-from` cannot serve this sample, and that is structural, not a gap.**
The recordings-first branch in `plugins/option-wizard/tools/index.ts` opens with
`if (asOf === undefined) return built;` and then only substitutes tools listed in
`AS_OF_BLIND`. The weekly called six tools —
`ow_macro_rates`, `ow_reports`, `ow_review_window`, `ow_rotation`,
`ow_session_frame`, `ow_uw_market_state` — and **none of them is as-of blind**:
every one reads a dated store and can answer for a past day on its own. So
`replay` here is a live re-run, `served` is empty, and no `pit coverage:` line is
printed. Reproduction of the frozen INPUTS is by reading `tool-io/` directly;
the six recordings are the whole input set.

**Not recorded anywhere.** News: the weekly team calls no news tool
(`ow_frank`, `ow_uw_headlines`, `ow_x_posts` were never invoked). This matches
the recovery plan's inventory row.

**Errored calls.** One `ow_uw_market_state` call threw and was recorded with
`raw: null`. The other call to it returned.

`steps.json` is the per-step evidence dump for this run; `report.md` and
`render.html` are the delivered markdown and the rendered page.
