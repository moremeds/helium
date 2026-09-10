# Loop 3 (#108 — the user's three items of 2026-09-09)

Three replays of frozen recordings against `feat/flash-loop3`. No live model
input, no delivery, no production write, nothing touched on the mini beyond
read-only `ssh`.

The three items, verbatim from the #108 review comment (id 5597715960):

1. **Weekly coverage should be longer.** ("weekly coverage 应该可以再长一些") The
   weekly review body came out at ~2.3k words vs premarket ~3.8k. The 11 macro
   coverage rows were all `untested` with one-line "missing:" reasons; the
   sector/theme rows got one clause each. Longer here means each coverage row
   that has a data block behind it (stockWeek, eventDay, newsOverview, macro)
   gets the same per-basket treatment the Memory/Storage paragraph got — not
   more adjectives. Daily stays the smaller-scale version of the same shape
   (per the 09-09 rule on #106: "daily就是规模小一些而已").
2. **Daily premarket is good as-is.** ("daily premarket 不错") Treat the 09-09
   premarket output as the reference shape for daily; do not regress it while
   lengthening weekly.
3. **Drop inline source parentheticals; collect sources into one foldable
   list.** ("括号里面的source可以省略 统一加入foldable 的dropdown list里面") … Wanted:
   prose without them, and one collapsed "Sources" block per note listing tool
   / as-of / headline provider+timestamp. Renderer note: Gmail strips
   `<details>`, so the email gets a plain "Sources" section at the end and the
   argon brief page gets the real `<details>` fold. Provenance must still be
   machine-checkable — the provenance whitelist in #117 should read from the
   sources block, not from the prose.

**These three replays predate the rebase onto `03df66b`** (#119
`ow_macro_releases`, #120 `ow_premarket_movers`). The frozen samples carry no
recording for either tool, so a replay cannot exercise them and none was
attempted; the two new Sources rows are unit-tested instead
(`tests/render-sources.spec.ts`: the release window prints with **no** as-of,
because `MacroReleasesSummary` carries none, and the movers row prints its own
`asOf` and session).

## What was replayed

```bash
scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-06-weekly-v2 <fresh state root>
scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-04-premarket <fresh state root>
node scripts/flash-number-audit.mjs <evidence.json> <state root>/runs/<runId>/tool-io
```

| dir           | run                                        | pit coverage | numbers                                       | faults                                                   |
| ------------- | ------------------------------------------ | ------------ | --------------------------------------------- | -------------------------------------------------------- |
| `run1/`       | `run-b9ec0ed2-3ad9-4ddd-a04d-64b56b4e2eb5` | 31/33        | 153/153 (119 verbatim, 34 rounding), 0 misses | none                                                     |
| `run2/`       | `run-541ee712-9a53-43da-9f9a-77ffe457e914` | 29/33        | 134/134 (114 verbatim, 20 rounding), 0 misses | none                                                     |
| `premarket/`  | `run-acba0a36-2cf6-407d-8f18-887a57146be2` | 25/33        | 114/114 (111 verbatim, 3 rounding), 0 misses  | 2 — both pre-existing focus-list faults in the recording |

Each directory carries `steps.json` (the replay's evidence dump, `view`
included), **`view.json`** (the rendered `BriefView` alone: `sources`,
`faults`, and the rendered section bodies, extracted from the same
`steps.json` — no model was re-run to produce it), `report.md` and
`number-audit.txt`.

Read off those `view.json` files:

| dir          | section titles                                                              | `sources` rows | `faults` | `ow_*` in rendered prose | as-of parentheticals in rendered prose |
| ------------ | --------------------------------------------------------------------------- | -------------- | -------- | ------------------------ | -------------------------------------- |
| `run1/`      | Market review · Outlook · Dated catalysts · Supporting coverage · Sources | 13             | 0        | **0**                    | **0**                                  |
| `run2/`      | same five                                                                    | 13             | 0        | **0**                    | **0**                                  |
| `premarket/` | same five                                                                    | 11             | 2 (pre-existing focus-list) | **0**         | **0**                                  |

"Rendered prose" is the concatenated `Market review` + `Outlook` + `Dated
catalysts` bodies as they reach the reader. The number audit runs over the same
rendered page and reports **0 misses** on all three, which is what proves the
strip ate no figure: the parentheticals that are DATA survive untouched —
`(+5.7% vs SPY, all six of NVDA, AMD, ARM, DELL, HPE, HPQ priced)`,
`(+17.06% vs SPY)`, `(+2.85%)`.

### The strip firing is NOT in these three runs, and that is worth saying

An earlier weekly replay of the same sample
(`run-6aa0fb77-888d-40bd-a07d-3a6e42e1a91d`, pit coverage 32/33) raised exactly
the fault this change exists for:

> 复盘 carries inline source parentheticals (as of 2026-09-03) (as of
> 2026-09-03) (as of 2026-09-03) (as of 2026-09-04) — removed; the Sources
> block is where a source goes

That run is **not** kept here: it predates the commit that wires `view.sources`
through `render/index.ts`, so its `view.sources` was empty and it does not
describe the shipped renderer. Re-replaying the same sample against the current
build drew a different author document (`ow_macro_rates` unavailable that time,
31/33 rather than 32/33) whose prose carries no source parenthetical, so the
fault does not fire in `run1` or `run2`. Which author document a replay draws
is not under this loop's control, so the fault is pinned by a unit test instead
— `tests/render-review.spec.ts`, "removes a source parenthetical from prose and
faults the page" and "faults prose that names a tool and leaves the sentence
alone". The replays above show the END STATE (0 and 0); the unit tests show the
mechanism.

## Item 1 — why the macro rows were untested, and what changed

The frame carries no macro-release block: `ow_macro_releases` is helium1's and
waits on argon #427. What the frame DOES carry is `ow_macro_rates`, and the
W37 rows (quoted from `run1/view.json`) show three different situations that a bare `missing:` collapsed into
one:

```
- rates.front · no datum this period · UNTESTED · frame block empty — DGS2 not ingested
- curve.shape · no datum this period · UNTESTED · frame block empty — DGS2 not ingested; 2s10s cannot be computed
- policy.path · 55.7 → — · UNTESTED · missing: no prior observation, level 55.7 without a change · frame block priced, as of 2026-09-04
- rates.long · 4.77 → -2 bp · CONTINUE · Ten-year eased to 4.77%, benign backdrop intact
```

Eleven rows now name which block was empty. `policy.path` is the case the user
was actually complaining about: the frame priced it and the author still wrote
`missing:`, and the row now says so on its own line. **No macro data was
built** — this is a reporting change over the frame that exists.

## What a replay cannot prove

The paragraph obligation (item 1's other half) is a PROMPT rule, and a replay
feeds the renderer a frozen author document. Neither replay exercises it: only
a live weekly run can. It is unit-tested as a manifest contract instead —
`tests/render-sources.spec.ts` asserts both the `weekly` and the `edit` task
prompts carry the byte-identical rule block, that the rule states its own phase
scale, and that the weekly `review` ceiling moved above 900 words while the
daily's stayed at 300.

The `<details>` fold itself is argon's, not this repo's: the email renders the
Sources rows flat (Gmail strips `<details>`), and the structured rows reach the
brief page as `view.sources` for argon to fold. That page lives in the argon
repo and is out of scope here.

## Refusals, recorded rather than worked around

- **The 2026-09-09 premarket the user praised could not be read.** On the mini
  it exists only as
  `~/.helium/state/evidence/option-wizard-2026-09-09-premarket-run-842f7634-….json`,
  and that file holds **five steps ending at `scenarios`** — the `edit` step
  never ran, and no `option-wizard-2026-09-09-premarket.md` was written to
  `~/.helium/state/reports/` (newest there is 09-08). The anti-regression check
  for item 2 therefore runs against
  `docs/evidence/flash-samples/2026-09-04-premarket`, the newest frozen
  premarket sample, and NOT against the 09-09 output. No 09-09 premarket
  numbers are quoted anywhere in this loop.
- **No 09-09 weekly run exists on the mini either** (newest weekly evidence is
  09-06). The weekly the user read on 09-09 is
  `docs/evidence/flash-loop2/2026-09-09/run3/report.md`, the Loop 2 replay, and
  that is the document the "11 macro rows" and the inline parentheticals in
  this README are quoted from.
- No live recording was made to fill either gap.
