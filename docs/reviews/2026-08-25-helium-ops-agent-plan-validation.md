# Helium Ops Agent Plan Validation and Adversarial Review

- Plan name: Helium Ops Agent Design and Implementation Plan
- Date: 2026-08-25
- Repository: `moremeds/helium`
- Review type: second-pass plan validation plus adversarial review
- Production activity: read-only audit only; no recovery, restart, install, or
  deployment was performed

## 1. Context Snapshot

The review covers the revised multi-agent master plan, the standalone Ops Agent
design, all 18 implementation tasks, current Helium source and tests, current
Livewire/Argon/Apex repository operations guidance, official DeepSeek Harness
architecture, and the read-only Mac mini observations from 2026-08-25.

The first review found that the original master plan treated operations as a
late candidate team without defining an executable recovery contract. The
revised plan adds a domain-neutral operations safety substrate and treats Ops
as the second reference team.

The operator corrected one material attribution: Docker recovered after manual
intervention, not because the existing Colima watchdog eventually succeeded.
The revised fixture and acceptance criteria preserve that fact.

## 2. Executive Verdict

- **Plan artifact:** `ready-with-prerequisites`
- **Immediate production execution:** `not-ready`
- **Rationale:** the plan is technically coherent after the second-pass fixes,
  has exact tasks and gates, and preserves model blindness. Execution is
  intentionally blocked on the existing Phase 0/1/2 harness work, completion of
  AC#1, certification of actual deployed scripts, and separate staged promotion
  evidence.
- **Coverage:** 18 items reviewed; 11 valid, 7 partial because they depend on
  future interfaces or live certification, 0 invalid.
- **Critical pre-execution gates:**
  1. Close the existing senior isolation, delivery, mutation, and per-tenant
     health gaps before adding a mutating team.
  2. Land provider-neutral work/executor contracts and the durable team/event
     store before reusing them for operations.
  3. Complete AC#1 before installing `opsd` or performing any live drill.
  4. Reconcile each script/runbook with the actual deployment generation and
     certify exact preconditions and postconditions.
  5. Transfer recovery ownership from an existing watchdog before granting the
     corresponding Ops SOP automatic authority.

## 3. Plan Coverage Matrix

| Item | Plan item | Status | Severity | Evidence | Remaining gate |
|---|---|---|---|---|---|
| P1 | Freeze sanitized incident fixtures | valid | medium | Ops plan Task 1; corrected Colima attribution | Re-check redaction before merge |
| P2 | Generic component and observation contracts | valid | medium | Task 2; master-plan core neutrality rule | Requires future Phase 1 core layout |
| P3 | Dependency-aware incident correlation | valid | high | Task 3; Ops design incident plane | Tune graph and inhibition from observe-only evidence |
| P4 | SOP/action/authority contracts | valid | high | Task 4; design automatic arbitration | None at design level |
| P5 | Durable operation reducer/store | partial | high | Task 5; existing team-store prerequisite | Exact Phase 2 store API does not exist yet |
| P6 | Exclusive leases and recovery budgets | valid | critical | Task 6; OS-atomic lock plus SOP digest | Prove cross-process lock on the target filesystem |
| P7 | Certified exact-argv executor | partial | critical | Task 7; no-shell boundary | P0 sandbox and deployed script identity must exist |
| P8 | Postcondition verification and attribution | valid | critical | Task 8; production-derived Colima matrix | Controlled live drill still required |
| P9 | Open component/probe/SOP registry | valid | medium | Task 9; component IDs remain open-ended | Bound actual package counts after usage evidence |
| P10 | Host collector and resource probes | valid | high | Task 10; host-native `opsd` architecture | Seven-day baseline required for final thresholds |
| P11 | Livewire/Argon/Apex adapters | partial | high | Task 11; Livewire repair remains uncertified | Resolve parser drift and exact corruption repair path |
| P12 | Colima/PostgreSQL/Helium adapters | partial | high | Task 12; backup and controller observations | Resolve live PostgreSQL ownership and topology drift |
| P13 | Alert grouping and admission control | valid | high | Task 13; dependency inhibition and memory pressure | Measure noise and recovery hysteresis in observe mode |
| P14 | Standalone deterministic `opsd` | valid | critical | Task 14; process-boundary and no-provider tests | Package only after all prior phases pass |
| P15 | Capability-routed Ops team | partial | medium | Task 15; explicit Task 18 prerequisite | Shared team-manifest parser is future work |
| P16 | Existing-script inventory/certification | partial | critical | Task 16; first SOPs remain `approve` | Requires post-AC live version and maintenance evidence |
| P17 | Adversarial contract suite | valid | critical | Task 17; persisted fake host and executor | Add failures discovered during observe/suggest stages |
| P18 | Reversible observe-only packaging | partial | high | Task 18; independent dead-man check | No install until separate post-AC deployment approval |

