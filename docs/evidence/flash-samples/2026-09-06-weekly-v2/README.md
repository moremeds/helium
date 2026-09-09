# 2026-09-06 weekly, v2 — the first recording that contains `ow_stock_week`

Recorded 2026-09-08 on `feat/flash-loop1` (Loop 1a of #106, scoped from #107).
The existing `2026-09-06-weekly` sample predates `ow_stock_week`, so replaying
this branch's tenant against it refuses the new tool for want of a recording.
This sample exists so that refusal is not the only available evidence.

```bash
HELIUM_ENV_FILE=~/.config/helium/helium.env \
NO_PROXY=100.66.147.98,localhost,127.0.0.1 \
  scripts/pit-replay.sh record 2026-09-06 weekly <state root>     # this sample
HELIUM_ENV_FILE=~/.config/helium/helium.env \
NO_PROXY=100.66.147.98,localhost,127.0.0.1 \
  scripts/pit-replay.sh replay docs/evidence/flash-samples/2026-09-06-weekly-v2 <state root>
```

Layout is the one `../README.md` documents: `run.json`, `tool-io/`, `run.log`,
`report.md`, `render.html`, `steps.json`. Delivery was disabled
(`HELIUM_TENANT_DELIVERY=0`); no email left the machine and nothing was written
to production.

## Which data path this recording took

**The apex-bars fallback, not `/v1/equity/returns`.** The mini's apex is pinned
at **0.1.5** (`/health` -> `"version":"0.1.5"` on 2026-09-08), and the 0.1.6
batch endpoint answers 404 there:

    GET /v1/equity/returns?symbols=SOXX,SPY,QQQ,MU,SNDK,SMH&start=2026-08-31&end=2026-09-04
    -> HTTP 404 {"error":{"code":"unknown_symbol","message":"no artifact for
       returns under asset_class=equity","symbol":"returns","asset_class":"equity"}}

So `ow_stock_week` ran #107's explicitly allowed temporary path: per-symbol
daily closes through `ow_apex_bars`, the window arithmetic in the tool, the
0.1.6 output shape, and `source: "apex-bars-fallback"` on every payload. Every
recording here carries that field — when apex 0.1.6 lands, a recording made
against the endpoint will say so instead.

The fallback reproduces apex's own published check values for this week from
the same adjusted closes (adjustment_revision 40): SOXX +0.0221, SPY +0.0011,
QQQ +0.0035, MU +0.0898, SNDK +0.1717. No mismatch was found.
`ytd_return` and `pct_from_52w_high` are `null` on this path by design.

**SMH is no longer missing.** The Silver gap that put it in `missing` on
2026-09-08 morning was rebuilt (revision 40) before this run; `missing` is
empty in every recording here.

## What the run produced

`ow_session_frame`'s payload now carries `coverageCandidates` — the
coverage-selection pre-pass. Its ranked eight, verbatim from
`tool-io/00001-ow_session_frame.json.gz`:

| rank | symbol | window return        | excess vs SPY        |
| ---- | ------ | -------------------- | -------------------- |
| 1    | SNDK   | +0.17173295263235877 | +0.17064112186612745 |
| 2    | FIG    | -0.16308119361554474 | -0.16417302438177606 |
| 3    | DELL   | +0.14882517972996667 | +0.14773334896373536 |
| 4    | CDNS   | -0.14010399835482823 | -0.14119582912105955 |
| 5    | SNPS   | -0.11018729807279559 | -0.11127912883902691 |
| 6    | PANW   | -0.10315132269436744 | -0.10424315346059876 |
| 7    | DE     | +0.10026494058667668 | +0.09917310982044536 |
| 8    | MOS    | +0.09533898305084754 | +0.09424715228461622 |

Ranked 8 of 50 priced symbols, benchmarks SPY +0.0010918 and QQQ +0.0035314.
The author then called `ow_stock_week` itself for `["DELL","SNDK","NVDA","AMD"]`
(`tool-io/00012-ow_stock_week.json.gz`).

The page's numbers are the payload's, rounded for prose: "SPY returned +0.1% and
QQQ +0.4% over the window", "SNDK (+17.2% week, +17.1% vs SPY)". The renderer's
own preamble line opens Supporting coverage and no model wrote it:

    Daily close, apex/livewire, week 2026-08-31→2026-09-04 (prior Friday close →
    Friday close); intraday windows are 1m bars in ET; macro releases per argon
    published_at

## Replay result (2026-09-08)

`scripts/pit-replay.sh replay` on this sample: **exit 0**, run
`run-3818ab81-bdbe-4d0d-adbe-5161acc3a1dd`, 102s, and the replayed page carries
the same preamble line.

    pit coverage: 29/31 (from recordings: ow_reports, ow_review_window,
    ow_rotation, ow_session_frame, ow_uw_earnings_report)
    (unavailable: ow_stock_week, ow_uw_headlines)

`ow_stock_week` is in BOTH halves of that mechanism and it is the honest half:
the recording is keyed by ARGUMENTS, the replay's author asked for a different
symbol list than `["DELL","SNDK","NVDA","AMD"]`, and the run refused rather than
fetching live prices into a 2026-09-06 page. The ranked list the author actually
reads was served — it rides inside the `ow_session_frame` recording. This is the
same behaviour `../README.md` documents for `ow_uw_headlines`.

## Limits of this sample

- **The UW-sourced rows are as of 2026-09-08, not as of 2026-09-06.** Unusual
  Whales serves current data with no vintage, so the earnings and calendar
  material in this recording is what UW held on the day it was recorded. The
  single dated event in `coverageCandidates.events` — ADBE earnings 2026-09-10
  — is a forward event read on 2026-09-08. Nothing here reconstructs what the
  calendar looked like on 2026-09-06.
- The frame ran in `mode: "no-data"`: the as-of clock makes the live-only
  sources refuse (`ow_spot`, `ow_uw_gex`, `ow_uw_calendar`, `ow_tv_*`, …, 15
  tools), so most macro coverage rows print `UNTESTED`. That is the ordinary
  shape of an as-of recording, not new breakage.
- `coverageCandidates` found **no** universe name with an earnings date inside
  2026-08-31..2026-09-04. `ow_uw_earnings` serves the NEXT scheduled date, so a
  week that has already closed has no names left in it. The earnings limb of
  #107's union is therefore empty in this sample by construction.
- One live model run. It is evidence that the data path works end to end, not
  an A/B against the older sample and not an editorial acceptance.
