# September 8 premarket preparation

Authorized: finish complete-input validation and daily narrative continuity
before the first session after Labor Day. No merge, deployment, email or
production database writes. The real premarket is scheduled for September 8
12:00 UTC / 08:00 ET / 20:00 Hong Kong; target completion before 12:45 UTC.
Do not substitute a backdated live run for that execution.

## Prepared and checked

- Helium PR105 worktree: `/Users/chenxi/projects/helium/.worktrees/flash-market-weekly`.
- Argon PR425 worktree: `/Users/chenxi/projects/argon/.worktrees/flash-market-report`.
- The runner now passes its actual phase independently of its variant. Frame,
  prior brief and prior cause select the same daily chain: previous close →
  premarket → intraday → close. Frank/weekly do not replace a daily predecessor.
  Explicit future-day/phase requests cannot bypass the phase-aware cutoff.
- Fixed-clock regressions cover the September 4 → September 8 holiday gap and
  later records already present on disk. Unit suite: 1,126 pass, 3 skip;
  full build and typecheck pass. This proves selection, not future live content.
- Isolated local state: `/Users/chenxi/.local/state/helium-flash-20260908`.
  Its `reports/option-wizard-2026-09-04-close.md` is copied read-only from the
  actual mini production report. `prior-source.json` records source/time/hash;
  SHA256 is `987b23c5e2dbead71fe21730c9de08daa6825d03fe9c02ad6ec2aa77900167e6`.
  No September 4 regime state was available there. Treat the markdown as prior
  context, not proof of the new editorial standard or a complete prior frame.

## Source check at 08:00 Hong Kong (00:00 UTC)

On September 7 at 23:29 UTC, UW returned HTTP429 `daily_request_limit_hit`,
limit 120000, with reset described as 8PM EST / 5PM PST. First try one calendar
request through `ow_uw_calendar`; if still limited, preserve the error and stop
bulk requests. Do not upgrade a subscription. If recovered, inspect the real
`ow_session_frame`, `ow_uw_headlines`, calendar and earnings responses and save
raw outputs under a new readiness directory in the isolated state.

TradingView was restored using the installed desktop app with debugging port
9224. US10Y and GOLD quotes succeeded at 23:37 UTC. A fetch timestamp alone
does not establish observation freshness. Check status before starting another
instance; do not restart a running user session. The earlier readiness bundle
`readiness-1788823687313` preserves the quota failures, not successful readiness.

Use installed tools and the existing tenant `buildTools` factory. A convenience
probe is at `/tmp/flash-sep8-readiness.mjs`; it is optional and may be recreated
from the three tool names above. Pass `phase: 'premarket'`, `variant: 'live'`,
the isolated state and tenant calendar/extensions when checking the factory.

## Source/depth update at 08:56 Hong Kong

UW recovered and the local weekly completed with real inputs. Apex's apparent
HTTP502 was the CLI ignoring NO_PROXY; the installed Undici environment proxy
now respects it. The command below explicitly bypasses the configured private
Apex host. Fifty basket symbols answered, but some bars are stale; 60 of 161
universe names were checked for earnings. Do not call either count full freshness.

Upcoming earnings now use seven calendar days, or fourteen for Argon pinned names
plus declared NVDA. Important names are queried first. The actual final weekly
calendar contains ADBE September 10 and no October/December earnings. Weekly is
longer; daily remains shorter. UW completed financials and topic headings are wired.

See `../evidence/flash-depth/2026-09-08/README.md`: actual pages and frozen replays
are archived, but editorial acceptance remains open. Focus-word overage, catalyst
paragraph admission and unsupported causal/time-window wording remain in the final
sample. Preserve those findings and check whether the live premarket improves them;
do not manually fix saved model text or call this sample accepted. PR105 and PR425
remain unmerged and undeployed.

## Live run at 20:00 Hong Kong (12:00 UTC)

Read this task's latest progress and existing evidence first to avoid duplicate
runs. Verify the current ET date is September 8. From the Helium worktree,
load the canonical local environment without printing credentials:

```sh
set -a
source /Users/chenxi/.config/helium/helium.env
source /Users/chenxi/.config/helium/argon-local.env
set +a
export OW_ARGON_API_BASE="$ARGON_BASE_URL"
# Keep the configured private Apex service outside the outbound proxy.
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1},$(node -e 'process.stdout.write(new URL(process.env.OW_APEX_API_BASE).hostname)')"
export HELIUM_TENANT_DELIVERY=0 HELIUM_DEPLOYMENT=test
export HELIUM_STATE_ROOT=/Users/chenxi/.local/state/helium-flash-20260908
export HELIUM_AUDIT_DB="$HELIUM_STATE_ROOT/audit.db"
export HELIUM_RENDER_DUMP="$HELIUM_STATE_ROOT/render-dump"
export HELIUM_DSH_HOME="$HELIUM_STATE_ROOT/dsh"
node packages/cli/lib/cli.js run option-wizard --phase premarket --variant live
```

Confirm the environment file locations before sourcing; use existing provider
authentication if subscription tokens need refreshing. Do not log secrets.
No `--as-of` or replay input is allowed for this real run. Preserve console
output in a fresh local file. The runner saves evidence in `evidence/`, raw
recordings in `runs/<runId>/tool-io/`, and its report in `reports/`.

Inspect each source's actual observation date and failures, calendar/news and
earnings completeness, previous-session references and the final `view`.
Check the reported phase/day, provider/token accounting, gate outcomes and
disabled external deliveries. Missing input is a blocker or an explicit
limitation, never a fabricated observation.

Export the completed evidence using `scripts/flash-page-payload.mjs` into a new
file. Follow the existing commands in
`docs/evidence/flash-pickup/2026-09-08/README.md` to serve that payload through
the companion Argon fixture adapter and capture the real route
`/flash/2026-W37/2026-09-08?phase=premarket`. Keep the previous preview available
or use a free port. `capture-flash.mjs` must match run ID and view hash; read the
visible page and inspect desktop/mobile captures. Do not score the transcript
or email teaser. Preserve evidence before updating PR105 if changes are needed.

Intraday/close live behavior cannot be observed before those phases happen.
Before the open, acceptance consists of the actual premarket page plus tested
phase selection and narrative instructions. Do not represent historical replay
or synthetic phase tests as fresh intraday/close model output.

One heartbeat handles both checkpoints. Stay quiet on unchanged state; report
meaningful recovery, failure or final evidence. Pause it after the final attempt.