## 4. Findings by Severity

### F-1: deterministic recovery was initially coupled to DSH

- **Severity:** critical
- **Impact:** a DSH or provider outage would stop the component intended to
  recover the ecosystem.
- **Evidence:** the original draft placed the controller in the Ops plugin while
  promising recovery without DSH.
- **Correction made:** the current design runs collection, policy, leases,
  execution, verification, and the authoritative log in host-native
  `helium-opsd`; DSH is an optional analysis client
  (`helium-ops-agent-design.md:38`, implementation Task 14).

### F-2: current and future restart controllers could race

- **Severity:** critical
- **Impact:** the existing Colima watchdog and `opsd` could both restart Colima,
  multiply disruption, and make attribution impossible.
- **Evidence:** existing watchdog behavior is part of the observed incident; the
  first draft preserved it while adding another executor.
- **Correction made:** observe/suggest stages preserve the old controller, but
  automatic promotion requires explicit mutation-ownership transfer and a
  single-controller rollback proof (`master-plan:369`, Ops design Stage 3).

### F-3: a command receipt could still be mistaken for recovery

- **Severity:** critical
- **Impact:** false green, false critical, or repeated mutation.
- **Evidence:** the Colima watchdog reported exhaustion before operator recovery;
  Livewire corruption cannot be repaired by a process restart.
- **Correction made:** action exit and postcondition verdict are separate;
  operator, automatic, and external recovery are separate terminal attributions.
  Task 8 carries the explicit decision matrix.

### F-4: JSONL replay alone is not a cross-process mutex

- **Severity:** critical
- **Impact:** two controller processes may both append an apparently valid
  intent before observing each other.
- **Correction made:** `opsd` is the sole log writer and every mutation also
  acquires an OS-atomic component lock containing boot, PID, lease, expiry, and
  SOP-digest evidence. Task 6 requires real child-process contention tests.

### F-5: automatic SOP arbitration was ambiguous

- **Severity:** high
- **Impact:** multiple matching SOPs could make an LLM the implicit safety
  authority or lead to unstable selection.
- **Correction made:** the plan pins the SOP digest and orders by priority,
  match specificity, and stable ID. Equal effective priority inside one
  exclusive group fails closed as `ambiguous`.

### F-6: same-user local access was too weak for approval

- **Severity:** high
- **Impact:** a same-UID process or another agent could submit a fake approval.
- **Correction made:** approval is an Ed25519-signed, incident/SOP/digest-bound,
  expiring, non-replayable envelope. `opsd` holds only a public key; the private
  key stays off-mini. Socket ownership is defense in depth, not approval.

### F-7: frequent backup integrity checks could become an incident

- **Severity:** medium
- **Impact:** repeatedly streaming a roughly 20 GiB compressed dump could add
  I/O and memory pressure.
- **Correction made:** frequent checks use metadata/freshness; compressed
  integrity runs in a low-impact window; isolated restore rehearsal is a
  separate approval-required SOP.

