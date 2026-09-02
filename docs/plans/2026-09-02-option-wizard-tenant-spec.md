# option-wizard — tenant spec (Helium v2)

Status: **reconstruction**. The original,
`docs/superpowers/specs/2026-09-01-option-wizard-team-tenant-design.md`, was
never committed and is absent from disk and from git history. This file
replaces it and **supersedes §7.1 of `2026-09-02-helium-v2-design.md`**, using
that document's nouns (Tenant / Team / Role / Tool / Run / Step / Sandbox /
Audit row / Delivery, §2) and its plugin interfaces (§3).

Every line below is tagged: `[RECOVERED]` = a 2026-09-01 decision recovered
from the user's memory notes, treated as an authoritative requirement;
`[VERIFIED]` = checked against a real file, path cited; `[INFERRED]` = my
reconstruction, **needs confirmation**.

---

## 1. Purpose and output contract

**Output contract:** once per trading day, option-wizard emails one report
containing at most **five** preflighted candidate orders plus a **risk list**;
it never places, stages, or modifies an order. `[RECOVERED]`

option-wizard is helium's first tenant running natively on the team lane —
every step is an agent or a declared deterministic step, so it doubles as the
worked example of a real agent team. `[RECOVERED]` It is also the tenant that
proves doctrine 2: all of its domain knowledge lives in `plugins/option-wizard/`
and none of it in `packages/core`.

**Non-goals** (from v2 §1, restated so nobody re-adds them): no accepted-claim
ledger, no `docs/evidence/claims.yaml` machinery, no component leases, no
signed authority manifest. Where the v1 spec routed a result through the ledger,
v2 routes it through **a gate result plus an audit-table span row** (§5 of the
design doc). `[RECOVERED]`

---

## 2. The team

`plugins/option-wizard/team.yaml`. Roles declare `requires: [capability]` from
the closed tag set in design §3 — never a model, never a vendor. Directory
shape follows `plugins/fake-tenant/` (`tenant.yaml`, `team.yaml`,
`tools/index.ts` exporting `VOCABULARY` + `buildTools(cfg)`). `[VERIFIED —
/Users/chenxi/projects/helium/.worktrees/v2-m0-m1/plugins/fake-tenant/]`

| # | Step | Kind | `requires` | Tools | Budget (tok / USD) | Hands to next |
|---|------|------|-----------|-------|--------------------|---------------|
| 0 | `universe-builder` | **deterministic** | — | `ow_tv_watchlist`, `ow_argon_watchlist`, `ow_ib_positions` | 0 / $0 | Ticker set (union, deduped, ~100+) |
| 1 | `universe-screener` | **deterministic — not an agent** | — | none (pure compute over step 0 rows) | 0 / $0 | Ranked shortlist (≤15) + rejection reasons |
| 2 | `regime-analyst` | agent | `reason.deep`, `tool.use` | `ow_macro_rates`, `ow_uw_market_state` | 60k / $0.30 | One regime verdict: direction bias, vol stance, hedge posture |
| 3 | `structure-designer` | agent | `reason.deep`, `tool.use`, `structured.output` | `ow_uw_ticker_metrics`, `ow_ib_chain`, `ow_ib_quote` | 180k / $0.90 | ≤8 concrete defined-risk **proposals** (legs, qty, limit) |
| 4 | `risk-reviewer` | agent | `reason.deep`, `long.context` | `ow_ib_positions` (read-only) | 90k / $0.45 | Kept proposals (≤5) + the **risk list** with reasons |
| 5 | `preflight` | **deterministic gate** (design §3 `Gate`) | — | `ow_ib_preflight` | 0 / $0 | Per-proposal gate record + pass/fail |
| 6 | `render+deliver` | **deterministic** | — | `plugins/delivery-email` channel | 0 / $0 | The email |

**Why each exists** — one line, and any step that only reformats is deleted:

