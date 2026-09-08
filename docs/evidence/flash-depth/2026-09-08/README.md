# Flash depth and upcoming-event window, September 8

Local implementation evidence, not an editorial acceptance or a production run.
The baseline was executed before the changes. Original model outputs, refusals,
raw recordings and source dates are preserved without manual prose repair.
No merge, deployment, email or production database write occurred.

## Implemented behavior

- Weekly review/outlook ceilings are 900/450 words; daily ceilings are 300/120.
  Selected topics connect dated facts, same-window comparisons, mechanisms,
  counterevidence and observable next developments. These are ceilings, not targets.
- UW completed EPS rows and quarterly income statements are available through
  `ow_uw_earnings_report`. Actual and estimated EPS have unknown accounting basis;
  statements are separate, unknown currency stays unknown, and guidance/revenue
  consensus are absent. This is current provider history, not a vintage archive.
- Normal upcoming earnings are admitted through seven calendar days inclusive;
  important names through fourteen. Important currently means Argon pinned names
  plus the explicitly declared NVDA. The optional user question about a broader
  important-name list was unanswered at implementation time. Those names are
  queried first under the existing 60-name limit. Past/out-of-window earnings
  never become focus events. Weekly authors use the admitted frame rather than
  fetching unconstrained future earnings dates. Historical financial facts remain
  available. Macro calendar rows also stay within seven days; later policy
  probabilities remain in the macro evidence as background.
- Argon renders topic headings and keeps focus/themes/rotation in one closed
  native details block. Word trimming preserves paragraph and heading boundaries.
- The CLI respects NO_PROXY through installed Undici. With the configured Apex
  host explicitly bypassed, a real SPY request returned HTTP200 and six daily bars.
  This fixes the local path that made the baseline report all bars as HTTP502.

## Executed comparisons

See `runs.json` for exact run IDs, clocks, code SHAs, hashes and original refusals.

| Sample | Execution | Review / outlook words | Interpretation |
| --- | --- | --- | --- |
| baseline | Fresh weekly on 33e7c26 | 268 / 326 | Original page, missing bars |
| replay | New prompts, frozen baseline recordings on de50708 | 292 / 345 | Same recorded facts; old recorded caps remain; one missing macro request explicitly refused with no live fallback |
| after | Fresh inputs on de50708 | 663 / 386 | Bars restored and UW financial facts fetched; input changes mean this is not a prompt-only A/B |
| accept | Frozen after recordings on 76a3c9f | 522 / 339 | All seven returned tool responses byte-match the source run; this directory name is a variant label, not acceptance |
| final | Fresh weekly on 3e48937 after horizon change | 584 / 334 | Actual calendar now contains only supplied ADBE 2026-09-10; October/December earnings absent |

The final frame's focus nearest events also contain only ADBE; distant AVGO/TSLA
and other earnings are absent. Its ten raw recordings include an actual ADBE
completed earnings/income-statement response. This demonstrates source access,
not that the author successfully used those facts in the main article.

## Verification

- Helium: 1,131 unit tests passed, 3 skipped; typecheck and full build passed.
  Date boundaries cover ordinary day 7/8, important day 14/15, past dates and
  distant November earnings; an existing batching test proves NVDA is queried first.
- Argon: 23 focused heading/weekly tests passed; TypeScript and ESLint passed.
  The capture script verifies run ID and canonical view digest before saving text
  and screenshots, including when a source headline begins with a Markdown heading.
- Baseline and final real `/flash/2026-W37` routes were captured at desktop and
  mobile widths. Both have zero mobile horizontal overflow. Final capture records
  Argon 77b3b45a with a clean tree. All 42 archived raw recordings match their own
  SHA256 fields; a credential-pattern scan of steps and decompressed recordings
  found no token-like values. No external delivery was enabled.

## Not closed

The deeper layout and earnings horizon are verified. The author is **not** an
accepted positive calibration sample:

- The final advisory budget gate still refuses the 42-word ADBE focus line against
  its 40-word ceiling. The renderer's original truncation and degradation remain.
- The authored catalyst paragraph mixed a weekly boundary and historical earnings
  period/EPS discussion into its calendar text; the source admission check dropped
  it. The actual dated calendar row remains visible. Completed financial facts were
  fetched but not successfully integrated into the main analysis in this sample.
- Some causal wording remains insufficiently supported. The macro review calls
  snapshots weekly changes; the outlook speculates about ONI direction without a
  fresh ONI reading. These are editorial failures, not proven market conclusions.
- Fifty basket symbols answered, but that is not fifty fresh observations: XLE
  remains stale. Earnings looked up 60 of 161 universe names. The two prior close
  files carry candidate proposals, not a complete week of market-observation prose.
- A fresh daily author run at September 8 premarket is still the scheduled 12:00 UTC
  checkpoint. Tests establish daily length/phase continuity, not that future prose.
  Intraday/close live behavior, reviewer calibration and production shadow remain
  unperformed. Do not upgrade this local implementation evidence into those claims.

## Reproduce the final page without a model or a database

Build Helium, then serve `final/payload.json` with the companion Argon
`web/tests/e2e/flash-fixture-server.mjs`, point Next's `NEXT_INTERNAL_API_BASE`
at that local server, and capture `/flash/2026-W37` against `final/steps.json`
using `web/scripts/capture-flash.mjs`. The original baseline remains in
`baseline/page/`. For a live daily run, use the environment and timing in
`docs/flash/2026-09-08-premarket-preparation.md`.
