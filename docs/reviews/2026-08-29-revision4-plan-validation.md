# Revision 4 Plan Validation

- **Plan name:** Helium P4 Takeover Revision 4 and P5/P6 extraction
- **Date:** 2026-08-29
- **Repository:** `/Users/chenxi/projects/helium`
- **Validator scope:** Revision 4 changes to the existing master, design,
  multi-agent, Ops, and provider-effort plans; new post-P4 P5/P6 plan. Unchanged
  Revision 2/3 task bodies were rechecked only where Revision 4 depends on them.

## 1) Context Snapshot

Revision 4 authorizes the existing gated execution path through P4, makes
DeepSeek/Codex/Claude provider plugins and their submodels explicit, defines
quota exhaustion as durable availability state, anchors P3 quality evaluation
on Codex control/treatment pairs, and extracts P5/P6 into a future plan.

Repository areas reviewed: core work/capability/router/execution contracts,
executor registry and Claude boundary, fake providers and conformance contracts,
Ops plugin/reducer/executor, package/workspace topology, current tests, the
`feat/ops-phase-c` handover and commits, and all revised plan sections.

Live entitlement certification and production deployment were not run. AC#1
forbids any presence change on the mini through 2026-08-31, and Claude is
currently quota-exhausted.

## 2) Executive Verdict

- **Overall status:** `ready-with-fixes`
- **Rationale:** The plan is sequenced and testable, and Revision 4 now names
  the exact corrections required by merged P1. Provider execution must not open
  until the three high-risk P1 corrections below land through Provider Effort
  Tasks 2-6.
- **Top blockers before provider execution:** core currently parses
  `retryAfter`; the selector currently collapses temporary unavailability into
  `capability-shortage`; and no independently installable production provider
  packages exist yet.

These blockers do not stop the docs PR or completion of Ops Phase C/D, whose
deterministic path is provider-independent.

## 3) Plan Coverage Matrix

| Item ID | Plan Item Summary | Status | Severity | Evidence | Key Gap | Suggested Fix |
|---|---|---|---|---|---|---|
| R4-1 | Preserve existing plan/task IDs and authorize through P4 | valid | low | `docs/plans/2026-08-25-helium-multi-agent-master-plan.md:16`, `docs/plans/2026-08-25-helium-multi-agent-master-plan.md:1312` | None | Continue from Ops Task 10; do not create a second P0-P4 plan |
| R4-2 | Record current merge and Phase C branch truth | valid | low | `docs/plans/2026-08-25-helium-multi-agent-master-plan.md:29`; commits `f12bf52`, `153793e`, `ebfb8c7` | Phase C is local and incomplete | Finish collector and Tasks 11/12/13a, then run its PR gate |
| R4-3 | Three independently installable provider plugins | partial | high | Only `plugins/helium/package.json` and `plugins/ops-agent/package.json` exist; provider package work is specified in `docs/plans/2026-08-25-provider-effort-selection-implementation.md` Task 3 | Current repository has no production provider plugin packages | Build `provider-sdk` plus three separate plugins; prove remove/add with no core or host diff |
| R4-4 | Provider-owned shared quota domains and refresh | partial | high | `packages/core/src/capabilities.ts:133-170` currently interprets reset time; Task 5 now owns its removal | Core currently owns provider-clock behavior | Remove core time parsing; provider plugin publishes a new availability snapshot |
| R4-5 | Durable capacity wait and truthful shortage | partial | high | `packages/core/src/router.ts:154-180` currently returns only `capability-shortage`; `packages/core/src/work.ts:24-35` already has provider-neutral `unavailable` | Temporary capacity and static shortage are conflated | Provider Effort Task 6 returns `unavailable`; MA Task 15 persists `waiting-for-capacity` |
| R4-6 | Class-honest executor conformance | valid | medium | `packages/core/src/execution.ts:58-96`, `contracts/tests/executor-conformance.contract.spec.ts:13-22` | Old plan wording claimed a child-process suite could grade in-process | Revision 4 pins in-process to floor plus DSH behavior tests; full suite remains mandatory for process/sandboxed |
| R4-7 | Codex same-anchor paired P3 evaluation | valid | medium | `docs/plans/2026-08-25-helium-multi-agent-master-plan.md:971-994`, `packages/core/src/work.ts:47-64` | Exact eligible Codex target is not known until preflight | Freeze target/catalog/input/tool/budget snapshots before the first run; invalidate both arms on quota interruption |
| R4-8 | P4 fallback and quota smoke | valid | medium | `docs/plans/2026-08-25-helium-multi-agent-master-plan.md:1024-1070`, `plugins/ops-agent/src/index.ts:1-12` | Live Claude cannot participate now | Use Codex single-agent Macro fallback; keep deterministic Ops/watchdog/operator path; fake quota matrix supplies failure evidence |
| R4-9 | Extract P5/P6 behind a post-P4 opening gate | valid | low | `docs/plans/2026-08-29-helium-p5-p6-long-term-plan.md:1` | P6 data sufficiency is unknowable before P4/P5 trajectories | Keep future status; require P5 activation and separate P6 data-readiness reviews |