| Step | Justification |
|------|---------------|
| `universe-builder` | Three sources with three shapes; merging them is IO, not judgement. |
| `universe-screener` | Deterministic and **explicitly not an agent** `[RECOVERED]` — ranking 100+ tickers by numeric fields is reproducible arithmetic; an LLM here costs tokens and adds variance for nothing. |
| `regime-analyst` | Consumes the rates/inflation data the deleted `macro-watch` job used to fetch. `macro-watch` is deleted and **must not be resurrected** — it produced nothing daily. `[RECOVERED]` Its data now has a consumer, which is the whole difference. |
| `structure-designer` | Turning "ticker + IV/skew/GEX state + regime" into a specific defined-risk structure is the one genuinely generative judgement in the pipeline. |
| `risk-reviewer` | Adversarial second pass by a *different* role; it produces the risk list, which is an output in its own right, not a restatement. |
| `preflight` | Gates must be reproducible; an agent recomputing them would defeat the point. |
| **Deleted role: `email-composer`** | It would only reformat step 4's output. The email is a deterministic template over the accepted proposals + gate records. Doctrine 6. |

Step 5 runs as a design-§3 `Gate` (`phase: "output"`, `appliesTo:
[structure-designer, risk-reviewer]`), so a proposal that cannot pass costs a
gate span rather than another model call.

---

## 3. Tools

All read-only except the one gate-record write. `tools/index.ts` exports
`VOCABULARY` (each entry `{ mutating: false }`) and `buildTools(cfg)` where
`cfg = { stateRoot, env }`. Env var **names** only — no values anywhere in the
repo. `[VERIFIED — fake-tenant/tools/index.ts]`

| Tool | Signature | R/O | External system | Env var names |
|------|-----------|-----|-----------------|---------------|
| `ow_tv_watchlist` | `({ flagColors?: string[] }) → { source, tickers[], asOf }` | yes | TradingView.app via opencli, CDP to the local app | `OW_TV_ENABLED`, `OPENCLI_BIN` |
| `ow_argon_watchlist` | `({ sector?, chain?, setup?, freshWithinMinutes? }) → WatchlistResponse` | yes | argon `GET /api/watchlist` | `OW_ARGON_API_BASE` |
| `ow_ib_positions` | `() → { positions[], netLiq, buyingPower, asOf }` | yes | IB Gateway TCP 4001 | `OW_IB_HOST`, `OW_IB_PORT`, `OW_IB_CLIENT_ID` |
| `ow_ib_chain` | `({ ticker, minDte, maxDte }) → { expiries[], strikes[] }` | yes | IB Gateway 4001 | same as above |
| `ow_ib_quote` | `({ conIds[] }) → { bid, ask, mid, oi, greeks }[]` | yes | IB Gateway 4001 | same as above |
| `ow_uw_ticker_metrics` | `({ tickers[] }) → { ivRank, ivTermStructure, gexLevels, skew, maxPain }[]` | yes | Unusual Whales REST | `OW_UW_API_KEY` |
| `ow_uw_market_state` | `() → { marketTide, sectorTide, etfTide }` | yes | Unusual Whales REST | `OW_UW_API_KEY` |
| `ow_macro_rates` | `() → { centralBankRates, yieldCurve, asOf }` | yes | Unusual Whales REST (`central_bank_rates`, `yield_curve`) | `OW_UW_API_KEY` |
| `ow_ib_preflight` | see §4 | **writes one gate record** | IB Gateway 4001 (fetches its own inputs) | IB + `OW_GATE_DIR` |

`ow_argon_watchlist` returns argon's real shape, not an invented one
`[VERIFIED — /Users/chenxi/projects/argon/src/uw_scan/api/routers/watchlist.py:107-186`
and `/Users/chenxi/projects/argon/src/uw_scan/api/models/watchlist.py:58-90]`:

