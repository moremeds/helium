# Loop 4 — the ranked candidate table takes the union with the movers (#113 item 1)

The 2026-09-09 premarket missed Meta's Muse launch. `newsOverview` asks per-stock
feeds only for the ranked coverage candidates, META was not one of the five, and
the general feed had already scrolled past the 11:44Z Benzinga headline. #120 put
the move on the frame (`frame.premarketMovers`); this loop makes something select
with it.

`mergeMoverCandidates` (`plugins/option-wizard/quality/coverage-candidates.ts`)
folds the movers into `coverageCandidates.stocks` for premarket and intraday,
inside the unchanged `candidateLimit(phase)` of 5. The merged list is what the
per-stock news pass then asks for, so a name moving overnight gets its own feed
queried.

## The one deviation from the brief, and why

The brief asked for a merge "by magnitude of their own metric". That cannot
work, and the numbers say so:

- `excess_vs_spy` is a FRACTION over the reported Monday–Friday. The real
  2026-09-04 week's top five were 0.171, 0.164, 0.148, 0.141, 0.111.
- `ret` is a PERCENT over one overnight session. META's real 2026-09-09 premarket
  move was 5.794467627306518.

Compared raw, every mover outranks every ranked row and the whole priced table is
evicted. Converted to common units, no overnight move ever beats a week — META at
5.79 % is sixth behind five weekly excesses of 11 %–17 %, so the Muse launch is
missed again and the change buys nothing. A week and a night have no exchange
rate. So neither list prices the other: they take **alternate slots, ranked
first**, until the cap is full. At the daily cap of 5 that is three priced rows
and the two biggest movers. Dedupe is by symbol and the ranked row wins — a name
in both keeps its week numbers, its rank and its settleable `delta`, and gains
`overnight_ret`.

## What is proved, and how

| claim | where |
| ----- | ----- |
| union, cap, ordering, dedupe, the mover row's ledger id | `plugins/option-wizard/tests/coverage-movers.spec.ts` |
| the news pass asks for the merged list, and uses the movers' own `tvSymbol` instead of probing three venues | `plugins/option-wizard/tests/quality-news-overview.spec.ts` |
| the missing-movers path is unchanged | the replay below |

Every number in both specs is a recorded one: the ranked rows are the real
`coverageCandidates.stocks` of the 2026-09-06 weekly run
(`docs/evidence/flash-samples/2026-09-06-weekly-v2/steps.json`), the mover rows
are the real 2026-09-09T13:25Z `opencli tradingview screener` probe that
`tests/premarket-movers.spec.ts` already freezes.

**The union path is unit-tested only.** No frozen sample exercises it end to end:
the only premarket sample, `docs/evidence/flash-samples/2026-09-04-premarket`,
predates both `ow_premarket_movers` and `ow_stock_week` and has a recording for
neither. It also means no recording pairs a week return with an overnight move
for the SAME name, so the "a name in both" branch is exercised by merging twice
rather than by inventing a week return for META. This stays unit-only until a
live premarket recording exists; nothing here was recorded live and nothing was
fabricated to stand in for one.

## Replay — the missing-movers path (2026-09-09/run1)

```
HELIUM_ENV_FILE=~/.config/helium/helium.env \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-04-premarket <scratch>
```

`run-6b63ccc7-735c-4e52-a08a-fbe98b01c7a3`, replayed from
`run-49226246-88d2-46fe-8ce4-0339744045dd`. pit coverage 24/35.

The frame this run served is **byte-identical** to the sample's:
`ow_session_frame` `rawSha256`
`0ff5c0a5979e945267aa1d3c235dfef66e24315c20b93e2fdfa7e95fb11da4b2`, 22697 bytes,
in both the recording and this run's own `tool-io`. `ow_premarket_movers` is not
in the frame, `coverageCandidates` is absent, and the merge is therefore never
reached — which is the point: with no movers block the behaviour is the old
behaviour, to the byte.

`number-audit.txt`: 102 distinct printed numbers, 102 sourced (99 verbatim, 3
rounding), 0 misses.

The run's own outcome was `FAILED gate-refused — 1 of 9 steps failed: scenarios`
(`gate as-of-verbatim refused: referenceClose.value 769.55 appears in no tool
output from THIS step`). That is the scenario author quoting a close it was not
handed — a model-side gate refusal in a step that touches neither candidates,
movers nor news. It cannot be attributable to this change: the frame the model
read hashes identical to the recording, so nothing in this branch reached its
context.