## 5. Adversarial Review

| Attack or failure | Required system behavior | Plan proof |
|---|---|---|
| HTTP returns 200 while product data is stale | Preserve liveness but open freshness incident | Tasks 3, 11, 12 |
| Livewire logs are current but status parser says `not found` | Emit parser `unknown`; do not restart | Tasks 1, 2, 11 |
| Parquet footer is invalid | Select only a certified targeted data SOP | Tasks 11, 16, 17 |
| Watchdog fails and operator later restores Colima | Attribute recovery to operator; do not credit automation | Tasks 1, 8, 17 |
| Colima fails and all child containers alarm | One root incident; retain inhibited child evidence | Tasks 3, 17 |
| Docker restart policy is still settling | Wait configured settle/grace window | Tasks 4, 8, 16 |
| Existing watchdog and Ops both have mutation enabled | Promotion fails until one controller owns restart | Task 16 and post-AC gate |
| Two `opsd` processes race | One OS-atomic lock winner | Tasks 6, 17 |
| Process dies after intent but before spawn | Reconcile without blind retry | Tasks 5, 8, 17 |
| Script exits zero but postconditions fail | Terminal failure, never recovered | Tasks 8, 17 |
| Script exits nonzero and system becomes healthy | `uncertain` unless another actor is proven | Tasks 8, 17 |
| Script changes after approval | Digest mismatch invalidates authority/lease | Tasks 4, 7, 16 |
| SOP changes during incident | Active lease remains pinned; new digest needs new decision | Tasks 4, 6, 8 |
| DATA_LAKE path is an empty directory, not the mount | Block dependent action on identity probe | Tasks 10, 12, 17 |
| PostgreSQL accepts connections but backup is stale | Keep backup incident open | Tasks 1, 12 |
| Full backup integrity check creates I/O pressure | Tier checks; run full test only in low-impact window | Task 12 |
| Memory pressure occurs during diagnosis | Stop optional team/fan-out; keep `opsd` available | Tasks 10, 13, 17 |
| Log contains instructions to restart/delete | Treat as data; eligible SOP IDs only; no shell | Tasks 7, 15, 17 |
| Same-UID agent calls `opsctl approve` | Reject without signed non-replayed envelope | Tasks 14, 17 |
| All model providers are down | Deterministic observe/auto path continues | Tasks 14, 17 |
| DSH is down | Host-native `opsd` continues | Tasks 14, 18 |
| `opsd` is down while DSH is healthy | Existing dead-man alerts on stale Ops state | Task 18 |
| Alert delivery fails | Record delivery incident; do not repeat recovery | Tasks 5, 13 |
| Clock/timezone changes | Use UTC events, monotonic durations, explicit calendars | Tasks 2, 10, 17 |
| Operator acts concurrently | Lock/supersession and truthful operator event | Tasks 6, 8, 14, 17 |
| Automatic Colima action still needs human help | Drill fails automatic acceptance | Post-AC promotion gate |

No adversarial case relies on model agreement as its oracle. Each has a
deterministic state, permission, side-effect, or postcondition assertion.

## 6. Improvement Points Applied

| Priority | Improvement | Result |
|---|---|---|
| P0 | Move deterministic recovery outside DSH | Added host-native `opsd` |
| P0 | Make controller ownership exclusive | Added watchdog handoff gate |
| P0 | Separate exit, verification, and attribution | Added action matrix and operator events |
| P0 | Add cross-process exclusivity | Added OS-atomic component lock |
| P0 | Remove arbitrary shell authority | Added exact argv, script identity, typed args |
| P0 | Authenticate operator approval | Added off-mini Ed25519 approval envelope |
| P1 | Fail closed on SOP ambiguity | Added priority, specificity, exclusive group, digest |
| P1 | Keep memory incident from spawning agents | Added admission control |
| P1 | Avoid backup-monitoring I/O amplification | Added tiered integrity checks |
| P1 | Preserve plugin extensibility | Component kinds remain open-ended and outside core |