```
WatchlistResponse {
  scanned_at_min, scanned_at_max, scheduler_lag_seconds,
  queue: { total, queued, running, oldest_requested_at },
  hot_count, hot_max,
  tickers: WatchlistCard[]
}
WatchlistCard {
  ticker, sector, chains[], pinned, hot, sort_rank,
  spot, spot_quoted_at, spot_source, scanned_at,
  iv_atm, iv_rank, market_cap, aum,
  setup:       { type, direction, score },
  aggression_pct,
  returns:     { d1, w1, d30 },
  gamma:       { flip_distance, flip_price, per_1pct_move, max_strike,
                 expiring_pct, expiring_date },
  skew:        { rr25d_30dte },
  positioning: { call_oi, put_oi, pcr_oi, pcr_vol, pcr_delta_30d },
  queue:       { job_id, status, queue_position, requested_at, started_at } | null
}
```

Query params `sector`, `chain`, `setup`, `fresh_within_minutes` are real and
typed as shown. `scanned_at` is null for a watchlist ticker with no card row
yet; the screener must tolerate that. `[VERIFIED — same file, lines 118-170]`

Because argon already carries `iv_rank`, `gamma.*`, `skew.rr25d_30dte` and
`positioning.*` per card, `ow_uw_ticker_metrics` is scoped to what argon does
**not** serve — IV term structure and max pain — so the tenant does not pay UW
twice for the same numbers. `[INFERRED]`

**Screener inputs** are exactly the numeric fields above plus IB position state;
its rank is a documented deterministic function, versioned in `extensions:`.
Output is **top-5 opportunities + a risk list**. `[RECOVERED]`

**Tenant-owned config** lives under one opaque `extensions:` key in
`tenant.yaml` that the host never reads into; existing capability tags are used
unchanged, no new tag is minted for this tenant. `[RECOVERED]`

---

## 4. `ow_ib_preflight`

**Proposal-only arguments.** The tool takes the proposal and nothing else; it
fetches its own market and account inputs, so a proposal cannot smuggle in a
stale or flattering quote. `[RECOVERED]`

```ts
type Proposal = {
  ticker: string;
  strategy: string;                 // e.g. "put-credit-spread"
  legs: Array<{ right: "C" | "P"; expiry: string;  // YYYY-MM-DD
                strike: number; action: "BUY" | "SELL"; ratio: number }>;
  quantity: number;
  limitPrice: number;               // net debit(+) / credit(-)
  rationale: string;
};
ow_ib_preflight(p: Proposal) → { contentHash, gates, pass, recordPath }
```

### The five gates `[INFERRED — named by me from the desk's defined-risk options doctrine; confirm against intent]`

| # | Gate id | True when |
|---|---------|-----------|
| 1 | `defined_risk` | Max loss is finite and computable from the legs alone: every short leg is covered by a long leg of the same right/expiry or by held stock. **No naked short calls, no margin-leveraged short puts.** Violation is fatal, never a warning. |
| 2 | `buying_power` | IB-reported margin impact ≤ the configured fraction of net liq, and post-trade buying power stays above the floor. Inputs fetched live from IB Gateway 4001. |
| 3 | `liquidity` | Every leg quotes at 4001: bid > 0, bid/ask spread ≤ the configured fraction of mid, open interest ≥ floor, and the `limitPrice` is inside the current NBBO band. |
| 4 | `event_window` | Expiry is a real listed expiry, DTE is inside `[minDte, maxDte]`, and no earnings or ex-dividend date falls inside the holding window unless the proposal declares the event as the thesis. |
| 5 | `position_conflict` | The proposal does not duplicate or directly oppose an open position, and per-underlying plus portfolio concentration caps still hold after it. |

`pass` is true only when **all five** are true.

### Record shape — `${OW_GATE_DIR}/gates/<contentHash>.json`

One record per proposal. `contentHash` = sha256 over the canonical JSON of the
`proposal` object (sorted keys, no whitespace); it is the filename, so an
identical proposal is idempotent and a mutated one lands elsewhere.

