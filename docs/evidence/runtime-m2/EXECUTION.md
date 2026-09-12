# M2 development preflight — partial delivery

2026-09-12. Baseline: `f81cc4458c20a4b94b2a7e2bdb1785f41b813344` (M1).
This is **not M2 acceptance** and contains no measured report-quality improvement.
The v1.2 confirmation template remains `DRAFT_NOT_EXECUTABLE`; the original
105-check register is unchanged. No merge, deployment or activation was performed.

## Initial preflight: implemented and checked

| Claim | Evidence | Recheck |
| --- | --- | --- |
| A fresh local capture records internal sibling calls, not only the outer frame | `packages/cli/src/runtime-capture.ts`; three focused tests | `pnpm vitest run --project unit packages/cli/tests/runtime-capture.spec.ts` |
| Captured errors, including swallowed sibling errors and recording failures, remain incomplete; mutating tools are refused | Same test; environment explicitly disables delivery and mutations | Same command |
| Manual event accounting preserves the registered denominator and unknown judgments | `plugins/option-wizard/eval/runtime-coverage.ts`; six simulated-data tests | `pnpm vitest run --project unit plugins/option-wizard/tests/runtime-coverage.spec.ts` |
| The command binds a separate event manifest and actual final file; invalid line/source references and overwrite attempts fail | `scripts/runtime-coverage.test.mjs` | `pnpm build && node --test scripts/runtime-coverage.test.mjs` |

Build and workspace typecheck passed. Full unit suite: 1,311 passed, 5 skipped
(including the two opt-in M1 PostgreSQL cases, not rerun for this change).
The standalone command check passed. No dependencies, core schema, provider,
production team, prompts, ranking, or default runtime configuration were changed.

## Real development observation

The two inspected historical local development runs (2026-09-02 and 2026-09-04)
have raw tool recordings but no `ow_tv_news` records. Neither supplies the frozen
source world required for this parameter comparison. No sealed confirmation
content was opened.

One new read-only source acquisition ran from 07:07:39.395 to 07:08:24.398 UTC:
44 recorded calls, including 12 news queries, zero recording failures and three
source failures. The missing `OW_ARGON_API_BASE` affected two watchlist calls and
one macro-release call. It returned `INCOMPLETE`, not usable confirmation data.
Raw evidence remains private in a separate local research directory, outside
the production state and data lake.

Two offline frame reconstructions used that same recorded input hash
`e83b7e70fb859fdfd804087805f1ebe48914b4e70537e3869428d3c4210b4d76`.
All five stock rows contained two news items at cap 2 and three at cap 3;
news/frame hashes differed and neither reconstruction requested an unrecorded
occurrence. This verifies real-data **frame treatment only**, with known source
failures. It is not model-context exposure, A/A, A/B article quality, or a valid
confirmation result. Model calls: zero. The acquisition preceded the final
explicit mutation-environment override and manifest-hash additions; their
verification is the subsequent automated check, not this live acquisition.

## Use

After building, with the operator's existing read-only source configuration:

```sh
node packages/cli/lib/cli.js runtime-capture option-wizard --tool ow_session_frame --phase premarket
```

It prints the new private directory and counts. `capture-start.json` is written
before calls; `inputs/` retains raw responses/errors; `capture.json` records the
acquisition window, input hash and diagnostic-only eligibility. `COMPLETE` means
the acquisition calls and writes completed, **not** source freshness, historical
point-in-time fidelity, cohort eligibility or scientific comparability. Local
ledger and prior reports start empty. Capture does not implement an experiment
identity or independently verify source vintages; do not promote its output to
a confirmation corpus without those checks.

For an independently written manual review:

```sh
node scripts/runtime-coverage.mjs events.json review.json final.txt new-measurement.json
```

`events.json` is the separate preregistered array of `{id,evidenceRefs}` objects.
The review has `completed`, `finalArtifactHash`, `reviewer:{identity,rubricHash}`,
and `reviews:[{eventId,verdict,finalSpanRefs,sourceRefs,criticalErrors,adjudication}]`.
Hashes are SHA-256. Verdicts are `addressed`, `not-addressed`, or `unknown`;
adjudication is `resolved` or `unknown`. References use nonempty article line
ranges such as `final:2-4`; source refs must belong to that event's registered
evidence refs. An addressed row needs a final span and cannot carry critical
errors. The command validates reference membership/resolution, not semantic truth
or the underlying source artifact bytes. The output is always
`MANUAL_REVIEW_DIAGNOSTIC`, never an adoption receipt.

For failed generation use `-` instead of a final file, null artifact/reviewer,
and no reviews. A nonempty event denominator scores zero; an empty denominator
or unresolved semantic judgment never receives a fabricated full score.

## Remaining M2 work after the follow-up

