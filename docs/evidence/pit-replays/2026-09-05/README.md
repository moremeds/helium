# Point-in-time replays — week of 2026-08-31, run 2026-09-05

Reports produced by `helium run option-wizard --phase <p> --as-of <instant> --variant <v>`
from branch `feat/pit-replay-narrative`, on the laptop, against the mini's argon
Postgres and the apex lake. Delivery was markdown only (no email, no argon).
Instants: premarket 12:45Z, intraday 17:00Z, close 20:15Z.

Narrative layer only (regime + editor). Candidate steps ran but every live
source (spot, chain, GEX, levels, headlines, commodities, IB book, calendar)
returns `{ unavailable: "as-of" }` for a past instant, so no candidate can
price. PIT coverage is 10/24 tools on every run.

| Variant | Code    | Runs                                             | Tokens  | What changed                                                                                              |
| ------- | ------- | ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| pit-v1  | 50a08d2 | 1 (kept as the leaky example)                    | —       | first as-of run; leaked same-day daily series, full-session tide, and read an empty calendar as a finding |
| pit-v2  | 5a570a7 | 15 (5 days × 3 phases)                           | 189,855 | strict `< asOfDay` on daily-keyed sources; tide trimmed to the instant; calendar unavailable as-of        |
| pit-v3  | 4432d16 | 3 (09-04 premarket, 09-03 close, 09-01 intraday) | 48,336  | personas: missing sources are a coverage fact only; check x_posts/headlines before naming the cause       |

Regime-step cause titles, v2 → v3:

| Day / phase     | pit-v2                                                                                         | pit-v3                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 09-04 premarket | "The tape I'd normally lead with is unquotable today…"; headline said payrolls land _tomorrow_ | "August payrolls printed 162k with +55k in back-revisions — the front end has no cut to give" (Timiraos, 12:31Z) |
| 09-03 close     | "Rates are last-seen at 09-02, not live…"                                                      | "A firm bid, not a rates story: SPY tide climbed to 773 with the 10Y last at 4.79%"                              |
| 09-01 intraday  | "Futures now price a 64% hike into 9/16…" plus a replay-meta headline                          | same cause, headline no longer about the replay                                                                  |

Residual defects visible in v3, not fixed here:

- Editor headline on 09-01 intraday opens with "No prior intraday brief exists" — prior-brief absence still leaks into the headline.
- `flash-budget` still refuses 1–2 sections per run (bodies over 60 words); the renderer trim does the enforcement.
- Close-phase recap step writes Chinese section titles ("今日故事") inside an English brief.
- markout/drift/recap steps spend a section on "nothing to settle"; that is the candidate side, moving to its own team.

Eyeball comparison only. No ground-truth scoring exists yet; the Outcome
Ledger settles forward from production runs.

## fix-v1 — the three content defects, re-run

`fix-v1/option-wizard-2026-09-03-close.md`, the same 2026-09-03 20:15Z close
instant re-run after the three fixes on `feat/quality-loop`
(run `run-a6c307ef-5879-4f13-b241-088ba743fedd`). What the previous run of this
instant (`argon-local`) got wrong, and what this one shows:

- The editor invented a rejected book out of two empty proposal lists —
  "Every structure priced strikes against levels far from where SPY … actually
  close", "Reject the book", "the arithmetic gate failed on every leg". Now:
  `Call: "No book this session — without a live spot no strike can be checked
  …"`, with Aggression `none` and MaxRisk/Invalidation `n/a`. No strike, leg or
  gate is described.
- The gex step asked the reader a question ("To proceed, I need clarification:
  Should I…"). Now the whole section is `GEX: unavailable — ow_uw_gex`.
- `ow_argon_metrics` dated its payload by the query day. The recording of this
  run (`00017-ow_argon_metrics.json.gz`) reads
  `{"source":…,"queriedAsOf":"2026-09-03","dataDate":"2026-09-02","rows":[…]}`,
  and the brief's own prose now says "End-of-day metrics dated 2026-09-02".
