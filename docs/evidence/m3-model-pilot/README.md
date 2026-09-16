# First assisted M3 research cycle

Status: model-priced development pilot completed; candidate rejected. No deploy,
orders, executable-fill claim, sealed OOS result, or framework superiority claim.

## Fixed experiment

SPX with the existing WINNER entry signal and flat-vol pricing. Hypothetical
initial capital $1,000,000; use realized-equity compounding consistently so capital
does not silently stay fixed after losses. Baseline risk 20%, size-down reference
5%, candidate 10%, no overlay. These are risk-sizing settings, not observed
account holdings. Rates, configuration, selected candidate and cost scenarios are
recorded before simulation. Round-trip costs per spread contract are hypothetical
$0/$2/$5, with $2 preselected as primary; existing commission/slippage defaults are
replaced consistently, not charged twice. All scenarios use the same frozen source.

Only settlement P&L is available in this adapter. Drawdown is positive
`max((running_peak - realized_equity) / running_peak)`, with initial capital
included in the peak. Annual return is geometric net settlement return, with no
cash yield added. These are NOT mark-to-market account drawdowns. Costs are
scenario assumptions, not NBBO-calibrated execution estimates.

The historical corpus was already exposed. Everything here is development data;
any reported chronological 60/40 boundary has no confirmation status. A 15% bound
is only a research constraint on this realized-only metric. Original full-account
risk/confirmation target remains unverified.

## Observed primary scenario

| Arm | Annual modeled net return | Realized-only max drawdown | Trades |
| --- | ---: | ---: | ---: |
| Baseline 20% | 64.07% | 82.14% | 518 |
| Candidate 10% | 35.24% | 47.25% | 521 |
| Size-down reference 5% | 17.21% | 24.78% | 510 |

All arms: first entry 2007-04-20, last settlement 2026-05-19. The candidate improves
on baseline under the registered constraint-first utility, but is worse than the
5% reference under that utility. This is not Pareto dominance: the reference also
has lower modeled return. Final decision rejects the candidate, leaves baseline
unchanged and records the better drawdown reference. No arm meets the research
15% bound. $0/$5 sensitivity scenarios have the same decision direction.

The reference is one fixed sizing control, not a fitted risk-matched frontier.
This pilot does not demonstrate an improved entry signal or new source of alpha.

## What the framework actually executed

`run-argon-m3-pilot.mjs` writes registration and execution intent, invokes the
Argon adapter, checks source/protocol/trade/equity hashes and path drawdown,
evaluates candidate versus both references with M3 utility, then persists the
selected config and retain/reject event. The fixed nine simulator evaluations
exhaust the declared evaluation budget; this is not convergence success.

`versusBaselineDecision` is the candidate-vs-baseline intermediate decision. Top-level
`retained` and `selected` include the size-down-reference guard and are the final
research action. Neither causes a git rollback or production configuration change.

Resource records measure the deterministic execution/evaluation only. Runtime
model calls/tokens are zero. The agents used to develop this adapter have unmeasured
cost/tokens; these are null, never reported as free. No paired old/new framework
trial exists, so framework superiority is NOT_RUN.

## Reproduce

Build this Helium worktree and use an Argon checkout containing
`scripts/research/vrp/m3_pilot.py`:

```
pnpm --filter dsh-plugin-tenant-helium-self build
node scripts/research/run-argon-m3-pilot.mjs ARGON_WORKTREE NEW_OUTPUT_DIR SNAPSHOT_JSON
```

Omit SNAPSHOT_JSON to load the local read-only database. A snapshot replay needs no
market network access. Outputs are exclusive, so prior runs cannot be overwritten.
Keep `registration.json`, `events.jsonl`, `result.json`, and the `research/` subtree.
The diagnostic artifacts are private local research output, not checked-in market data.

## Next decision

The assisted loop works and has rejected an insufficient proposal. The next
strategy hypothesis must explain improvement beyond simple risk reduction. Before
claiming framework improvement, repeat a comparable task with a fixed alternative
framework version and measured whole-task resources. Missing NBBO remains an
execution-realism limitation; it does not invalidate this model-only workflow test.

Partial improvement above the bound may be retained for development if it beats
both references. That is distinct from meeting the target, which this pilot always
leaves UNVERIFIED. Engine/evaluator hashes are bound before and after execution.

## Verification

The final bridge replay completed nine scenarios in approximately 1.26 seconds of
measured subprocess/evaluation time (not agent development time). All scenario
results, trade hashes and equity hashes reproduced the prior frozen-snapshot run
exactly. The source snapshot SHA256 is
`71d32a9eed88ca1cdf6149623464989a534d2e284e6b3138ec3f25477cd912cb`.
Argon binds HEAD and 19 relevant source/lockfile hashes before and after simulation;
Helium also checks engine/evaluator stability. Costs and initial-equity peak logic
have a focused offline regression; Python lint passed.

```
node scripts/research/check-m3-pilot.mjs OUTPUT_DIR PRIOR_OUTPUT_DIR
```

Independent review checked cost math and development evidence limits. Engine
binding was added in response. Partial improvement above 15% remains permitted
only as a development proposal, in accordance with the approved utility; no
confirmation or live-promotion path exists in this pilot.
