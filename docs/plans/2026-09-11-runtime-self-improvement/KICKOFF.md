# Runtime self-improvement kickoff — v1.2

Read PLAN.md (especially §0 and §11), REVISION-v1.2.md, verification/checks.json and the config schema. Read the primary checkout AGENTS.md and preserve unrelated work. Baseline e2175344525e355edc5662124712a7250a3d9b88 is a reviewed source identity, not production proof. This document is an implementation entry, not authorization to start implementation in a document-editing session.

## First deliverable: M1 local mechanism

Use one worker with no background claims, takeover, automatic retry or external delivery. Reuse the runner, extensions, news builder and evidence recorder. Do not scaffold a generic distributed control platform.

1. P0: record HEAD/dirty state, actual entrypoints/build and relevant baseline checks. Missing production access blocks only production checks.
2. P1: wire only option-wizard/premarket news.perStock in {1,2,3}, default 2. Keep global/stocks, fetch depth, ranking, prompts, model, renderer and other phases unchanged. Never mutate module-global defaults.
3. P2: temporary PostgreSQL with the smallest version/snapshot/attempt/test-pointer storage. Validate current roles, strict input parsing, scope, canonical identity, idempotency and test-only manual initialization/switch/rollback. Reuse installed drivers; new dependencies/services require the applicable approval. No event projections, automated grants or complete actor matrix yet.
4. P3: persist snapshot before tools are built. Replay raw frozen feed, preserve errors and costs, prove actual context treatment and phase isolation. Freeze the current run; pointer changes affect the next run. Isolate all eval state and disable delivery.
5. Record UNKNOWN requests and do not release their budget or retry blindly. A new execution may not overlap a surviving process. Manually reconcile before resuming. If automatic recovery/takeover is required, implement and verify fencing first.

M1 acceptance includes default compatibility, real treatment when a third row exists, expected no treatment when it does not, two run-local configs without global pollution, DB failure refusal, persisted failure evidence, next-run activation and rollback. Use deterministic fixtures with provenance or explicit synthetic labels; no quality or production claim.

## Then M2, separately authorized real evaluation

Complete §11.1 and the pilot template before confirmation. Null calibration, sample, threshold or budget fields mean DRAFT_NOT_EXECUTABLE. Use development A/A, a frozen 2-versus-3 candidate, independent confirmation data, paired analysis, predeclared treatment slices and all-attempt cost accounting. No invented third row or cherry-picked successful retry. Bind outputs and evidence versions; recheck validity manually before any adoption. Output REJECT, NO_CHANGE, INCONCLUSIVE or REVIEW_READY. No automatic activation.

## M3 is a later capability

Shadow/product acceptance, qualified evaluation, explicit activation authorization, monitoring and rollback precede AUTO_SCOPED. Implement event acknowledgments only before an event consumer exists; fencing before automatic takeover; receipt invalidation races before automatic promotion; external delivery rules before registry-driven delivery. These requirements are deferred, not waived. P8/P9/C are extensions, not prerequisites for the parameter pilot.

## Verification and delivery

checks.json preserves every original requirement. deliveryWave/applicability define staged acceptance; old requiredFor is historical. A combined check remains NOT_RUN until fully exercised; record M1 sub-scope results separately. Run the narrow relevant checks, preserve failed runs, and report commands/exit codes/evidence. Package scripts prove only documentation/specification consistency. No implementation tests or real costs may be inferred from them.

No production migration, formal email, market-data writes, orders, merge or deployment follows from this plan. Follow current-session authorization for implementation and Git delivery. Finish M1 before expanding the controller; a rejected candidate is an acceptable M2 outcome.
