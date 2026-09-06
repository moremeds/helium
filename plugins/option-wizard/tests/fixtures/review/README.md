# Review-framework fixtures — provenance

Every number the review-framework specs assert comes from one of these files.
Nothing here is invented. Where a payload could not be recorded, the file says
so in this table and the test that reads it says so too.

## Recorded tool responses

Extracted on 2026-09-06 from the tool-io of the **2026-09-03 close as-of
replay**, `run-a6c307ef-5879-4f13-b241-088ba743fedd`. Each file is the recorded
`raw` string byte-for-byte, so its own sha256 equals the recorded `rawSha256`.

| file                                     | tool                   | args                                     | rawSha256                                                          | rawBytes |
| ---------------------------------------- | ---------------------- | ---------------------------------------- | ------------------------------------------------------------------ | -------- |
| `macro-2026-09-03-close.json`            | `ow_macro_rates`       | `{}`                                     | `c2f7aec37e82305cbc8be98bcc291ea2038d94b232c57dc92c8fa11df13d52b2` | 10327    |
| `policy-2026-09-03-close.json`           | `ow_argon_policy_path` | `{}`                                     | `63c2c0ba680b93739877620d1270b6a382d7df48f8173031aafa744ef916aa95` | 1157     |
| `gex-2026-09-03-close.json`              | `ow_uw_gex`            | `{"tickers":["SPY","QQQ"]}`              | `65fef2033a3b96bbd7c93d67f54fd0d95c4c79ff69e421f7f0ee6ed13528332f` | 134      |
| `tide-2026-09-03-close.json`             | `ow_uw_market_state`   | `{"sector":"Technology","etf":"SPY"}`    | `6937cf126d3b94ff4875e8b2ebadd89332c6ddee3d4ba321a2f3ce10fbcac194` | 38520    |
| `spot-unavailable-2026-09-03-close.json` | `ow_spot`              | `{"tickers":["SPY","QQQ","VIX","DXY"]}`  | `a4d974833ce9def23d4703082a760920ecbd7560f01d91c5d4ad686ac2c4e74b` | 104      |
| `commodities-2026-09-03-close.json`      | `ow_tv_commodities`    | `{}`                                     | `107362cc63273fdb86c2a81dd796a9b8fffec0c5737271d619e26e3366871c33` | 95       |
| `calendar-2026-09-03-close.json`         | `ow_uw_calendar`       | `{}`                                     | `4449c43b7fbbc41c0bb6fd04981d4621f064d6db00c299e50a8ddcba7a53984b` | 101      |

Four of those seven are `{"unavailable":"as-of", …}` exclusions, and that is
the point of keeping them: `ow_spot`, `ow_uw_gex`, `ow_tv_commodities` and
`ow_uw_calendar` all quote the present only, so a replay of a past instant has
no answer from them. `quality/channels.ts` must print those rows as `untested`
rather than dropping them, and these are the payloads that prove it.

## Reconstructed from a report this tenant actually produced

Not a recorded tool response. The values are real and dated; the envelope is
rebuilt in the tool's own shape so the extractor can be tested against it.