## 4) Findings By Severity

### F-1

- **Severity:** high
- **Impact:** Core can restore an exhausted provider merely because a
  provider-supplied string parses as an elapsed timestamp, bypassing provider
  preflight and shared quota-domain state.
- **Evidence:** `packages/core/src/capabilities.ts:145-170`
- **Why current plan was insufficient:** Earlier text said core should treat
  `retryAfter` as opaque but the merged implementation parses it.
- **Recommended correction:** Provider Effort Task 5 now removes clock-based
  auto-readmission. Core retains the hint for audit only; a provider-owned event
  publishes recovery.

### F-2

- **Severity:** high
- **Impact:** An all-provider outage is currently indistinguishable from a
  permanent capability gap, so the controller cannot enter a truthful durable
  capacity wait.
- **Evidence:** `packages/core/src/router.ts:171-180`
- **Why current plan was insufficient:** P1's decision type exposed only
  `capability-shortage`.
- **Recommended correction:** Provider Effort Task 6 adds provider-neutral
  `unavailable` when static requirements are satisfiable but current
  availability is not; MA Task 15 maps it to durable
  `waiting-for-capacity` and deduplicated resume.

### F-3

- **Severity:** high
- **Impact:** Putting three provider implementations inside `plugins/helium`
  would make the master plan's install/remove proof impossible and retain a
  hidden provider-coupled host.
- **Evidence:** current plugin packages are only `plugins/helium/package.json`
  and `plugins/ops-agent/package.json`; no `plugins/provider-*` package exists.
- **Why current plan was insufficient:** Earlier Task 16 and provider-effort
  paths described in-tree executor modules while claiming package pluggability.
- **Recommended correction:** Provider Effort Tasks 2-5 now create
  `@helium/provider-sdk` plus separate DeepSeek, Codex, and Claude workspace
  plugins; Task 7 proves independent remove/add with an empty core/host diff.

### F-4

- **Severity:** medium
- **Impact:** Requiring an in-process executor to emit a spawned-child boundary
  report would produce a false failure; pretending it passed would produce
  false isolation evidence.
- **Evidence:** `packages/core/src/execution.ts:58-87`,
  `contracts/tests/executor-conformance.contract.spec.ts:13-22`
- **Why current plan was insufficient:** Older plan wording said one suite,
  every class, no exceptions.
- **Recommended correction:** Keep `conformanceAtFloor()` for in-process plus
  DSH inheritance/tool/cancel/drain tests; require the full shared suite for
  process/sandboxed executors.

### F-5

- **Severity:** medium
- **Impact:** Hardcoding remembered model/effort lists could publish unavailable
  or unentitled targets and invalidate the P3 anchor.
- **Evidence:** `jobs/macro-watch.yaml:44` records only the current v1 DeepSeek
  model; no production Codex provider catalog exists.
- **Why current plan was insufficient:** The original provider-effort plan used
  a Claude seed table as if it were current entitlement.
- **Recommended correction:** Provider-owned preflight snapshots are
  authoritative. Live-test Codex and DeepSeek where permitted; keep Claude
  unavailable until its own preflight passes.

## 5) Improvement Points

| Priority | Improvement Point | Expected Benefit | Effort |
|---|---|---|---|
| P0 | Land provider packages rather than in-tree provider modules | Makes pluggability and independent rollback falsifiable | L |
| P0 | Remove core reset-time parsing and distinguish temporary availability | Prevents false recovery and permanent-capability misclassification | M |
| P0 | Persist attempt linkage and exactly-one capacity resume | Prevents duplicate work, charge, and busy loops | M |
| P1 | Freeze Codex anchor, tools, inputs, and total budget per pair | Makes the P3 quality claim interpretable | M |
| P1 | Keep live certification separate from fake quota smoke | Avoids consuming subscription quota to test control logic | S |
| P2 | Revalidate P5/P6 paths only after P4 evidence | Prevents a future plan from hardening stale repository assumptions | S |

## 6) Suggested Revised Plan

This sequence is already incorporated into the existing plans; it is not a new
P0-P4 task system.

