# Loop 2 (#106 stock-level coverage) — the W37 replay

Three replays of the frozen `docs/evidence/flash-samples/2026-09-06-weekly-v2`
sample against `feat/flash-loop2`. No live model input, no delivery, no
production write, nothing touched on the mini.

```bash
HELIUM_ENV_FILE=~/.config/helium/helium.env NO_PROXY=100.66.147.98,localhost,127.0.0.1 \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-06-weekly-v2 <state root>
node scripts/flash-number-audit.mjs <evidence.json> <state root>/runs/<runId>/tool-io
```

## run1 — superseded, not kept

`run-a2dabc79-ea4a-44d6-81c9-68cb30ee5d15`, exit 0, pit coverage 30/31. It ran
against a `lib/` built before the last renderer edit, so every §3e line printed
`- undefined · +17.2% week · …`: the frozen frame recording predates the
`coverageCandidates.stocks[].id` field, and that build still read `row.id`
rather than deriving the id from the symbol. The run is recorded here for the
defect it found and its output is not kept — the fix (`stockRowId(row.symbol)`
in `render/review.ts`, so a recording made before the field existed keys the
same way a live frame does) is what run2 exercises.

## run2 — the gate's own counter-example, kept

`run-0a3d6ca1-2a9d-4df0-96d4-5dca9020b6f9`, exit 0, pit coverage 30/31,
`view.faults` empty, number audit 122/122 (103 verbatim, 19 rounding), 0
misses — and every one of the eight §3e rows printed `UNTESTED · not called
this period`. **That page passing is the defect.** The ids were mintable and
nothing obliged the author to use one, so the ledger got zero single-name rows
and the next period's 复盘 would have had nothing to settle. It is kept here
because it is the evidence for the gate run3 exercises, not because it is an
acceptable weekly.

### run2 files

| file               | what it is                                            |
| ------------------ | ----------------------------------------------------- |
| `steps.json`       | the replay's evidence dump, `view` included           |
| `report.md`        | the delivered weekly markdown                         |
| `number-audit.txt` | `scripts/flash-number-audit.mjs` over page + recordings |

`view.faults` is empty. Number audit **122/122 sourced (103 verbatim, 19
through the renderer's own rounding), 0 misses** — the new §3e percentages all
resolve by the accepted fraction→percent path, which is what "the renderer owns
every derived number" has to mean in practice.

## run3 — `2026-09-09/run3/`, the accepted run

`run-65b7e32a-b3a2-420e-8f50-895b5cffa6e6`, exit 0, pit coverage 29/31 — served
`ow_reports, ow_review_window, ow_rotation, ow_session_frame,
ow_uw_earnings_report, ow_uw_headlines`; unavailable `ow_stock_week,
ow_uw_earnings_report` (argument mismatches, the mechanism
`flash-samples/README.md` describes). Run after the declined-call gate was
extended to the ranked stock rows and both prompt blocks were rewritten from a
permission into an obligation.

**`view.faults` empty. 3 of 8 stock rows called; the other 5 declined with a
`"missing: "` reason.** The three called ARE the three largest |excess vs SPY|,
which is what the gate refuses any excuse on:

```
3e stocks
- stock:SNDK · +17.2% week · excess vs SPY +17.1% · CONTINUE · +17.1% excess led, memory bid, prior print pre-window
- stock:FIG  · -16.3% week · excess vs SPY -16.4% · REVERSE  · -16.4% excess worst, software fade, no operating fact
- stock:DELL · +14.9% week · excess vs SPY +14.8% · CONTINUE · +14.8% excess on 9/1 in-window EPS 6.76 vs 4.95
- stock:CDNS · -14.0% week · excess vs SPY -14.1% · UNTESTED · missing: -14.1% excess but no dated cause for EDA drop
- stock:SNPS · -11.0% week · excess vs SPY -11.1% · UNTESTED · missing: -11.1% excess, no dated operating fact
- stock:PANW · -10.3% week · excess vs SPY -10.4% · UNTESTED · missing: -10.4% excess, no dated cause for the drop
- stock:DE   · +10.0% week · excess vs SPY  +9.9% · UNTESTED · missing: +9.9% excess rides ag beta, no dated trigger
- stock:MOS  ·  +9.5% week · excess vs SPY  +9.4% · UNTESTED · missing: +9.4% excess rides ag beta, no dated trigger
```

Three commitments reached the ledger under the existing id scheme —
`2026-09-06-weekly-verdict-stock:{SNDK,FIG,DELL}` — so deliverable 1 is closed
end to end: ranked row, printed call, minted id, settleable next period.

Number audit **134/134 sourced (111 verbatim, 23 renderer rounding), 0 misses**.
`stock:DELL`'s `EPS 6.76 vs 4.95` is verbatim from the recorded
`ow_uw_earnings_report` — the author quoted the in-window figures rather than
remembering them.

Files: `steps.json`, `report.md`, `number-audit.txt`.

## What this replay CANNOT show

Read this the way `flash-loop1/2026-09-08/README.md` says to read its own:

- **The clerk-step changes are invisible here.** A replay serves
  `ow_session_frame` from the recording, so the in-window earnings fan-out
  (item 2) and the recorded `ow_uw_headlines` call (item 3) never execute. Their
  evidence is `plugins/option-wizard/tests/coverage-stock-rows.spec.ts` —
  `inWindowEarnings` against the frozen DELL (in window) and SNDK (three weeks
  early) recordings, and the no-env frame asserting the headlines note.
- **The daily cadence is untested by replay.** No daily sample was replayed;
  the daily half (five ranked names, §3e outside the weekly branch, the
  unmintable-call fault at `period: "daily"`) is covered by unit tests only.
- **No Argon page.** `page.md` / `capture.json` need the argon worktree at
  v0.13.7 serving `/flash/2026-W36` on port 3107; that server was not started in
  this session, so those two files are absent rather than reconstructed. The
  commands are in `flash-loop1/2026-09-08/README.md`.
- **The stock-row gate is proven on the weekly cadence only by replay.** Its
  daily behaviour, the top-three refusal and the `"missing: "` acceptance are
  unit-tested in `coverage-stock-rows.spec.ts`; no daily sample was replayed.