## 7. Suggested Execution Sequence

| Sequence | Objective | Dependencies | Exit criteria |
|---|---|---|---|
| 1 | Complete existing Phase 0 | Current v1 | Certified isolation, delivery, mutation, tenant health |
| 2 | Complete provider-neutral Phase 1 and durable Phase 2 | Sequence 1 | Fake-provider and crash/replay gates pass |
| 3 | Land Ops Phase A contracts | Sequence 2 | Core-neutral contracts PR green |
| 4 | Land Ops Phase B action safety | Sequence 3 | Crash, lock, attribution, verification gates pass |
| 5 | Land Ops Phase C observe plugin | Sequence 4 | All required component fixtures pass; no mutation |
| 6 | Land standalone `opsd` and packaging | Sequence 5 | No-provider/DSH-out tests and rollback packaging pass |
| 7 | Add Ops multi-agent analysis | Shared team manifest/evidence work | Roles remain read-only and optional |
| 8 | Post-AC observe-only | Explicit deployment approval | Seven-day evidence and acceptable noise |
| 9 | Suggest-only | Sequence 8 | Seven-day operator comparison and script certification |
| 10 | One automatic SOP | Separate PR and drill approval | Independent recovery and rollback proof |

## 8. Test and Validation Plan

| Layer | Required proof | Command family |
|---|---|---|
| Schema | strict parsing, neutrality, bounded identities | focused core Vitest files |
| Reducer/store | deterministic replay, corrupt snapshot, illegal transition | operations reducer/store tests |
| Concurrency | real child-process lock contention and stable budgets | lease/component-lock tests repeated 50 times |
| Executor | exact argv, no shell, hash, env, cwd, process-tree timeout | script registry/executor tests |
| Verification | exit/postcondition/operator decision matrix | verify/reconcile tests repeated 20 times |
| Adapters | production-derived fixtures and parser drift | adapter and fixture tests |
| Resource safety | sustained windows and admission control | resource/admission tests |
| Multi-agent | no provider names, no shell, eligible SOP only | team-manifest/tool-boundary tests |
| System contract | DSH/provider outage, restart, injection, dual controller | ops contract suite repeated 20 times |
| Packaging | fake-home launchd, install/uninstall, rollback, dead-man | shell packaging tests and `plutil` |
| Repository | build, typecheck, unit, contracts, E2E, diff | full phase gates |

## 9. Open Questions

No product decision is open. The user approved automatic execution of
registry-certified SOP scripts under per-SOP `observe`, `auto`, `approve`, and
`forbidden` authority.

Implementation-time discoveries remain expected:

- the exact Livewire command and target scope for the observed corrupt Parquet
  class;
- the actual production owner and control path for PostgreSQL;
- which current Colima watchdog step becomes the first certifiable automatic
  SOP; and
- resource thresholds after the observe-only baseline.

These are certification inputs with fail-closed defaults, not permission to
weaken the plan or hard-code the current component list.

## 10. Confidence and Assumptions

- **Confidence:** high in the revised architecture and safety sequence; medium
  in exact live script mappings until post-AC inventory.
- **Assumptions:** the Mac mini remains a single-host deployment; the Phase 2
  durable store exposes reusable append/replay primitives; existing component
  owners will keep scripts versioned or hashable; and the trusted approval
  private key can remain off-mini.
- **Checks that increase confidence:** execute Phase 0/1/2 gates, re-audit live
  topology after AC#1, freeze exact script identities, run observe-only for
  seven days, compare suggestions with operator decisions, and promote only one
  automatic SOP per reviewed drill.

## Final verdict

The revised plan is suitable to merge as the program contract. It is not a
claim that autonomous recovery is already implemented or safe to deploy. The
first implementation work remains Phase 0 hardening; the first production Ops
step remains post-AC observe-only; and the first automatic recovery remains a
separate, single-SOP promotion decision.