- Confirm an inference route and bounded real-call budget; no calls are yet authorized by a concrete budget in this execution.
- Resolve the two Apex source failures, acquire complete eligible development inputs and independently label event obligations.
- Exercise the implemented single-trial inference composition on real inputs; pair scheduling, evaluator calibration and preregistered statistical analysis remain unimplemented.
- Run real A/A; use its evidence to freeze quality/resource/sample rules and the single 2-versus-3 candidate.
- Acquire an independent, unexposed confirmation cohort; complete evaluator calibration, blinded review and fixed paired analysis.
- Return the evidence-bounded M2 decision for manual review. No automatic activation.

Two requested Terra/medium workers investigated and implemented disjoint capture
and measurement files; the lead integrated commands and verification. A separate
read-only pass found the mutation-environment and reference-binding gaps, which
were addressed. Native tool replies confirmed task dispatch, not the effective
serving model. Remaining provenance/qualification gaps stay explicitly diagnostic.


## Follow-up: Argon routing and controlled inference

The existing replay wrapper now exposes `capture <phase> <entry-tool>` and uses
its established operator/Argon environment loading. Explicit `OW_ARGON_API_BASE`
still takes precedence. Its standalone simulated wrapper check passed.

A second read-only capture ran from 12:15:11.899 to 12:16:16.682 UTC on September
12. Both Argon surfaces succeeded through a temporary local forward to the
existing service; the forward was then stopped. All 90 calls were recorded,
with zero recording failures and two source failures: QCOM and MRVL Apex bars
returned HTTP 503. Input hash:
`13662a20786f2701b2f6ef0a064190f0790f39bded6a7c825348435a61f88718`.
One read-only retry per failed request returned the same 503; the service
reported missing Silver daily artifacts for both symbols. No fallback or source
repair was applied. The private raw capture is durably retained. It remains `INCOMPLETE` and
`DIAGNOSTIC_ONLY`; no failed input was silently removed or substituted.

`runtime-evaluate` composes the existing runtime pilot with one explicitly
pinned provider. It requires a COMPLETE capture bound to the tenant, phase,
clock and exact input hash, plus an explicit model and limits file. The Codex
subscription adapter is opt-in; ordinary runs retain their provider behavior.
The original `runtime-pilot` command remains model-free. Delivery stays disabled
and evaluation uses the restricted test database role and fresh local state.

```sh
node packages/cli/lib/cli.js runtime-evaluate option-wizard \
  --connection runner.json --input capture/inputs --capture capture/capture.json \
  --as-of '<capture replayAsOf>' --phase premarket \
  --provider codex-subscription --model '<existing model id>' --policy limits.json
```

The limits file requires positive integer `maxRequests`, `timeoutMs`,
`maxOutputTokens`, and `maxRequestBytes`; unknown fields are refused. These bound
reserved dispatch count, trial duration, requested output allowance per request,
and each serialized request body. A reserved slot is written before dispatch;
local persistence/deadline failures may conservatively retain that slot and UNKNOWN
even without a sent request. They do not establish a hard USD or total-token
budget. Model identity remains `ROUTE_ONLY`, with requested and reported model
identities retained separately.

Every actual request, including internal tool-loop continuations, receives a
private durable request record before dispatch and a raw response/usage record
afterward. Timeout, transport uncertainty, incomplete responses or missing usage
produce UNKNOWN accounting and stop continuation. UNKNOWN reaches the runtime
attempt table and blocks another attempt. Total cost remains null; legacy audit
cost is retained only as a separate diagnostic. No quality judgment is inferred.

The 38 focused provider checks passed, as did the workspace build and provider
typecheck. The opt-in PostgreSQL mechanism check passed with a simulated provider:
cap-2 frame exposure, exact-input mismatch rejection, actual Codex adapter with
mocked missing-usage response, UNKNOWN finalization and
blocked continuation were exercised alongside the prior M1 mechanism checks.
These are mechanism checks, not real-model A/A or quality evidence.

Normal tenant gates remain active during inference, with their decisions recorded
in the run report. `qualityEvaluated: false` means the independent M2 quality
measurement has not been completed. COMPLETE diagnostic inputs permit a development
trial only; this command does not qualify a confirmation corpus or adopt a result.

Quick independent review used Claude and Cursor/Grok plus the lead; Gemini was
unavailable due to licensing. The review caught failure-classification loss, a
host accounting fail-open and an adapter-to-database coverage gap; these were
fixed and checked. An unused package export was removed. The remaining scientific
acceptance items above are still open.

During the new integration check, a module mock failed to intercept the actual
transport. One request with synthetic fixture content and fake test credentials
reached the network and returned HTTP 403, with no model output. The test was
changed to the existing `HELIUM_CURL_BIN` seam and now runs a local response
stub, covering the actual adapter and transport parser without network access.
The failed attempt is retained separately; it is not a successful inference or
A/A observation.