```jsonc
{
  "schemaVersion": 1,
  "contentHash": "<sha256 hex of canonical(proposal)>",
  "proposal": { /* verbatim, canonicalized */ },
  "gates": {
    "defined_risk":      { "pass": true,  "detail": "max loss = width - credit" },
    "buying_power":      { "pass": true,  "detail": "..." },
    "liquidity":         { "pass": false, "detail": "spread 14% of mid > 8% limit" },
    "event_window":      { "pass": true,  "detail": "..." },
    "position_conflict": { "pass": true,  "detail": "..." }
  },
  "pass": false,
  "inputs": { "ibHost": "…", "quotesAsOf": "<ISO8601>", "accountAsOf": "<ISO8601>" },
  "computedAt": "<ISO8601>",
  "runId": "<dsh SessionId>"
}
```

No market values are invented anywhere in this document; the `detail` strings
above are shape examples with symbolic numbers.

### `validate(recordPath, proposal)`

1. Read the record; reject on unknown `schemaVersion`.
2. Recompute `sha256(canonical(proposal))`.
3. Require it to equal both the record's `contentHash` **and** the filename stem.
4. Deep-equal `record.proposal` against the passed `proposal`.
5. Require all five `gates[*].pass === true` and `record.pass === true`.
6. Any failure ⇒ the proposal is dropped from the email's candidate list and
   moved to the risk list with the failing gate named.

The renderer calls `validate()` for every candidate immediately before
composing; a proposal reaching the email without a valid record is impossible by
construction. **Divergence from design §7.1**, which listed the content hash as
"dropped": the hash is kept because it is what makes the gate record self-
verifying without a ledger. The *ledger* is dropped; the hash costs one
`sha256` and is the cheapest tamper-evidence available. `[RECOVERED + INFERRED]`

---

## 5. Sandbox and blast radius

Sandbox kind **`none`** (design §4): no filesystem write capability, mutating
tools dropped at `tools/pre-execute`. `[VERIFIED — design doc §4 table names
`none` for option-wizard]`

| Forbidden | Because |
|-----------|---------|
| Placing, staging or amending any order | No tool with order-placement semantics is ever registered — the constraint is structural, not a prompt. IB access is the read-only side of Gateway 4001 only. |
| Writing `~/market-warehouse/` | Design §4 deny-list, checked after the allow-list in `packages/core/src/guard.ts`. |
| Writing anything in `~/projects/*` | Sandbox `none` has empty `writeRoots`. |
| Truncating `~/.config/helium/helium.env` | The file is **appended to, never truncated** — other tenants' keys live there. `[RECOVERED]` |
| Running `uv sync` | Helium deploy never runs `uv sync` in option-wizard; `uv 0.11.8` is on the plist PATH and is invoked with `--no-sync`. `[RECOVERED]` |

The two writes option-wizard *is* permitted: its own gate records under
`OW_GATE_DIR` (a run-scoped path added to `writeRoots` as the single exception),
and the outbound email via `plugins/delivery-email`, gated by
`delivery.enabled` in `tenant.yaml` **and** the operator env brake.

**Deployment facts (Mac mini)** `[RECOVERED]`: TradingView.app is installed;
**opencli is not** — it needs the app running locally over CDP. Therefore
`ow_tv_watchlist` is **optional at runtime** and its absence is a degraded run,
not a failure (§7).

---

## 6. Token budget and daily cost envelope `[INFERRED]`

Per-role caps are declared in `team.yaml`; the run cap is `budget: { usd, tokens }`
in `tenant.yaml` (design §5). Arithmetic, one weekday run:

| Role | Steps | Tokens (cap) | USD (cap) |
|------|------:|-------------:|----------:|
| `regime-analyst` | ~4 | 60,000 | 0.30 |
| `structure-designer` | ~12 | 180,000 | 0.90 |
| `risk-reviewer` | ~6 | 90,000 | 0.45 |
| deterministic steps 0,1,5,6 | — | 0 | 0.00 |
| tool-output summarisation (`cheap.bulk`, design §5) | — | 40,000 | 0.05 |
| **Run total** | ~22 | **370,000** | **1.70** |