| Step | Objective | Files/Modules | Dependencies | Exit Criteria |
|---|---|---|---|---|
| 1 | Merge Revision 4 docs | Seven revised/added plan files plus this review | Current green `origin/master` | Docs consistency checks and PR CI pass |
| 2 | Complete Ops Phase C | Existing Ops Tasks 10, 11, 12, 13a | Merged P0/P1 and Ops A/B | Phase C gate and merging-tree evidence pass |
| 3 | Complete Ops Phase D | Existing Ops Tasks 14, 16, 17, 18 | Phase C | No-provider and fake all-quota-outage gates pass; no mini presence during AC#1 |
| 4 | Correct provider edge and add three plugins | Provider Effort Tasks 1-6 | Merged MA Tasks 1-10b | Separate packages, opaque catalogs, no core time parsing, truthful `unavailable`, fake quota matrix |
| 5 | Certify available providers | Provider Effort Task 7 | Step 4 and allowed host/window | Codex/DeepSeek snapshots recorded; Claude skipped until green preflight |
| 6 | Build durable team kernel and provider host | MA Tasks 12-16 | Steps 2-5 | Replay, capacity wait, class-appropriate conformance, no orphan child/lease |
| 7 | Run Codex-anchored Macro shadow evaluation | MA Tasks 17-20 | Step 6 | Frozen paired gate passes; invalid quota pairs excluded/rescheduled |
| 8 | Enforce Ops team admission | Ops Tasks 13b/15 | MA Tasks 18/19 | Deterministic path unchanged with all providers unavailable |
| 9 | Promote through P4 | Existing Macro and Ops promotion ladders | Every prior evidence manifest accepted | Bounded canaries, fallback drills, quota smoke, rollback proof |
| 10 | Consider P5/P6 | Separate long-term plan | Accepted P4 | Separate activation review authorizes work |

## 7) Test And Validation Plan

| Step | Required Tests | Existing Tests To Update | New Tests To Add | Command |
|---|---|---|---|---|
| 2 | Ops probe/collector/component unit, topology contract, full gate | Phase C probe and topology tests | Collector and adapter suites | `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm test:e2e-local` |
| 3 | No-provider Ops continuity and adversarial recovery | Ops controller/action contracts | All-provider fake quota outage | `HELIUM_TEST_NO_PROVIDERS=1 pnpm test` plus Phase D gate |
| 4 | Catalog, package lifecycle, router, availability, exact override | `packages/core/tests/capabilities.spec.ts`, `packages/core/tests/router.spec.ts` | Three provider catalog/executor tests and quota-domain matrix | Provider Effort Tasks 2-6 focused commands plus full gate |
| 5 | Entitlement and exact invocation smoke | Existing Claude fake boundary | Codex and DeepSeek preflight snapshots | Provider Task 7; explicit opt-in only |
| 6 | Reducer/store/recovery/host contracts | Executor registry and conformance contracts | Durable capacity wait/resume crash matrix | MA Phase 2 gate |
| 7 | Offline scorer, autonomy, paired statistics | None yet | Quota-invalid pair and anchor-mismatch cases | MA Phase 3 gate |
| 8 | Admission and no-provider Ops behavior | Ops admission tests | Provider-capacity status deduplication | Ops Phase E gate |
| 9 | Canary, fallback, rollback, liveness | Existing release/dead-man tests | P4 fake quota smoke and bounded live evidence | P4 promotion commands recorded before execution |

Every coding step also runs `git diff --check`; every phase runs build,
typecheck, unit, contracts, and local E2E before PR merge. Live gaps remain
`PARTIAL` or `BLOCKED`, never inferred from fixture success.

## 8) Open Questions

| Question | Why It Matters | Needed From |
|---|---|---|
| Which Codex and DeepSeek submodel/effort targets does current preflight certify? | Determines provider snapshots and the exact P3 anchor | Provider preflight evidence |
| Does Claude preflight become available after the expected Monday reset? | Determines whether Claude enters secondary P3 evidence; it does not block primary Codex testing | Provider preflight evidence |
| Are provisional P-1/P-2 thresholds ratified before P3? | The paired gate cannot run with unapproved statistical thresholds | Operator before first shadow result |
| Is AC#1 close evidence accepted after 2026-08-31? | Controls when any mini presence or live-host certification is legal | Operations evidence review |

## 9) Confidence And Assumptions

- **Confidence:** high for repository architecture, merged P1 behavior, current
  Ops boundaries, and plan consistency; medium for future provider CLI details
  because live catalogs have not been preflighted.
- **Assumptions:** Codex and DeepSeek credentials are available on an allowed
  development host; Claude quota recovery remains unconfirmed; no mini action
  is authorized during AC#1.
- **Checks that increase confidence:** provider preflight snapshots, Phase C
  merging-tree CI, P-1/P-2 ratification, and post-AC#1 presence evidence.
