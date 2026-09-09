# Loop 1b (#108 prompt layer) — the W37 replay, read on the real Argon route

One replay of the frozen `docs/evidence/flash-samples/2026-09-06-weekly-v2`
sample against `feat/flash-loop1` after the #108 prompt and gate changes.
No live model input, no delivery, no production write.

```bash
HELIUM_ENV_FILE=~/.config/helium/helium.env NO_PROXY=100.66.147.98,localhost,127.0.0.1 \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-06-weekly-v2 <state root>
node scripts/flash-page-payload.mjs steps.json payload.json
# argon worktree at v0.13.7, web/: fixture server + next dev --port 3107
node scripts/capture-flash.mjs http://localhost:3107/flash/2026-W36 steps.json <out>
```

Two runs, `run1/` and `run2/`, each with the same four files.

| file               | what it is                                                              |
| ------------------ | ----------------------------------------------------------------------- |
| `steps.json`       | the replay's evidence dump, `view` included                             |
| `page.md`          | reader-visible text of the real Argon `/flash/2026-W36` route           |
| `capture.json`     | run id, Argon sha, source/view/page hashes, mobile overflow             |
| `number-audit.txt` | `scripts/flash-number-audit.mjs` over the page and the run's recordings |

`run1` — `run-5b3e8ede-3937-4a1f-b939-f6936c8db827`, exit 0, pit coverage
29/31. `view.faults` empty; 11 calls / 11 untested; number audit 118/118
(107 char-for-char, 11 through the renderer's own rounding), 0 misses.
Argon `63fa2cd9` (v0.13.7, clean), `pageSha256`
`5f162e18185c451409b360b8d9be13cbaff463e12eb11cd3323586397e30695d`,
mobile horizontal overflow 0.

`run2` — `run-604cd25b-a9f8-4b6e-af1b-46f1f20f3093`, exit 0, pit coverage
30/31 (only one `ow_uw_earnings_report` argument set unavailable), after the
second round of fixes: the "(N of M priced)" label, the dealer/fx move
arithmetic, the as-of attribution and post-window rules, and a top-three
|excess| mandate the `"missing: "` prefix cannot excuse. 11 calls / 11
untested, all three largest |excess| rows called, no coverage-decline fault.
Number audit 121/121 (115 char-for-char, 6 rounding), 0 misses. Argon
`63fa2cd9`, `pageSha256`
`3015b57e52a7a199ce0c2a101d416c820f7c7aa688d2d5180b5a5a98a0de0157`,
mobile overflow 0.

`run2` still lost its dated-catalysts paragraph — the author wrote "EPS",
which the admitted rows do not carry, so the renderer dropped it. The prompt
now names that shorthand explicitly; a sixth replay under that wording lost
the paragraph again to an option expiry date instead. The gate is behaving
correctly; the author's habit of citing supporting dates in §5 is not yet
fixed by wording alone.

The renderer fixes to the sector "(N of M priced)" label and to the dealer and
fx moves CANNOT be seen on either page: both replays read a frozen
`ow_session_frame` recording, so the rows still print the old strings. The
unit tests in `plugins/option-wizard/tests/quality-channels.spec.ts` and
`quality-coverage.spec.ts` are the evidence for those three.

Two runs of one model on one input. They show the rules hold here; this is not
an A/B and not an editorial acceptance.
