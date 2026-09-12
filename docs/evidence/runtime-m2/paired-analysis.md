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
- `plugins/option-wizard/tests/runtime-comparison.spec.ts` — 17 synthetic
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
  `final.txt`, `claims.json`, `usage.json`. A file that exists but fails
  strict parsing is still hashed and copied into `inputs/` — malformed
  evidence is never dropped — and counts the trial not comparable.
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
  eventManifestHash, inputWorldHash}` (each case binds its own input world;
  `replay.inputCorpusHash` must equal the hash of the ordered case/world
  manifest), `evaluation.manualReview` (`requiredReviewerIdentity`,
  `requiredRubricHash`), and `evaluation.intervalImplementation` =
  `{method:"paired-cluster-bootstrap-v1", seed, replicates}`. All statistical
  parameters (seed, replicates, alpha, minimumPracticalEffect,
  independentClusterCount, replicatesPerCase, noninferiority margins, resource
  limits, rationales) must be supplied; there are no defaults. Slices must
  partition the cohort exactly. `decisionFamilyId` and `holdoutCohortId` are
  identifiers, not hashes; their associated evidence is bound separately.
  `resourcePolicy.measured` explicitly registers which dimensions
  (`requests|tokens|latencyMs|costUsd`) are actually measured; a limit may
  only target a measured dimension, unmeasured dimensions must stay
  unmeasured (never fabricated), and confirmation requires finite
  `perTrialCallLimit`, `timeoutSeconds` and `totalCallLimit` with `requests`
  and `latencyMs` measured. Ledger/calendar/world-completeness references are
  byte-bound artifacts when confirmation depends on them.
- **trial.json** (`runtime-comparison-trial-v1`): `{trialId, caseId, arm:
  "champion"|"candidate", replicate, configVersionId, configHash, model:
  {requestedId, reportedId}, snapshotSha256, outcomeFile, outcomeSha256,
  claimsEvidenceSha256|null, usageEvidenceSha256|null, observedThirdRow,
  attempts[]}` where each attempt is `{attemptId,
  status: SUCCEEDED|FAILED|UNKNOWN, requests, tokens, latencyMs, costUsd,
  usageUnknown}`. `observedThirdRow` records the treatment exposure actually
  observed; for confirmation a missing value is inconclusive evidence and a
  contradicting value is not comparable. `model.reportedId` and `attempts[]`
  are self-declared: they verify nothing by themselves.
- **usage.json** (`runtime-comparison-usage-v1`): an operator-normalized
  `{attempts[]}` session record bound via `trial.json.usageEvidenceSha256`
  and required to reproduce the manifest attempts exactly. It is
  operator-side session evidence, not independent provider-side billing
  proof. Only bound usage verifies a registered resource limit; unbound
  usage keeps resource conclusions unverified and the comparison
  inconclusive.
- **snapshot metadata**: `actualModelIdentity` is the only bound source for
  the actual route and has the exact shape runtime-evaluate writes
  (`packages/cli/src/cli.ts`): the `"NONE_TOOL_ONLY"` sentinel or
  `{grade, provider, requestedModel, policyHash, captureManifestHash,
  limits}`. The bound `grade` must equal the registered
  `actualModelIdentityPlan.acceptedGrade` (ROUTE_ONLY is permitted when
  preregistered; PINNED is never required universally), `requestedModel`
  must equal the manifest's declared requested model, `provider` must equal
  the registered `providerId` when one is declared, and `policyHash` must
  hash the recorded `limits`. A manifest `reportedId` that contradicts the
  bound route is not comparable; a missing/sentinel bound identity leaves
  the route unknown and the result inconclusive.
- **outcome agreement**: `result.json` must carry a recognized `outcome`
  string consistent with the review state in both directions — a completed
  review cannot accompany a failed outcome and vice versa; `failure.json`
  cannot accompany a completed review.
- **snapshot.json**: the actual `RuntimeSnapshot` from the runtime-control
  path. Its `effectiveSnapshotHash` and `configHash` self-integrity are
  recomputed; `metadata.inputWorldHash` must equal the world registered for
  that trial's own case, `engineSha`, `engineArtifactHash`,
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
requests/tokens/latency/cost are preserved per arm including UNKNOWN;
dimensions absent from `resourcePolicy.measured` are reported as unmeasured
rather than zero. In A/A mode the estimate and interval are reported relative
to zero as a diagnostic only: random sampling produces nonzero estimates, so
a nonzero interval is not evidence of bias by itself.

## Corrections (lead review of e62572d)

Applied on top of `e62572d`, no amend/reset:

- Per-case `inputWorldHash` is now bound per case; the aggregate corpus hash
  covers the ordered case/world manifest, so distinct multi-date worlds are
  supported and reordering or a wrong-world trial fails binding.
- Confirmation now requires supplied, hash-matched artifacts for the world
  completeness receipt, ledger snapshot, calendar snapshot, treatment
  exposure record and the previously listed evaluator/lineage/rubric
  references; anything missing stays INCONCLUSIVE.
- `decisionFamilyId` and `holdoutCohortId` are treated as identifiers
  (required, never hash-checked); only real artifact references are
  byte-bound.
- `resourcePolicy.measured` is the registered measured basis: limits may
  only target measured dimensions, unmeasured USD is reported as unmeasured
  rather than fabricated, tokens are retained and reported without a hard
  output-token cap, and confirmation requires finite enforceable
  calls/time limits.
- `trial.json.observedThirdRow` records actual treatment exposure; missing
  exposure is INCONCLUSIVE, contradictory exposure is NOT_COMPARABLE.
- A/A output reports estimate and interval relative to zero as a diagnostic;
  it no longer asserts that a nonzero interval proves bias.

Second correction round (CLI follow-up):

- `readJson` keeps the raw buffer on parse failure (`bytes` retained,
  `value: null`, error recorded), so malformed input bytes survive into the
  copied `inputs/` and provenance.
- Reference and registration bytes are read once; the persisted copy and the
  reported hash always come from the same buffer.
- `result.json` now requires a recognized outcome agreeing with the review
  state in both directions; `outcome: "failed"` plus a completed review is
  not comparable.
- `model.reportedId` and manifest `attempts[]` are self-declared only: the
  actual route is bound from the real `snapshot.metadata.actualModelIdentity`
  object (`{grade, provider, requestedModel, policyHash, captureManifestHash,
  limits}`) with the accepted grade preregistered, and attempt usage verifies
  a registered limit only when a bound `usage.json` reproduces it.
  Unverifiable routes/usage stay INCONCLUSIVE; nothing invents provider
  identity or hidden usage. `usage.json` is documented as an
  operator-normalized session artifact, not independent provider proof.

## Checks run

- `pnpm build` — clean.
- `pnpm vitest run --project unit plugins/option-wizard/tests/runtime-comparison.spec.ts` — 17/17.
- `node --test scripts/runtime-comparison.test.mjs` — 1/1.
- `pnpm test` (full unit suite) — 1343 passed, 5 skipped, no regressions.

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
