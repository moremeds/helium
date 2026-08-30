# Helium offline evaluations

The default evaluation is replay-only and makes no network calls. The frozen
macro cases pair one Codex single-agent control with one Codex multi-agent
treatment using the same input fingerprint, tools, budget, target and catalog
snapshot. A quota, timeout, cancellation or mismatch excludes both arms and
queues the case for rescheduling.

The Phase 3 primary metric is unsupported-claim rate. The provisional gate is
`n >= 30`, at least 20 percent relative reduction, and `p < 0.05` on a
two-sided Wilcoxon signed-rank test. Human preference and other provider runs
are descriptive secondaries only.

Run after building the workspace:

```sh
pnpm --filter @helium/evals run evaluate -- --fixtures evals/fixtures/macro
pnpm --filter @helium/evals run fixture-hash -- --fixtures evals/fixtures/macro
```

Live execution is never implicit. It requires both `--live` and
`HELIUM_EVAL_LIVE=1`, plus injected provider adapters. Live run directories
belong under the ignored `evals/runs/` path; only reviewed summaries may be
committed.
