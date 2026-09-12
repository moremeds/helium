# M2 paired analysis — offline comparison command

2026-09-12. Task 1 of the runtime-m2-analysis split. This adds the tenant-owned
paired analysis that consumes a frozen registration plus independently bound
manual measurements and produces the plan's ordered decision. It is mechanism
work only: every test input is synthetic, no real A/A or confirmation data was
consumed, and nothing here claims a measured quality improvement, calibration,
or authorization.

## Files

- `plugins/option-wizard/eval/runtime-comparison.ts` — `analyzeComparison(input)`,
  pure analysis over parsed bytes + caller-computed SHA-256 values.
- `scripts/runtime-comparison.mjs` — CLI wrapper; hashes, preserves and copies
  original bytes.
- `plugins/option-wizard/tests/runtime-comparison.spec.ts` — 11 synthetic
  mechanism checks (vitest unit project).
- `scripts/runtime-comparison.test.mjs` — end-to-end command check
  (`node --test`, requires `pnpm build` first).

## Command contract

```sh
node scripts/runtime-comparison.mjs registration.json <trials-dir> <refs-dir>|- <new-output-dir>
```

- `<trials-dir>` holds one subdirectory per trial. Recognized files:
  `trial.json` (required manifest), `snapshot.json`, `result.json` or
  `failure.json`, `events.json`, `review.json`, `measurement.json`,
  `final.txt`, `claims.json`.
- `<refs-dir>` holds byte-identified evidence artifacts matched to registered
  hashes; `-` supplies none (confirmation then stays INCONCLUSIVE).
- `<new-output-dir>` must not exist; the command refuses to overwrite. It
  receives verbatim copies (`registration.json`, `inputs/<trial>/…`,
  `refs/…`), plus `comparison.json` and `provenance.json` (command, engine sha,
  every input/output hash). Exit 0 means the analysis completed and was
  persisted; the decision value is data, not a status code.

## Input contracts

- **Registration** (`runtime-comparison-registration-v1`, `status:
  "REGISTERED"`): the frozen form of `pilot-experiment.template.json` plus
  `comparisonMode` (`AA_DIAGNOSTIC` | `CONFIRMATION_2V3`), a
  `confirmationCohort.cases[]` list of `{caseId, clusterId,
  eventManifestHash}`, `evaluation.manualReview` (`requiredReviewerIdentity`,
  `requiredRubricHash`), and `evaluation.intervalImplementation` =
  `{method:"paired-cluster-bootstrap-v1", seed, replicates}`. All statistical
  parameters (seed, replicates, alpha, minimumPracticalEffect,
  independentClusterCount, replicatesPerCase, noninferiority margins, resource
  limits, rationales) must be supplied; there are no defaults. Slices must
  partition the cohort exactly.
- **trial.json** (`runtime-comparison-trial-v1`): `{trialId, caseId, arm:
  "champion"|"candidate", replicate, configVersionId, configHash, model:
  {requestedId, reportedId}, snapshotSha256, outcomeFile, outcomeSha256,
  claimsEvidenceSha256|null, attempts[]}` where each attempt is `{attemptId,
  status: SUCCEEDED|FAILED|UNKNOWN, requests, tokens, latencyMs, costUsd,
  usageUnknown}`.
- **snapshot.json**: the actual `RuntimeSnapshot` from the runtime-control
  path. Its `effectiveSnapshotHash` and `configHash` self-integrity are
  recomputed; `metadata.inputWorldHash`, `engineSha`, `engineArtifactHash`,
  `deliveryMode: "disabled"`, `executionEnvironment: "evaluation"` and scope
  must equal the registered values. For `CONFIRMATION_2V3`, the two arms'
  `resolvedPayload`s must be identical outside `changedPaths`.
- **events.json / review.json / measurement.json / final.txt**: the same
  shapes the `runtime-coverage.mjs` diagnostic consumes and emits. The
  measurement is recomputed from review+events and must equal the supplied
  file; review bytes must hash to `measurement.reviewHash`; the article must
  hash to `finalArtifactHash`; span and source refs are re-resolved; the
  reviewer must be the registered `manualReview`.
- **claims.json** (`runtime-comparison-claims-v1`): the independent reviewer's
  `{reviewer, reviewed, supported}` record, bound via
  `trial.json.claimsEvidenceSha256`. Inline self-reported counts are not
  accepted.

## Decision semantics

Ordered per plan §11.1: `INVALID` (malformed registration, duplicate/extra/
unregistered trials, inconsistent cohort/slices) → `NOT_COMPARABLE` (any
byte-binding failure: snapshot, outcome, event manifest, review, article,
claims, config identity, engine, input world, scope) → `REJECT` (verified
critical errors over the registered maximum, declared noninferiority or
resource-limit violations on available evidence) → `INCONCLUSIVE` (missing or
unresolved measurements, fewer than the registered paired clusters, unknown
usage or model-route incompatibility, unadjudicated critical disagreement,
missing/unbound confirmation evidence references) → `NO_CHANGE` (interval
lower bound below `minimumPracticalEffect`; also the cap for A/A diagnostics)
→ `REVIEW_READY` only when every declared requirement holds and every
reference resolves to a supplied, hash-matched artifact.

Aggregation is replicates-within-case (mean), case paired difference, then
equal-weight cluster differences with the seeded percentile bootstrap. A
failed legitimate generation scores 0 and counts as a reliability failure;
missing or unresolved evidence is unknown, never zero or tie. All-attempt
requests/tokens/latency/cost are preserved per arm including UNKNOWN.

## Checks run

- `pnpm build` — clean.
- `pnpm vitest run --project unit plugins/option-wizard/tests/runtime-comparison.spec.ts` — 11/11.
- `node --test scripts/runtime-comparison.test.mjs scripts/runtime-coverage.test.mjs` — 2/2.
- `pnpm test` (full unit suite) — 1339 passed, 5 skipped, no regressions.

## Explicit limits

- The bootstrap is a fixed registered implementation, not a calibrated or
  scientifically qualified procedure; A/A output is diagnostic and cannot
  authorize confirmation or activation.
- Proof references are byte-bound and identity-checked only; semantic truth of
  reviews, evaluator qualification and holdout lineage remains a manual
  responsibility recorded in `comparison.json.assumptions`.
- Real inputs, real A/A and the actual confirmation campaign remain
  lead-controlled; no inference, provider call, or production side effect
  occurred.