| file                                | rebuilt in the shape of | source                                                                                                                                        |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spot-2026-09-03-close-report.json` | `ow_spot`               | the `tape` block of `option-wizard-2026-09-03-close.md` (SPY 773.17 +8.01, QQQ 717.67 +8.43, IWM 295.19 +1.18, VIX 14.32 −0.87, DXY 98.977 −0.599). `fetchedAt` is the `ow_spot` timestamp that report's Layer Coverage section names: `2026-09-03T20:15:32.550Z`. |
| `closes-2026-09-03-04.json`         | nothing — a plain map   | the `tape` blocks of `option-wizard-2026-09-03-close.md` and `option-wizard-2026-09-04-close.md`. **Closes only.** No open/high/low/volume was recorded and none is invented; the tests build `Bar`s whose other fields are structurally required, are set to the close (volume 0), and are never asserted on. |

Both reports are the tenant's own as-of-dated output, kept at
`$SCRATCH/pit/weekend-2026-09-06/reports/`.

## Recorded from the router source, NOT from a live response

argon was **not running** on this laptop on 2026-09-06 (`OW_ARGON_API_BASE` is
not set in any `~/.config/helium/*.env`, and nothing answers on the usual
ports), so the four `watchlist-*.json` files below were transcribed from
argon's own source — read-only, never edited — rather than from a `GET`:

- `/Users/chenxi/projects/argon/src/uw_scan/api/models/watchlist.py`
  (`WatchlistChainInfo`, `WatchlistChainsResponse`, `WatchlistCard`,
  `WatchlistResponse` — the field list and its nullability)
- `/Users/chenxi/projects/argon/src/uw_scan/api/routers/watchlist.py`
  (`GET /watchlist/chains` preserves the taxonomy's declared order, not
  alphabetical; `GET /watchlist?chain=<name>` selects on many-to-many chain
  membership)
- `/Users/chenxi/projects/argon/src/uw_scan/watchlist_taxonomy.py` (the chain
  names and their members)
- `/Users/chenxi/projects/argon/src/uw_scan/api/server.py` — both routes are
  mounted under **`/api`**, so the live paths are `/api/watchlist/chains` and
  `/api/watchlist?chain=<name>`.

| file                             | holds                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `watchlist-chains.json`          | the ten chains `tenant.yaml` declares plus `Beta`, in taxonomy order                            |
| `watchlist-Computer-GPU.json`    | the seven real members NVDA, AMD, ARM, SMCI, DELL, HPE, HPQ                                     |
| `watchlist-Cybersecurity.json`   | the thirteen real members CRWD … CHKP                                                            |
| `watchlist-Beta.json`            | SPY, QQQ, IWM, DIA                                                                              |

What in them is **not** from a source of truth, and is labelled here rather
than passed off:

- `count` is the taxonomy tuple length. The live endpoint returns **DB
  membership**, which can differ.
- `pinned` is operator state that exists only in argon's database. The flags
  here (NVDA, AMD, CRWD, SPY) are **test values**, not the operator's real
  tickers-of-interest list. `pinned` is a UI flag, not market data.
- `spot` and `iv_rank` are `null` everywhere **except** in
  `watchlist-Beta.json`, where SPY 765.16 / 8.0306, QQQ 709.24 / 20.6943 and
  IWM 294.01 / 7.1784 are the real `close` and `iv_rank_1y` recorded by
  `ow_argon_metrics` for market date **2026-09-02** in the same
  `run-a6c307ef` replay. No price or IV rank anywhere in this directory is
  invented.
- `scanned_at_min` / `scanned_at_max` / `spot_quoted_at` are `null`: no scan
  timestamp was recorded, and a plausible-looking one would be a fabricated
  as-of.

**Backfill these from a real `GET` the first time argon is running** — the
tool's header comment is written from the observed response, not from this
file.

## Derived facts these fixtures support

- SPY 2026-09-03 → 2026-09-04: 773.17 → 770.19, **−0.3854 %** — the benchmark
  return the theme-basket tests measure excess against.
- QQQ over the same pair: 717.67 → 718.96, **+0.1797 %** (the 09-04 report's
  own tape reads `+0.18%`).
- IWM: 295.19 → 296.01, **+0.2778 %** (report tape `+0.28%`).
- `VIXCLS` in `macro-2026-09-03-close.json`: 15.2 on 2026-09-02 against 16.34 on
  2026-09-01 — 22 daily observations, newest first.
- `BAMLH0A0HYM2`: 2.66 against 2.65. `fredDirect.points` is empty in this
  recording (every FRED series `"fetch failed"` — the laptop cannot reach the
  FRED CDN), which is why the credit row falls through to `series.rows`.
- `DGS2` is **not ingested** in argon's mirror at all, so the front-end and
  curve rows have no source and must print `untested`.
