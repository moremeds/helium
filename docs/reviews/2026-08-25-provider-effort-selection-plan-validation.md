# Provider Effort Selection Plan Validation

- Plan name: Provider Effort Selection Implementation Plan
- Date: 2026-08-25
- Repository: `moremeds/helium`
- Validator scope: architecture fit, current code touchpoints, dependencies,
  tests, security, evaluation, and delivery safety

## 1) Context Snapshot

The plan adds Claude model-effort variants at the provider edge while keeping
core work orders and teams model-blind. It depends on the already approved P0
hardening and Phase 1 provider-neutral contracts before touching the live
execution path.

Reviewed areas include the current v1 job schema, DSH triage dispatch, Claude
subscription child process, Claude unit fixtures, workspace test gates, and the
existing multi-agent implementation sequence. Production deployment and live
quality ranking were not validated because both remain explicitly deferred.

## 2) Executive Verdict

- Overall status: `ready-with-fixes`
- Rationale: the revised plan fits the intended plugin boundary and has exact
  test paths, but execution must wait for its named P0, Phase 1, and evaluation
  prerequisites.
- Top blockers:
  1. Current core still contains the v1 model-specific job contract.
  2. Current Claude runner still uses approval-oriented tool flags and has no
     model-effort invocation contract.
  3. `@helium/evals`, the capability catalog, router, and executor registry do
     not exist yet.

## 3) Plan Coverage Matrix

| Item ID | Plan Item Summary | Status | Severity | Evidence | Key Gap | Suggested Fix |
|---|---|---|---|---|---|---|
| P1 | Protect model-blind schemas | valid | low | `packages/core/src/job.ts:50`, `docs/plans/2026-08-25-helium-multi-agent-implementation.md:472` | The new core schema is a prerequisite, not current code | Run only after Phase 1 Task 7; keep this as a regression guard |
| P2 | Add provider-edge effort schema | valid | low | `plugins/helium/package.json:1`, `vitest.config.ts:10` | No provider catalog exists today | Create it only in the plugin package and cover it through existing unit discovery |
| P3 | Register Claude model-effort matrix | valid | medium | `plugins/helium/src/claude.ts:52`, `plugins/helium/src/claude.test.ts:36` | Account-effective organization caps are not in the current API surface | Use a versioned certification snapshot and fail closed on unknown variants |
| P4 | Invoke exact Claude model and effort | partial | high | `plugins/helium/src/claude.ts:61`, `plugins/helium/src/claude.ts:63` | Current runner lacks model/effort and still uses `--allowedTools` | Preserve the P0 restriction fix and add `--model`/`--effort` only afterward |
| P5 | Register certified opaque variants | valid | medium | `docs/plans/2026-08-25-helium-multi-agent-implementation.md:552`, `docs/plans/2026-08-25-helium-multi-agent-implementation.md:735` | IDs could drift across restart if generated randomly | Derive stable opaque IDs from versioned provider-native keys |
| P6 | Add exact-target override | valid | medium | `docs/plans/2026-08-25-helium-multi-agent-design.md:294` | A schema alone would not prove lease-time policy enforcement | Add a plugin routing composition service and re-check original constraints |
| P7 | Evaluate effort variants | partial | medium | `docs/plans/2026-08-25-helium-multi-agent-implementation.md:1392` | `@helium/evals` is not present | Defer until Phase 3 Task 20; do not create a parallel harness |
| P8 | Run integration and live certification gates | valid | medium | `package.json:9`, `plugins/helium/src/claude.ts:22` | Live certification can affect cost and observe silent effort clamps | Keep it opt-in, temporary, post-AC#1, and capture plain-text cap warnings before JSON runs |

## 4) Findings By Severity

### F-1

- Severity: high
- Impact: implementing effort now would extend an execution boundary that is
  not yet certified for real tool isolation and would couple the new design to
  v1 provider-specific core fields.
- Evidence: `packages/core/src/job.ts:54`, `plugins/helium/src/claude.ts:57`,
  `plugins/helium/src/claude.ts:63`
- Why current plan is insufficient: without an explicit prerequisite, Task 4
  could land before P0 and Phase 1.
- Recommended correction: the plan now blocks Tasks 1-6 on P0 and Phase 1
  Tasks 6-10.

### F-2

- Severity: medium
- Impact: a random opaque target ID would break deterministic replay and make
  catalog evidence drift across restart.
- Evidence: the future core contract requires opaque IDs at
  `docs/plans/2026-08-25-helium-multi-agent-implementation.md:596`; current v1
  dispatch already uses per-run UUIDs for sessions at
  `plugins/helium/src/dispatch.ts:135`, which must not be copied for target
  identity.
- Why current plan is insufficient: the first draft asserted only an opaque
  shape.
- Recommended correction: the revised plan derives stable `target-<hash>` IDs
  from a provider namespace and versioned native target key and tests restart
  and registration-order stability.

### F-3

- Severity: medium
- Impact: Claude Code JSON output may not report an organization-clamped effort,
  so audit could incorrectly label requested effort as provider-applied effort.
