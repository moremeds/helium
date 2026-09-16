# M3 utility v1 — constrained research decisions

This milestone implements a utility comparator, single-comparison retention, and
pure stopping rules. It does not implement an autonomous optimizer or establish
strategy improvement. The existing retention API's `retained` means keeping a
proposal in development, never deploying it or passing final confirmation.

## Two linked records

Strategy: campaign ID, parent/candidate revision, input-world hash, evaluator and
split versions, exposure/selection history, net return, positive peak-relative
max drawdown, activity and size-down comparator. Invalid/missing observations are
ineligible, never assigned zero loss. For the VRP campaign the upper bound is
0.15 with a minimum valid metric value of 0; objectives are higher net annual return then lower drawdown. Below-target
candidates beat above-target candidates. When both violate the constraint, smaller
violation wins first. Epsilon applies to objective improvements, not feasibility.

Framework: task ID + strategy campaign ID, framework revision, route/model,
resources and limits, interventions, invalid attempts, human corrections and the
candidate selected using development data. Evaluate that selected candidate on
confirmation data once. With comparable strategy results, prefer fewer human
corrections, lower measured cost, then lower time. Do not count candidate volume
or test count as reward; missing USD is unknown, not zero.

The strategy control is the original strategy with reduced sizing, selected on
development data. A validated improvement must beat this control at comparable
risk, with costs and uncertainty accounted for. This version does NOT automate
control matching, statistical confidence, split isolation, or verification of
operator-declared metadata. Those are prerequisites for a confirmation runner.

## Stop semantics

- Target verified: explicit confirmation from a trusted evaluator, never inferred
  from low drawdown or retention alone.
- Budget exhausted: measured calls/time reach a frozen limit; this is not success.
- Stalled: K eligible completed comparisons show no epsilon-significant improvement;
  invalid results never count as successful comparisons or plateau observations.
- Continue otherwise. K, epsilon and budgets must be frozen before search.

Do not sort a whole population with an epsilon comparator: near-ties need not be
transitive. Compare each proposal to the current incumbent in frozen trial order.
The caller owns the complete history. The supplied CLI evaluates one strategy comparison (and optionally a pair of framework trials),
forces confirmation unverified, and is not a campaign scheduler.

## Build and execute

```
pnpm --filter dsh-plugin-tenant-helium-self build
pnpm vitest run --project unit plugins/helium-self/tests/campaign.spec.ts plugins/helium-self/tests/utility.spec.ts
node --test scripts/research/evaluate-m3-campaign.test.mjs
node scripts/research/evaluate-m3-campaign.mjs packet.json NEW_OUTPUT_DIR
```

The CLI persists exact input bytes and their SHA256 alongside its result. Supply
`contract` (including utilityPolicy), `base`, `candidate`, `phase`, `stopPolicy`
and `resources`. Optional `frameworkTrials: { base, candidate }` uses the
`FrameworkTrial` fields in `evolution/framework.ts`; mismatched task, campaign,
input world, evaluator, selection rule, model route or budgets is incomparable.
Unknown cost blocks cost/time tie-breaking; over-budget trials are ineligible.
All metadata is operator-normalized, not independent evidence.
Output directory must be new. Library exceptions are validation failures.

## Real Argon evidence and correction

The previously recorded 28-row capital sweep covers SPY/QQQ/IWM, not a fixed SPX
candidate/base pair. `account_metrics` computes monthly cumulative dollar-P&L
peak loss divided by initial capital. Its signed `maxdd_pct` is not the positive
peak-relative net equity drawdown required here. `ann_return_gross` adds a cash
risk-free assumption; it is not evidence of after-cost annual return.

Consequently the reported 38.9% cannot establish failure or success of the 15%
OOS target. The old README's FAILED_TARGET claim is superseded by INCONCLUSIVE.
Keep original artifacts; do not relabel exploratory runs as preregistered tests.
Local evidence `tmp/m3-utility-v1` copies the source CSV and binds its hash, records
missing information, and exercises the ineligible path with the actual evaluator.
No market prices or new backtest outcomes are fabricated.

## Next research milestone

Freeze a correctly valued account baseline, executable sizing control, input
snapshot and development/confirmation split. Then run a single strategy proposal
through M3 and persist both strategy utility and framework resource/decision
records. Previously viewed data is development evidence. The actual strategy
search epsilon and plateau K remain undecided until baseline uncertainty is known.

## Verification and review (2026-09-16)

- Tenant build passed with evolution included in TypeScript output.
- Campaign/utility/framework unit suites: 15 tests passed.
- CLI persisted-input/output and overwrite-refusal integration test: passed.
- Real 28-row legacy CSV SHA256:
  `ed4144e5b6a1acc7b7d2089e855637b80beb5f55895717af2c907e70e24da386`.
  Import v2 returned strategy `ineligible`, target `UNVERIFIED`, framework
  `incomparable` (no paired framework trials). This is an evidence-admission
  result, not a new backtest or an independently verified holdout conclusion.
- Independent peer found missing framework comparison and unchanged-revision
  acceptance; both fixed. Added minimum-valid-value guard for signed metrics.
  Lead retained lexicographic human-correction priority: unknown lower-priority
  cost cannot erase a decisive correction reduction, but prevents cost/time
  tie-breaking when corrections are equal. Both cases have regression checks.
- No strategy return improvement or general framework efficiency is claimed.