Declared run budget: `{ usd: 2.00, tokens: 400000 }` — headroom of $0.30 over
the sum, matching the design doc's own example. Envelope: 21 trading days ⇒
**≤ $42/month** worst case, and lower in practice because the caps are ceilings.
Real cost is read back from the audit table, not estimated:
`SELECT role, SUM(cost_usd) FROM span WHERE run_id = ? GROUP BY role`.

---

## 7. Failure modes — the email always sends

Delivery is unconditional. A run that produces zero candidates still sends a
report saying so; silence is indistinguishable from a dead cron, which is the
failure mode that killed `macro-watch`.

| Failure | Behaviour | Email says |
|---------|-----------|-----------|
| **No IB connection** (4001 refused/timeout) | Steps 3–5 cannot quote or gate. Screener + regime still run. | Subject `[DEGRADED]`. "IB Gateway unreachable at `<host:port>` — no candidates were preflighted." Lists the screener shortlist as **unpriced watch items**, explicitly labelled not-tradeable. |
| **TradingView not running / opencli absent** | Universe = argon ∪ positions only. Run continues. | A one-line note: "TradingView flag lists unavailable; universe built from argon + open positions (N tickers)." |
| **Empty watchlist** (argon returns `tickers: []`, or the union is empty) | Screener output empty; agent steps skipped, no spend. | Subject `[NO UNIVERSE]`, plus argon's `scanned_at_max` and `queue` counters so the reader can tell "argon is behind" from "argon is empty". |
| **Role exceeds budget** | Run fails `budget_exhausted` for that role (design §5 — never silent truncation). Downstream roles are skipped; upstream output survives. | Names the role, its cap, and what was produced before the stop. Any candidate already fully preflighted is still listed. |
| **A gate fails** | Normal operation, not an error. Proposal moves to the risk list. | Candidate table shrinks; risk list names the proposal and the failing gate with its `detail`. |
| **All five candidates fail gates** | Zero candidates. | "0 candidates passed preflight" + the full risk list. This is a legitimate, useful daily output. |
| **Delivery channel fails** | Retry, then write the rendered report to the run's `outputs/` and record the failure as a span. | (n/a — surfaced at the next run and in the audit table.) |

---

## 8. Open questions

1. **Universe cap.** 100+ tickers × per-ticker UW metrics is the dominant tool
   cost. Does the screener cut to ≤15 *before* any UW call, or does it need
   UW-only fields to rank? `[INFERRED]` — assume it ranks on argon fields alone.
2. **Screener rank function.** The exact formula was in the lost spec. Currently
   unspecified beyond "deterministic, versioned in `extensions:`".
3. **Email recipient(s) and send window.** Cron time and timezone unrecovered;
   argon's own scanners run on ET evening schedules.
4. **Gate thresholds.** Spread %, OI floor, DTE band, concentration caps and the
   buying-power fraction are all unrecovered numbers.
5. **xenon Query API.** Design §7.1 lists it among option-wizard's read-only
   sources; this spec routes account state through IB Gateway 4001 directly.
   One of the two is redundant — decide before M2.
6. **`OW_GATE_DIR` under sandbox `none`.** A kind with literally zero write
   roots cannot write gate records; either `none` gains a single declared
   exception path or option-wizard uses `scratch` with a deny-everything-else
   policy. This is the one place the design doc and this spec do not compose.

## 9. What was lost

Not recoverable from the original spec, and reconstructed or left open here:

- The exact role list and role names beyond `universe-screener` and
  `regime-analyst`; `structure-designer` and `risk-reviewer` are my names.
- The five gate names and definitions (§4) — inferred from desk doctrine.
- All numeric thresholds: screener weights, gate limits, budget caps, N=5 is
  the only recovered number.
- The cron schedule, timezone, and email recipients.
- Whether the original spec had a claims-ledger path at all, and if so what it
  gated — v2 drops it either way.
- The `extensions:` block's actual keys.
- The prompt/persona text for each role.

`[RULES I BROKE]`: none. Every unverified item above is tagged `[INFERRED]` or
listed in §8/§9 rather than asserted.