- Evidence: current parsing preserves only the terminal result envelope at
  `plugins/helium/src/claude.ts:108` and exposes raw data at
  `plugins/helium/src/claude.ts:136`.
- Why current plan is insufficient: the first draft did not distinguish
  requested, effective, and provider-reported effort.
- Recommended correction: separate all three fields, use a minimal plain-text
  certification preflight for clamp warnings, and leave unreported values
  absent.

### F-4

- Severity: medium
- Impact: building effort evaluations before the approved evaluation harness
  would duplicate infrastructure and create incomparable scores.
- Evidence: `@helium/evals` is created only by the future Task 20 at
  `docs/plans/2026-08-25-helium-multi-agent-implementation.md:1392`.
- Why current plan is insufficient: the first draft did not name Task 20 as a
  dependency.
- Recommended correction: Task 7 now waits for Task 20.

## 5) Improvement Points

| Priority | Improvement Point | Expected Benefit | Effort |
|---|---|---|---|
| P0 | Gate implementation on P0 and Phase 1 Tasks 6-10 | Prevents security regression and core coupling | S |
| P0 | Use stable opaque target IDs | Makes routing evidence and replay durable | S |
| P0 | Separate requested, effective, and provider-reported effort | Prevents false audit claims | S |
| P1 | Cap provider catalog size and effort-option count | Bounds malformed plugin expansion | S |
| P1 | Delay effort evaluation until Task 20 | Preserves one score system | S |
| P1 | Add lease-time override constraint checks | Prevents admin pinning from bypassing safety | M |

## 6) Suggested Revised Plan

| Step | Objective | Files/Modules | Dependencies | Exit Criteria |
|---|---|---|---|---|
| 1 | Lock model-blind schemas | core and neutrality tests | Phase 1 Task 7 | Core/team reject provider, model, effort |
| 2 | Validate native effort catalogs | plugin provider catalog | Step 1 | Invalid defaults, duplicates, and orchestration values reject |
| 3 | Add Claude catalog and cap snapshot | Claude provider catalog | Step 2 | Haiku none; Sonnet/Opus certified subsets |
| 4 | Invoke exact model and effort | Claude runner | P0, Step 3 | CLI arguments and full model usage are tested |
| 5 | Register stable certified targets | executor registry and Claude executor | Phase 1 Tasks 8-10, Step 4 | Only measured opaque variants reach routing |
| 6 | Add bounded exact override | plugin routing service | Step 5 | Override cannot bypass work constraints |
| 7 | Score variants offline first | `@helium/evals` | Phase 3 Task 20 | Per-target scorecards are deterministic |
| 8 | Certify and record | review evidence and full gates | AC#1 complete, Steps 1-7 | Green CI, safe live evidence, no deployment |

## 7) Test And Validation Plan

| Step | Required Tests | Existing Tests To Update | New Tests To Add | Command |
|---|---|---|---|---|
| 1 | strict schema and neutrality | `packages/core/tests/work.spec.ts` | none | `pnpm exec vitest run --project unit packages/core/tests/work.spec.ts` |
| 2 | provider schema unit tests | none | `plugins/helium/src/provider-catalog.test.ts` | `pnpm exec vitest run --project unit plugins/helium/src/provider-catalog.test.ts` |
| 3 | Claude matrix and cap tests | none | Claude catalog test | `pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-catalog.test.ts` |
| 4 | CLI args, failure, usage audit | `plugins/helium/src/claude.test.ts` | none | `pnpm exec vitest run --project unit plugins/helium/src/claude.test.ts` |
| 5 | stable IDs and atomic registration | executor registry test | Claude executor test | `pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-executor.test.ts` |
| 6 | authorization, expiry, constraint re-check | none | override and routing-service tests | `pnpm exec vitest run --project unit plugins/helium/src/exact-target-override.test.ts plugins/helium/src/routing-service.test.ts` |
| 7 | frozen per-variant scoring | eval scorer test | Claude effort fixtures | `pnpm --filter @helium/evals run evaluate -- --fixtures evals/fixtures/provider-effort/claude` |
| 8 | build, type, unit, contracts, E2E, eval | all relevant | live certification review | `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm test:e2e-local` |

The final gate also requires `git diff --check`, a clean worktree, green pull
request checks, and a before/after Mac mini production-health comparison for
the post-AC#1 live certification only.

## 8) Open Questions

No product decision remains open. Programmatic discovery of Claude organization
effort caps is intentionally not assumed; the plan uses explicit certification
evidence and fail-closed routing until a supported discovery surface exists.

## 9) Confidence And Assumptions

- Confidence level: high for architecture and file touchpoints; medium for
  future Claude cap reporting behavior.
- Assumptions: the approved Phase 1 core contracts retain the named file paths
  and the Claude CLI continues to accept `--model` and `--effort`.
- Checks to increase confidence: re-read the actual post-Phase-1 interfaces
  before executing Task 2, inspect the installed Claude CLI help during live
  certification, and validate the effective account effort subset without
  relying on provider defaults.
