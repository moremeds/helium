# Helium Multi-Agent Master Plan

**Date:** 2026-08-25

**Last revised:** 2026-08-28 — Revision 3, program review adjudication round 2

**Status:** Program direction approved; program state `not-ready` until this
revision lands and the Phase 0 handover is resynced

**Production constraint:** Do not change the mini during the active AC#1
observation window, which closes 2026-08-31. The test is **presence**, not
mutation — see section 13.4 of the
[ops-agent design](2026-08-25-helium-ops-agent-design.md)

## Revision 3 — 2026-08-28

The [round-2 decision record](../reviews/2026-08-28-adjudication-round-2.md)
adjudicated the three conflicts the Revision 2 edit surfaced and the five
review findings Revision 2 left unadjudicated. It is authoritative for this
revision and wins wherever it conflicts with the review; where it conflicts with
[Revision 2's decision record](../reviews/2026-08-28-plan-review-adjudication.md)
that record still wins, except where round 2 states a ruling and its reason.

Substantive changes in this revision:

- **R1** — the generic append-only event store (fsync, hash, snapshot,
  truncated-line recovery, replay) is extracted into **P1, multi-agent
  Task 7**, beside `EvidenceBundle` and `EvidenceLedger`. Ops Task 5 and
  multi-agent Task 13 both consume it, so Ops Phase B no longer blocks on the
  P2 durable team kernel that the corrected execution order places after it.
- **R4** — the topology guard splits. Its **structural** half lands in P1 as
  multi-agent Task 10b (`contracts/tests/topology-structure.contract.spec.ts`):
  a compile-time exclusion on the sensor context type plus an import-graph
  lint. The behavioral half stays in P3, so the guard is in force on the day
  P2.5a writes the first collector and every probe.
- **R5** — program rule 13 is rescoped to WorkOrder-carrying execution paths,
  which is what the canonical topology actually governs, and stays fully binding
  on every team and every new plugin. The v1 delivery lane's real exposure
  against acceptance criterion 16 is recorded as a named, versioned, expiring
  exemption,
  [EX-1](#ex-1--v1-delivery-lane-exemption-from-acceptance-criterion-16),
  rather than defined away.
- **R6** — the five disagreeing neutrality word lists collapse into one exported
  constant scanning for bare `claude`, and the two test fakes now differ on
  **both** axes: `fake-metered` (process isolation, token-priced) and
  `fake-flat-rate` (in-process, flat-rate with a session quota). The P1 catalog
  gate therefore tests economics blindness, not only isolation class.
- **R7** — four unfalsifiable exit gates are replaced with commands and hashes:
  provider and team-package install/remove proven by `pnpm remove` then
  `pnpm add` plus an empty `git diff --name-only`; the claim population closed
  by a committed `docs/evidence/claims.yaml` register; the P3 advantage reduced
  to one pre-registered primary metric on a hashed fixture set; and P5
  activation measured as an automated command rather than 30 minutes of operator
  typing.
- **R8** — the AC#1 boundary is stated as **presence** rather than mutation,
  with the two observation windows enumerated as verb lists in §13.4 of the
  [Ops Agent design](2026-08-25-helium-ops-agent-design.md), the near-term
  subset's "no install until AC#1 closes" caveat restored, and the freeze end
  date pinned at **2026-08-31**, which no plan document previously carried.

**Adjudicated as not conflicts; no change made.** **R2** — the WorkOrder YAML
`min_isolation_class` against the TypeScript `minIsolationClass` is the
documented and already-shipped snake_case-YAML / camelCase-TypeScript mapping
(`packages/core/src/job.ts:1-5`), not a typo; unifying either way would
manufacture a real defect to close a phantom one. **R3** — `superseded` was
never a proposed seventh action outcome; the six-value set stands, and the
discriminant between `not-needed` and `superseded-by-operator` is the
pre-action baseline, not the actor.

**Four `PROVISIONAL` parameters await operator ratification.** Each was chosen
to make a gate falsifiable, not derived from a measurement or a prior decision
in this program, and each must be ratified or replaced before the phase that
consumes it begins: **P-1** (at least 30 paired evaluation cases) and **P-2**
(20% relative reduction at p < 0.05) in the Phase 3 exit gate; **P-3** (120 s
activation ceiling) in the Phase 5 exit gate; and **P-4** (EX-1's 2027-02-28
hard expiry) in EX-1.

## Revision 2 — 2026-08-28

The [program review](../reviews/2026-08-28-multi-agent-program-plan-review.md)
was adjudicated by the
[decision record](../reviews/2026-08-28-plan-review-adjudication.md), which is
authoritative for this revision and wins wherever it conflicts with the review.
It set the program status to **`not-ready`** pending this docs-only revision, and
**paused** the Phase 0 handoff
(`docs/codex-handoffs/2026-08-26-helium-multi-agent-phase0-claude.md`, on the
`feat/multi-agent-phase0` branch) until this revision lands and the handover is
resynced. The direction is sound; the blockers are unclosed safety contracts
and sequencing conflicts, not a wrong architecture.

Substantive changes in this revision:

- **ARCH-2** — a frozen P0 `EvidenceManifest` template is now inline in this
  plan, with the verifier of a deterministic assertion defined as a command,
  its version, and its output hash. P1's schema must inherit it.
- **ARCH-3** — `quota-exhausted` with `retryAfter` enters the failure
  vocabulary at P0, as a dynamic provider-availability state rather than a
  static capability score.
- **ARCH-1 / D2** — the DSH in-process driver is one low-isolation executor
  class, not the unified execution path. Every executor declares an
  `isolationClass` and passes one conformance suite; P0 delivers that
  conformance harness and P1's `Executor` inherits it.
- **D3** — capability routing is reduced to a thin selector v1. Scoring, the
  capability ontology, confidence intervals, automatic learning, and the
  effort-evaluation harness are deferred; the routing seam and rule 5 stay.
- **XDOC-1** — Phase 2.5 splits into P2.5a (deterministic ops substrate) and
  P3.5 (team admission enforcement, after the P3 team controller exists).
- **OPS-1 / OPS-2 / OPS-3** — the signed authority manifest, dual-controller
  exclusion, and pre-action baselines become named gates with stated threat
  models and termination states.
- **D4.2** — "exactly once" is removed from program vocabulary.
- **D4.1 / §4** — deferred and cut scope, and the near-term subset (enumerated
  by task ID: 20 of the 46 originally planned tasks, 21 of the 48 task units
  this revision leaves behind), are recorded so scope cannot silently
  re-inflate.
- **D5** — the near-term execution order (P0 → P1 → P2.5a → P2 → P3 → P3.5 →
  P4) is recorded explicitly, because it is not the numeric label order.

## Executive summary

Helium v1 has proven the operational substrate required for an unattended agent
harness: release, rollback, retention, tenant isolation, heartbeats, dead-man
monitoring, selective escalation, append-only state, and delivery. The next
program will preserve that substrate while replacing the fixed two-engine path
with a durable, provider-neutral multi-agent system.

The target is not a swarm of named models. Helium core will not know whether an
execution target is DeepSeek, Claude, Codex, a local model, or a future
provider. Teams declare roles and capability requirements. Provider plugins
register opaque execution targets that declare capability tags, an
`isolationClass`, and their current availability. A thin capability selector
hard-filters the eligible set on those declarations, then applies the
configured per-role target preference and its ordered fallback. Weighted
scoring, measured capability evaluations, and automatic learning are deferred
until real usage data exists; the selection seam is not.

The team controller will own durable cases, identities, task DAGs, artifacts,
budgets, cancellation, recovery, verification, and delivery; the general
inter-agent mailbox is deferred until a team graph needs it. Agents
will run in isolated contexts and exchange structured evidence. Cross-reference
will compare claims and re-check evidence; it will not treat model majority as
truth.

The macro system is the first pilot. It will preserve the causal sequence from
inflation through rates and USD to gold, run in shadow mode against the existing
single-senior lane, and be promoted only when it demonstrates better evidence
quality without violating safety, recovery, latency, or cost gates.

The Ops Agent is the second reference team and the first continuous, mutating
team. It will observe Livewire, Argon, Apex, Colima, PostgreSQL, and host
resources, diagnose incidents, and execute only versioned SOP scripts whose
individual authority permits it. Deterministic incident, lease, execution, and
verification controls remain functional when no model provider is available.
The initial component list is required coverage, not a hard-coded boundary.

## Program outcome

The program is complete when Helium can:

- install or remove an execution provider without editing core, proven by
  running `pnpm remove` and then `pnpm add` for each of the two provider
  packages, where every command exits 0 **and**
  `git diff --name-only -- packages/core plugins/helium` prints nothing;
- run the same team definition against different model catalogs;
- select an execution target from declared capability requirements,
  isolation class, and availability, without core knowing a provider name;
- coordinate multiple isolated agents through durable tasks and immutable
  artifacts;
- survive process restart without duplicate work or delivery;
- cross-check material claims using fresh evidence;
- audit every decision back to an exact execution snapshot;
- bound cost, time, tools, spawning, and mutations;
- add a component, probe, dependency, or SOP without editing core;
- execute a certified automatic SOP under a write-ahead intent and at most one
  active lease, with no blind retry, and either prove its postconditions or
  reconcile it as `uncertain` after a crash;
- attribute recovery truthfully to Helium, an operator, or an external actor;
- preserve deterministic monitoring and recovery when model providers fail;
- preserve the v1 compatibility path and rollback; and
- add a new ecosystem team without changing core; and
- attach every claimed capability, incident resolution, and promotion decision
  to a reproducible evidence manifest rather than an agent self-report, over a
  **closed population**: `docs/evidence/claims.yaml` is a committed register
  carrying one id per program-outcome bullet above, per phase exit gate, per
  `succeeded` `ActionOutcome`, and per promotion decision, and a contract test
  re-runs each deterministic claim's command at its pinned tool version and
  compares the `sha256` of the output against the recorded hash. An empty or
  unpopulated register **fails** that test; it never passes vacuously, because
  an open claim set has no denominator and nothing in it can be found missing.

## Program rules

1. No direct push to `master`; every phase lands through a green pull request.
2. No deployment to the mini during the AC#1 observation window, which closes
   2026-08-31. The test is presence, not mutation: see section 13.4 of the
   [ops-agent design](2026-08-25-helium-ops-agent-design.md).
3. No multi-agent expansion before every execution boundary is certified. Each
   executor declares an `isolationClass` and passes the same
   execution-boundary conformance suite; a task only reaches an executor whose
   isolation class permits it.
4. No production dependency on unpublished DSH experimental packages.
5. No provider or model names in core schemas or branching logic.
6. No model majority vote as an acceptance mechanism.
7. No externally material mutation without an exact versioned SOP,
   deterministic policy, and durable authority decision. Per-incident approval
   is required unless that exact SOP version has reviewed `auto` authority, and
   an `auto` authority loads only when the signed authority manifest lists that
   exact SOP version and digest. Mutation safety is stated as write-ahead
   intent, at most one active lease, no blind retry, and idempotent or
   effectively-once execution where the target supports it — never as "exactly
   once". An outcome that cannot be reconciled after a crash stays `uncertain`.
8. No promotion based only on unit tests; restart, failure, and live shadow
   evidence are required.
9. No agent-generated shell command. Mutations use typed arguments and a
   certified script/action registry.
10. No production trajectory may grant itself new tools, SOPs, or authority.
11. No document, dashboard, or release may collapse `PLANNED`, `PARTIAL`,
    `PROVEN`, `FAILED`, and `BLOCKED` into a generic complete state.
12. No phase passes because agents agree. Its evidence manifest must satisfy
    the verifier and freshness policy defined for every material assertion.
13. No WorkOrder-carrying execution path may bypass the canonical topology
    in the
    [multi-agent design](2026-08-25-helium-multi-agent-design.md#55-canonical-agent-and-verification-evidence-topology).
    This binds every team and every new plugin without exception, which is where
    the escape risk actually is. The pre-WorkOrder v1 delivery lane is out of
    scope **by construction, not by permission**: it produces no `WorkOrder` and
    has no node in that topology, so there is nothing for it to bypass. Its
    separate obligation under acceptance criterion 16 is governed by
    [EX-1](#ex-1--v1-delivery-lane-exemption-from-acceptance-criterion-16), not
    by this rule.

### EX-1 — v1 delivery-lane exemption from acceptance criterion 16

**Version 1, 2026-08-28.** Granted by the project owner in the
[round-2 adjudication](../reviews/2026-08-28-adjudication-round-2.md). It is
recorded here as a named, versioned, expiring exemption so the gap stays
visible, attributable, and dated rather than defined away.

**Scope.** The `legacy-direct` runtime mode only — the flag defined at
`docs/plans/2026-08-25-helium-multi-agent-implementation.md:1216-1217`, which
selects `legacy-direct` or `work-order-adapter` — covering the tenants shipped
at `v0.1.5`. `work-order-adapter` is the compliant path and is never exempt.

**What is exempted.** Acceptance criterion 16 only: a material factual claim
delivered on that lane has no Accepted Claim Ledger entry, no hashed,
freshness-bounded evidence bundle, and no typed execution snapshot.

**What is not exempted.** Everything else that already binds v1 continues to
bind it: the write-ahead JSONL record before the SMTP side effect, per-tenant
liveness, the tool allow-list, and the isolation boundary. EX-1 relieves
**evidence provenance and nothing else** — it grants no relief from any safety,
isolation, or durability rule, and it never extends to a mutating action.

**Expiry.** The earlier of two events: `work-order-adapter` becoming the default
runtime mode with `legacy-direct` removed, or **2027-02-28** — a date marked
**`PROVISIONAL`** (parameter P-4) and pending operator ratification. On that
date EX-1 must be re-granted as version 2 with fresh justification, or the v1
lane stops delivering. Expiry deliberately does not anchor to the shadow-team
promotion gate, because [Phase 4](#phase-4-controlled-reference-team-promotion)
keeps v1 alive past it.

**Restatement.** Every phase gate from P1 onward restates EX-1's version and its
remaining scope in that phase's evidence manifest, so the exemption cannot
decay into an unrecorded assumption.

**Standing status: `PARTIAL`.** While EX-1 is in force, no document, dashboard,
or release may report acceptance criterion 16 as `PROVEN`.

## Delivery strategy

Each phase is independently mergeable and preserves a usable system. V1 remains
the production path until the shadow team passes its promotion gate.

The list below is the **phase catalogue in label order**, not the execution
order. Phase labels are stable identifiers for scope and evidence gates; the
order in which they are executed is stated in
[Deferred scope and the near-term subset](#deferred-scope-and-the-near-term-subset)
and differs from label order.

```text
P0 hardening
   -> P1 provider-neutral contracts
   -> P2 durable team kernel
   -> P2.5a deterministic operations safety substrate and Ops shadow
   -> P3 macro shadow team
   -> P3.5 team admission enforcement
   -> P4 controlled reference-team promotion
   -> P5 ecosystem plugin expansion        (gated on real usage data)
   -> P6 evaluated evolution                (gated on real usage data)
```

Phase 2.5 is split. **P2.5a** carries everything that has no dependency on the
team controller and therefore genuinely precedes P3. **P3.5** carries team
admission enforcement and the Ops work that must modify
`plugins/helium/src/team-controller.ts`, which P3 creates. Scheduling both
under one P2.5 was a circular dependency (XDOC-1): P2.5 could not complete, and
its host-pressure exit gate tested a scheduler that did not exist yet.

### Canonical topology and evidence gates

The normative agent, control-plane, operations, and verification-evidence
topology is defined in
[Section 5.5 of the multi-agent design](2026-08-25-helium-multi-agent-design.md#55-canonical-agent-and-verification-evidence-topology).
This master plan controls sequencing and promotion; it does not redefine that
topology.

Every phase exit produces a versioned `EvidenceManifest`. Each manifest names:

- the exact assertion and acceptance bound;
- assertion class and evidence-policy version;
- raw artifact references and hashes;
- reproduction or replay procedure;
- baseline or control snapshot;
- verifier identity, version, and decision;
- sample count, latency, cost, and confidence when statistical;
- failures and bad-case categories;
- production, shadow, drill, or offline scope;
- current status from the canonical vocabulary; and
- remaining limitation and next unopened gate.

#### Frozen P0 evidence-manifest template

The formal `EvidenceManifest` schema is a P1 deliverable, but P0 exits before
P1 exists. The template below is therefore **frozen now** and is the P0 exit
artifact; it is hand-written and hand-checked, and it needs no code to produce.

```yaml
manifestVersion: p0-1
phase: P0
scope: offline # production | shadow | drill | offline
recordedAt: 2026-00-00T00:00:00Z
claims:
  - id: P0-ISOLATION-UNDECLARED-TOOL
    assertion: "An execution target cannot invoke a tool outside its declared contract."
    acceptanceBound: "Zero undeclared tool invocations across the adversarial suite."
    assertionClass: deterministic # deterministic | statistical
    evidencePolicyVersion: p0-1
    verification:
      verifier: command # never a model, never a second human
      command: "pnpm vitest run <path to the adversarial contract>"
      toolVersion: "<tool name and exact version>"
      outputHash: "sha256:<hash of the captured output>"
      decision: pass # pass | fail | inconclusive
    artifacts:
      - path: "<committed or archived raw output>"
        sha256: "<hash>"
    baseline: "v1 behavior at <commit>"
    reproduction: "git checkout <commit> && pnpm install && <command>"
    failures: "<bad-case categories observed>"
    status: PROVEN # PLANNED | PARTIAL | PROVEN | FAILED | BLOCKED
    limitation: "<what this claim does not prove>"
    nextGate: "<the next unopened gate>"
```

Rules that hold from P0 onward:

- The verifier of a **deterministic** assertion is a **command plus its exact
  version plus the hash of its output**. It is never a model, and it is never a
  second human who does not exist. Helium is a single-operator project: the
  operator authors the manifest, the command verifies it, and a manifest that
  implies independent human review is a false evidence record.
- A **statistical** assertion additionally records sample count, latency, cost,
  and confidence. A model or a human may be the _subject_ of such a claim; it
  is still not the verifier of a deterministic one.
- P1's formal `EvidenceManifest` schema **inherits this template**: every field
  above survives with the same meaning, P1 may only add fields or tighten
  types, and a P0 manifest must validate against the P1 schema without being
  rewritten.

The minimum evidence ladder is:

| Phase | Required evidence before exit                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0    | adversarial isolation, execution-boundary conformance harness, `quota-exhausted` classification, delivery-boundary crash replay, and v1 behavior comparison, recorded in the frozen P0 manifest template     |
| P1    | fake-provider core suite, neutrality scan, catalog replay, and the typed `AgentResult.executionSnapshot` populated on every recorded run                                                                     |
| P2    | controller kill matrix, deterministic replay, duplicate-work proof, and cancellation drain                                                                                                                   |
| P2.5a | production-derived incident fixtures, schema-validated fixtures, signed-authority-manifest proof, SOP/lease proof, pre-action baselines, dual-controller exclusion, postconditions, and truthful attribution |
| P3    | frozen offline evaluation, v1-control comparison, evidence-completeness score, and shadow-only proof                                                                                                         |
| P3.5  | team admission enforcement under host pressure with collectors and deterministic recovery still available                                                                                                    |
| P4    | bounded production window, real case or controlled drill, rollback, cost, latency, and human takeover evidence                                                                                               |
| P5    | plugin conformance, isolation, no-core-change proof, and independent promotion record                                                                                                                        |
| P6    | reproducible before/after evaluation, reviewed policy change, and rollback-compatible snapshot                                                                                                               |

Passing lower layers does not imply a higher-layer claim. A unit or fixture pass
may prove a contract while production capability remains `PARTIAL` or
`PLANNED`. Conversely, a healthy production observation does not prove that an
agent or controller caused recovery unless the action and attribution chain is
complete.

### Deferred scope and the near-term subset

Recorded here so that later revisions cannot silently re-inflate scope. The
program is 46 tasks across 233 distinct planned file paths; the reduction must
never come from deleting the model-blind capability seam.

**Deferred until real usage data exists:** the 31-item capability ontology;
measured capability scores and confidence intervals; weighted scoring;
automatic learning; the full effort-evaluation harness and the provider-effort
selection plan; P5 ecosystem plugin expansion; P6 evaluated evolution.

**Deferred:** the general durable mailbox. Task dependencies plus immutable
artifact references are the only inter-agent channel until a team graph
actually needs sibling messages.

**Kept regardless of any reduction:** the opaque target registry; capability
tags; `isolationClass`; quota availability; per-role preference and ordered
fallback; the provider-neutral `ExecutionLease`. Rule 5 is not weakened by any
deferral — effort and model identity live in the provider catalog and the admin
override, and core sees only opaque targets.

**Execution order.** Numeric phase labels are identifiers, not an execution
order. Per adjudication D5 the deterministic operations substrate is built
before the team kernel, because the observe-only collector and the mutation
safety contracts are what make everything after them auditable. The near-term
execution order is:

```text
P0 -> P1 -> P2.5a -> P2 -> P3 -> P3.5 -> P4
```

P1 here means the minimal model-blind core only — `WorkOrder`, `AgentResult`
including its typed `executionSnapshot`, the thin selector, and the `Executor`
registry with its conformance suite — not the deferred scoring machinery.

**Near-term subset — stated as task IDs, because raw counts drift.** The subset
is exactly:

- multi-agent Phase 0: Tasks 1–5;
- multi-agent Tasks 6–7;
- Ops Tasks 1–8, including Task 7b (single mutation ownership);
- Ops Tasks 9–12 and 18, which are reversible observe-only **packaging** — no
  install until AC#1 closes, under the presence test stated in
  [Phase 2.5a](#phase-25a-deterministic-operations-safety-substrate-and-ops-shadow).

Both framings of the size, stated honestly: this is **20 of the 46 tasks
originally planned**, and **21 of the 48 task units the plan set now carries**
after Revision 2 added Ops Task 7b and split Ops Task 13 into 13a (P2.5a) and
13b (P3.5). The enumeration above is authoritative; where a count elsewhere
disagrees, the enumeration wins. Everything else waits behind the gates above.

## Phase 0: certify the existing boundary

### Objective

Make the current senior lane safe enough to become one possible execution
provider in a multi-agent system.

### Work

- Replace approval-only tool flags with actual tool restriction.
- Isolate provider settings, MCP configuration, instructions, environment, and
  working directory.
- Give each execution an owned workspace.
- Unify timeout, process-tree termination, drain, and orphan detection.
- Convert delivery to write-ahead intent plus outcome records.
- Implement or remove the non-functional mutation option.
- Validate tool names against the installed catalog.
- Add expected-tenant and per-tenant liveness checks.
- Add adversarial tests for undeclared tools, paths, settings, and MCP servers.
- Build a **reusable execution-boundary conformance harness** from those
  adversarial tests: one suite, parameterized over the boundary under test,
  that any later executor class must pass. The formal `Executor` interface does
  not exist until P1, so P0 is deliberately **not** written generically over an
  `Executor` type; it freezes the contract that P1's `Executor` inherits, and
  the current senior lane is its first subject.
- Add `quota-exhausted` with an opaque `retryAfter` to the normalized failure
  vocabulary, and emit it from the existing `classify()` path, which today
  buckets session-window exhaustion as a generic `error`. Quota is a **dynamic
  provider-availability state**, not a static capability score: an exhausted
  session window makes a target temporarily ineligible and never downgrades
  what that target is capable of.
- Record the P0 exit evidence in the frozen P0 evidence-manifest template.

### Exit gate

- An execution target cannot access anything outside its declared contract.
- A forced timeout leaves no process or task running.
- A crash at every delivery boundary leaves a reconciliable ledger.
- A misspelled capability rejects only the affected tenant and raises its
  health state.
- The conformance harness runs against the senior lane as a named boundary and
  can be pointed at a second boundary without rewriting its assertions.
- Session-window exhaustion classifies as `quota-exhausted` with `retryAfter`,
  never as a generic `error` and never as a capability change.
- Existing v1 tests and behavior remain green.
- The exit evidence is a completed P0 manifest whose deterministic claims each
  name a command, its version, and its output hash.

### Deployment rule

Development and review may proceed on an isolated branch. Release or mini
deployment waits until AC#1 closes and its evidence is recorded.

## Phase 1: provider-neutral contracts

### Objective

Remove model knowledge from core and introduce stable plugin seams without
changing production behavior.

### Work

- Define `WorkOrder`, `CapabilityContract`, `RoutingPolicy`, `ExecutionLease`,
  `AgentResult`, and normalized failure schemas, including `quota-exhausted`
  and `retryAfter` as carried over from P0.
- Define provider registration and executor services on DSH/Cordis seams. The
  `Executor` interface **inherits the P0 execution-boundary conformance
  contract**: every executor declares an `isolationClass` and passes that same
  suite before it can be registered.
- Define the opaque target registry and its catalog schema: capability tags as
  a flat set, isolation class, and availability including quota. The versioned
  31-item capability ontology is deferred until real usage data exists.
- Implement the thin capability selector v1 — see
  [Phase 3](#phase-3-macro-shadow-team-on-the-thin-selector) for the selector
  chain it implements and the deferred scoring machinery it replaces.
- Implement a fake provider as the core contract reference.
- Implement a v1 compatibility adapter that reproduces the current certified
  path.
- Add a source/contract guard that rejects provider names from core schemas and
  logic.
- Add a typed `AgentResult.executionSnapshot` — provider, model, effort,
  provider version, and the `isolationClass` as executed — written at the
  provider edge and stored as evidence. Core never branches on it, so rule 5
  holds; it is what the "exact execution snapshot" gate is measured against.
  Remaining provider-native audit data stays in opaque runtime metadata.
- Define the privileged exact-target override for replay, evaluation,
  certification, incident diagnosis, and emergency failover.

### Exit gate

- The full core suite runs with only the fake provider installed.
- Adding or removing a provider changes no core or team code, proven by running
  `pnpm remove` and then `pnpm add` for each of the two provider packages:
  every command exits 0 **and**
  `git diff --name-only -- packages/core plugins/helium` prints nothing. A
  non-empty diff fails the gate.
- Removing every production provider does not prevent core boot or tests.
- The same work order resolves against at least two different test catalogs
  whose targets differ on **both** axes — isolation class **and** economics.
  `fake-metered` is process-isolated and token-priced: it reports `usage.cost`
  and `usage.tokens` and may terminate `budget-exhausted`. `fake-flat-rate` is
  in-process and flat-rate with a session quota: it reports neither cost nor
  tokens — the fields are absent, not zero — and may terminate
  `quota-exhausted` with an opaque `retryAfter`. Core must not branch on,
  assume, or default either economics; normalizing `quota-exhausted` into
  `budget-exhausted`, or reading an absent cost as a known zero, fails the gate.
- No executor registers without a declared `isolationClass` and a passing run
  of the P0 conformance suite.
- No sensor or collector module can statically reach an executor, provider
  adapter, or lease: the sensor context type carries no executor member and the
  import-graph lint passes. This is the structural half of the topology guard,
  delivered by multi-agent Task 10b as
  `contracts/tests/topology-structure.contract.spec.ts`; the behavioral half
  stays in P3. It lands here, before P2.5a in the execution order, so it is in
  force on the day the collector and its probes are written.
- The selector resolves a work order from capability requirements, isolation,
  tools, quota, and availability alone; a `quota-exhausted` target falls back
  in order instead of failing the work order.
- Every recorded run carries a parsed, typed `AgentResult.executionSnapshot`;
  no run satisfies the snapshot requirement through untyped runtime metadata.
- V1 compatibility tests remain behaviorally unchanged.

## Phase 2: durable team kernel

### Objective

Create the control plane required for true multi-agent execution.

### Work

- Add append-only `Case` and `TeamRun` state.
- Add stable roster identities and role contracts.
- Add a versioned, compare-and-swap task DAG.
- Add immutable artifact manifests, hashes, and provenance. Task dependencies
  plus artifact references are the inter-agent channel; the general durable
  queue-then-acknowledge mailbox is deferred until a team graph needs sibling
  messages.
- Add case, team, and agent budget ledgers.
- Add bounded spawn, follow-up, status, interrupt, list, cancel, and drain.
- Integrate DSH subagents through named provider plugins. The DSH subagent seam
  is provider-decided and supports multiple named providers and out-of-process
  providers; the current in-process driver inherits the parent provider, model,
  and working-directory lineage. DSH in-process is therefore **one
  low-isolation executor class**, never the unified execution path for all
  targets.
- Give Claude and Codex subscription targets a dedicated **out-of-process
  executor**, which declares its own `isolationClass` and passes the same
  conformance suite as every other executor.
- Route by isolation class: the in-process target receives only tasks its
  isolation class permits.
- Add snapshots and deterministic replay from JSONL.
- Add cascading cancellation and restart reconciliation.
- Detect dependency cycles, stale task writes, duplicate messages, expired
  leases, and orphan attempts.

### Exit gate

Run a deterministic failure matrix that kills the controller:

- before and after task assignment;
- before and after message acknowledgement, wherever a durable mailbox exists
  (deferred with it);
- during provider execution;
- during artifact publication;
- during cancellation; and
- before and after delivery intent.

Every restart must converge without duplicate tasks, messages, artifacts,
budget charges, or external delivery. Cancellation must leave no descendant
agent or provider process alive.

Additionally:

- Every registered executor has a passing execution-boundary conformance run on
  record, in-process and out-of-process alike.
- No task reaches an executor whose declared `isolationClass` does not permit
  it, and a subscription-target task never silently resolves to the in-process
  driver's inherited provider and model.

## Phase 2.5a: deterministic operations safety substrate and Ops shadow

### Objective

Prove the generic observation, incident, SOP, action, and verification contracts
needed by every mutating team, using the Ops Agent as the reference plugin.
This phase contains only work that does not depend on the team controller;
anything that must modify it moves to [Phase 3.5](#phase-35-team-admission-enforcement).

### Core work

- Define provider- and domain-neutral `Observation`, `Incident`,
  `SopDefinition`, `ActionProposal`, `ActionLease`, `ActionOutcome`, and
  `VerificationResult` contracts.
- Add a versioned component and dependency graph with cycle detection.
- Add deterministic incident correlation, deduplication, grouping, and parent
  inhibition. Alert grouping belongs here; team admission enforcement does not.
- Add per-SOP `observe`, `auto`, `approve`, and `forbidden` authority, loaded
  only through a **signed authority manifest**. The SOP YAML that carries
  `authority` is otherwise the single unsigned link in a cryptographically
  pinned chain: one file write turns `approve` into `auto`. The manifest binds
  `{sopId, version, digest, authority, certificationState}` with the same
  off-mini key as approvals, and `opsd` refuses an unlisted digest and an
  unlisted `auto`. **Threat model, stated explicitly:** this prevents
  unauthorized configuration escalation. It does not claim to resist a full
  same-UID host compromise.
- Specify **dual-controller exclusion** rather than restating "never two
  controllers" in prose. Required: a `mutationOwner` per component; a probe for
  a competing loaded launchd label; an ordered handoff and rollback procedure;
  and a fake-launchctl test contract that exercises the probe and that
  ordering, including the rollback direction. The controller
  precondition is fail-closed — unverifiable ownership refuses the mutation.
- Add write-ahead action intent, compare-and-swap `ActionLease` records,
  idempotency, recovery budgets, cooldowns, and circuit breakers. The write-ahead intent
  captures a **pre-action baseline** of every postcondition. If the
  postcondition already holds at baseline, the action terminates as
  `not-needed` — superseded before execution — and takes no automation credit.
  `not-needed` is the state name; the ops design's six-value action outcome set
  is normative, and `superseded-by-operator` is a different outcome for a
  different case. `uncertain` is reserved for genuinely unclear attribution.
- Add postcondition grace windows and startup reconciliation.
- Represent operator and external interventions as durable events.

### Ops plugin work

- Add a host-native `helium-opsd` service that owns collection, deterministic
  policy, leases, execution, and verification and remains alive when Colima or
  DSH is down.
- Register initial component adapters for Livewire, Argon, Apex, Colima,
  PostgreSQL, CPU, memory, disk/mounts, and Helium itself.
- Inventory existing sweep, reconcile, watchdog, health, quality, repair, and
  backup scripts.
- Certify scripts individually with typed inputs, exact identity, preconditions,
  postconditions, timeouts, attempt limits, and owner.
- Specify the future diagnostician, independent verifier, incident lead, and
  reporter contracts, but keep the Phase 2.5a production path deterministic and
  observe-only.
- Freeze sanitized fixtures from the observed Colima manual recovery,
  Livewire Parquet/coverage failure, Argon backup failure, Apex healthy state,
  parser drift, and host memory pressure. Each fixture is validated against the
  `Observation` schema, schema-first. A fixture test that asserts only that an
  array exists is a structural false green and does not count as evidence
  (XDOC-8).

### Shadow constraints

- Observe-only first; no SOP execution.
- Existing watchdogs, restart policies, and dead-man remain authoritative.
- During AC#1 the test is **presence**, not mutation: if it puts a byte on the
  mini or starts a process there, it is forbidden — including a single manual
  one-shot run, any `launchctl` load of a `com.helium.opsd*` label, any package
  install or upgrade, any Helium deploy, and any probe executed against the mini
  from another host. "No production component or host mutation" was too weak to
  refuse a LaunchAgent install on a literal reading. Both windows — this
  pre-install one and the later installed-and-observing one — are enumerated as
  verb lists in §13.4 of the
  [Ops Agent design](2026-08-25-helium-ops-agent-design.md). The freeze closes
  **2026-08-31**, and that date is the value the installer's freeze-window
  refusal reads.
- A parser failure yields `unknown`, never an automatic restart.
- Agents receive read-only evidence tools and eligible SOP IDs, never a generic
  shell tool.

### Exit gate

- The full deterministic path works with all model providers disabled.
- A fixture component installs without core changes.
- Every frozen fixture validates against the `Observation` schema.
- Parent dependency faults inhibit child alert storms without losing evidence.
- No `auto` authority loads unless the signed authority manifest lists that
  exact SOP version and digest; an edited SOP YAML alone cannot escalate
  `approve` to `auto`.
- Two controllers cannot acquire the same action attempt, and the
  dual-controller exclusion passes under the fake-launchctl contract: a
  competing loaded launchd label is detected, unverifiable ownership refuses
  the mutation, and handoff and rollback follow the specified order.
- Crash and restart at every action boundary produce no duplicate side effect.
- Command exit alone cannot mark recovery; all configured postconditions pass.
- An action whose postconditions already hold at the pre-action baseline
  terminates as `not-needed` and receives no automation credit.
- A failed automatic attempt followed by operator recovery is attributed to the
  operator, and `uncertain` appears only where attribution is genuinely
  unclear.
- The Ops design and exact gates in
  `docs/plans/2026-08-25-helium-ops-agent-design.md` pass their adversarial
  review.

The host-pressure fan-out gate moves with its dependency to
[Phase 3.5](#phase-35-team-admission-enforcement); it cannot be tested before
the team scheduler exists.

## Phase 3: macro shadow team on the thin selector

### Objective

Prove that multi-agent work adds information and quality over the v1
single-senior control, with target selection kept as thin as the evidence
justifies.

### Selector and provider work

The routing seam stays; the scoring layer does not. Selector v1 is a single
chain, and nothing in it needs a provider name:

```text
WorkOrder capability requirements
  -> isolation / tools / quota / availability hard filter
  -> configured opaque target preference
  -> ordered fallback
  -> ExecutionLease
```

- Register multiple provider adapters behind the same executor contract, each
  declaring capability tags, an `isolationClass`, and current availability.
- Seed capability tags from provider documentation as an opaque, flat set.
- Implement the hard filter, the configured per-role target preference, the
  ordered fallback, and a routing audit record.
- Treat `quota-exhausted` as a temporary availability state with `retryAfter`:
  it removes a target from the eligible set and triggers fallback, and it never
  edits what a target is deemed capable of.
- Detect capability shortage without silently relaxing requirements.
- Support task-scoped cross-reference and adjudication policy.
- Activate the Ops diagnostician, independent verifier, incident lead, and
  reporter in shadow mode after the shared team-manifest and evidence contracts
  exist. The deterministic `opsd` path remains independent of them.

**Deferred until real usage data exists:** the 31-item capability ontology,
score confidence intervals, sample-count-weighted scoring, automatic learning,
and the full effort-evaluation harness. A confidence interval computed from a
session-capped subscription launders a guess into a number.

**Kept:** the opaque target registry, capability tags, isolation class, quota
availability, per-role preference and ordered fallback, and the
provider-neutral `ExecutionLease`. Effort lives in the provider catalog and the
admin override; core sees only opaque targets, so program rule 5 holds
unchanged.

### Macro team

Use a deterministic causal DAG:

1. inflation evidence;
2. policy evidence;
3. rates path;
4. USD transmission;
5. gold impact;
6. optional portfolio implications;
7. independent evidence verification;
8. lead synthesis; and
9. final rendering.

Roles declare capabilities only. The selector may resolve a different execution
target for the same role on different runs.

### Shadow constraints

- No production email.
- No trading or ecosystem mutation.
- No replacement of the v1 senior lane.
- The same source event feeds control and shadow runs.
- Every claim carries provenance or is explicitly marked as judgment.

### Evaluation set

Include:

- frozen historical macro cases;
- production events with known follow-up outcomes;
- conflicting-source cases;
- stale-source and missing-source cases;
- prompt-injection fixtures;
- provider timeout and degradation drills;
- restart and cancellation drills; and
- real material events observed during the shadow period.

### Metrics

- task acceptance rate;
- verified-claim rate;
- unsupported-claim rate;
- contradictions discovered and correctly resolved;
- unique evidence introduced;
- source diversity and freshness;
- false escalation and missed materiality;
- structured-output fidelity;
- unauthorized tool attempts;
- latency, token use, and cost;
- restart recovery; and
- human preference by artifact type — recorded as a descriptive secondary only,
  never as a gate.

### Exit gate

- Zero unauthorized capability calls.
- All material factual claims have traceable provenance.
- Restart and cancellation contracts pass.
- The multi-agent path reduces the **unsupported-claim rate** — one
  pre-registered primary metric, lower is better — against the v1 control on a
  frozen fixture set. "A measured quality **or** information advantage" is
  withdrawn: an either/or lets the metric be chosen after the results are
  visible, so exactly one metric decides and it is named before the first
  shadow run. The fixture set is frozen by recording its directory `sha256`
  before that run and re-verifying the hash at gate time; a changed hash fails
  the gate rather than being re-baselined. Thresholds are **`PROVISIONAL`**
  (parameters P-1 and P-2, pending operator ratification): at least 30 paired
  cases, at least a 20% relative reduction, at p < 0.05 on a two-sided Wilcoxon
  signed-rank test. Human preference is a descriptive secondary that can never
  gate this phase — the sole operator is also the artifact's author, so it is
  the "pretend second human" the evidence rules already forbid.
- The accepted cost and latency envelopes are documented before promotion.
- No criterion is passed solely because several models agree.

## Phase 3.5: team admission enforcement

### Objective

Land the operations work that must modify the team controller, now that P3 has
created it. This phase exists because scheduling it inside Phase 2.5 was
circular: the controller it edits did not yet exist, and its exit gate tested a
scheduler that had not been built.

### Work

- Add the resource-pressure admission-control input to the team scheduler.
- Enforce team admission against that input in the P3 team controller
  (`plugins/helium/src/team-controller.ts`): the Ops task previously bundled
  with alert grouping, plus the Ops task that depends on the P3 team-manifest
  work. Alert grouping itself already shipped in P2.5a.
- Keep the deterministic `opsd` path independent of admission control: host
  pressure may refuse new team work, never collection or deterministic
  recovery.

### Exit gate

- Host pressure prevents new team fan-out while collectors and deterministic
  recovery remain available.
- Refused admission is a durable, attributable event, not a silent drop.
- Disabling every model provider does not change admission-control behavior for
  the deterministic path.

## Phase 4: controlled reference-team promotion

### Objective

Promote the macro and Ops reference teams through separate risk ladders without
losing the v1 fallback, deterministic recovery path, or operational controls.

### Work

- Release behind a runtime flag.
- Start with review-only artifacts and human approval.
- Canary a bounded subset of material macro cases.
- Keep v1 as immediate fallback. Because that fallback stays live past the P3
  promotion gate, it also keeps
  [EX-1](#ex-1--v1-delivery-lane-exemption-from-acceptance-criterion-16) in
  force through this phase, and this phase's exit line on exact execution and
  evidence lineage is therefore scoped to the promoted team path. Claims
  delivered on the retained v1 fallback remain `PARTIAL` under EX-1 and are not
  counted as satisfying it.
- Add team, agent, task, budget, and provider health surfaces (mailbox surfaces
  only if the deferred mailbox has landed).
- Add provider-specific circuit breakers without leaking provider identity into
  core policy.
- Exercise tagged rollback and state-schema compatibility.
- Keep the Ops Agent observe-only for at least seven days after its collector is
  installed.
- Run Ops suggest-only for at least seven days and record operator
  accept/reject/alternate decisions.
- Enable only one certified `auto` SOP at a time, with one attempt, narrow blast
  radius, and a reviewed maintenance window. The signed authority manifest must
  list that SOP version and digest before `opsd` will load its `auto`
  authority.
- Transfer mutation ownership from the prior component watchdog before enabling
  the corresponding Ops SOP, following the P2.5a handoff order: reassign
  `mutationOwner`, unload the competing launchd label, prove the probe finds no
  competitor, then enable. Rollback reverses that order. Unverifiable ownership
  refuses the mutation rather than proceeding.
- Keep approval and forbidden SOP decisions fail-closed when providers or the
  approval channel are unavailable.

### Exit gate

- Five uninterrupted trading days.
- At least one real end-to-end material macro case.
- Continuous process and per-tenant liveness.
- No unexpected dead-man alert.
- No duplicate delivery or orphan agent.
- Rollback within 60 seconds.
- Exact execution and evidence lineage available for every delivered claim.
- Zero false recovery attribution, duplicate action, or unauthorized command.
- Colima automatic recovery passes a controlled drill without operator help
  before it is credited as automatic recovery.
- Livewire targeted data repair passes integrity, freshness, and coverage
  postconditions before automatic authority is considered.
- Resource alerts are sustained, deduplicated, dependency-aware, and do not
  create an agent fan-out during host pressure.

## Phase 5: ecosystem plugin expansion

**Gate:** deferred until real usage data from P4 exists. Nothing in this phase
is scheduled while the program has two teams and one author.

### Objective

Prove that Helium is an ecosystem harness rather than a macro-specific runner.

### Candidate teams

- fundamental research;
- options and market-structure research;
- release and compatibility analysis; and
- document production.

Macro and operations are the two reference teams: macro proves causal research
and evidence delivery; operations proves continuous observation, typed actions,
and safe recovery. Later teams reuse both contracts rather than inventing new
execution paths.

### Plugin package contract

Each team package owns:

- event adapters;
- roles and capability requirements;
- task graph templates;
- domain tools;
- artifact and claim schemas;
- verification policy;
- evaluations; and
- delivery policy.

It does not own model selection or modify core.

Mutating team packages additionally own their component adapters, SOPs,
preconditions, postconditions, and evaluation fixtures. They cannot grant
authority outside the core policy contract.

### Exit gate

- Install or remove a team package without core changes, proven the same way a
  provider is: run `pnpm remove` and then `pnpm add` for the team package, and
  require every command to exit 0 **and**
  `git diff --name-only -- packages/core plugins/helium` to print nothing.
- A new one-file team manifest is validated and activated by **one
  non-interactive command**, with zero interactive prompts, leaving
  `git diff --name-only -- packages/core plugins/helium` empty, inside a
  wall-clock ceiling of 120 s — **`PROVISIONAL`** (parameter P-3, pending
  operator ratification). The former "within 30 minutes" figure is withdrawn:
  it measured operator typing speed, and a slow morning cannot falsify a
  design.
- A bad team remains isolated and raises per-tenant health.
- At least two non-macro teams run through the same durable kernel.

## Phase 6: evaluated evolution

**Gate:** deferred until real usage data exists. Its exit gate needs a
trajectory corpus that this system does not yet produce, and weighted
capability scoring and the full effort evaluation are gated behind the same
condition.

### Objective

Let the harness learn from production without allowing uncontrolled
self-modification.

### Work

- Convert trajectories and outcomes into offline evaluation cases.
- Detect capability regressions and routing drift.
- Generate candidate prompt, skill, model-profile, and routing changes.
- Validate candidates against task, safety, retention, and adversarial suites.
- Promote through normal branches, review, CI, and tagged releases.
- Keep permissions, approval rules, audit policy, and safety gates outside the
  self-modifiable surface.

### Exit gate

- Every promoted change has reproducible before/after evaluation evidence.
- No production run changes the active safety root or routing policy directly.
- Rollback restores both code and compatible policy/catalog snapshots.

## Cross-phase contract suites

### Core neutrality

- no production provider/model names in core source or schemas;
- fake-provider full suite;
- provider install/remove proven by `pnpm remove` then `pnpm add` for each of
  the two provider packages, with every command exiting 0 and
  `git diff --name-only -- packages/core plugins/helium` printing nothing;
- exact execution audit retained.

### Isolation

- undeclared tool denial;
- undeclared path denial;
- global setting and MCP denial;
- environment-secret isolation;
- mutation fail-closed;
- one execution-boundary conformance suite, run against every executor class;
- declared `isolationClass` per executor, and no task admitted to an executor
  whose class does not permit it.

### Durability

- event-log replay;
- task and message idempotency;
- budget idempotency;
- crash matrix;
- cancellation and orphan detection;
- delivery reconciliation: write-ahead, at most one active lease, no blind
  retry, idempotent or effectively-once where the target supports it, and a
  crash-reconcilable `uncertain` where it does not.

### Team quality

- evidence provenance;
- contradiction handling;
- new-information measurement;
- schema fidelity;
- control-versus-team comparison;
- provider-degradation fallback.

### Topology and verification evidence

- sensors cannot invoke providers;
- agents cannot advance controller state or delivery directly;
- provider/model/effort identity appears only at the provider edge and audit
  snapshot;
- every accepted material claim references a policy-complete evidence bundle;
- artifact hashes, schema versions, freshness, producer, consumer, and replay
  identity survive restart;
- `PLANNED`, `PARTIAL`, `PROVEN`, `FAILED`, and `BLOCKED` remain distinct;
- a renderer cannot add or promote factual claims; and
- every agent-capable node has an autonomy decision against a deterministic
  baseline plus a human-takeover rule.

### Operations safety

- observation freshness and parser-drift classification;
- fixture conformance to the `Observation` schema;
- dependency correlation and inhibition;
- SOP schema and script-identity enforcement;
- signed authority manifest enforcement, including refusal of an unlisted
  digest and of an unlisted `auto`;
- authority fail-closed behavior;
- dual-controller exclusion under the fake-launchctl contract, including the
  competing-label probe and the handoff/rollback order;
- action lease exclusivity and recovery-budget accounting;
- write-ahead intent with a pre-action baseline, `not-needed` termination, and
  uncertain-side-effect reconciliation;
- command-versus-postcondition disagreement;
- operator and external recovery attribution;
- host-pressure admission control; and
- model-provider outage during an active incident, including
  `quota-exhausted`.

## Risk register

| Risk                                                         | Consequence                                                               | Control                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Provider permissions are approval-only                       | Agents gain undeclared capability                                         | Certified provider isolation contracts                                                                                                    |
| Model names leak into core                                   | Plugin architecture collapses into switches                               | Core neutrality guard and fake-provider suite                                                                                             |
| Capability scores become reputation scores                   | Selector makes unjustified choices                                        | Scoring deferred; v1 is a hard filter over opaque targets plus configured preference and ordered fallback                                 |
| Quota exhaustion is read as capability or as a generic error | A healthy target is demoted, or retries burn the remaining session window | `quota-exhausted` with `retryAfter` as a dynamic availability state from P0                                                               |
| In-process subagents inherit parent provider, model, and cwd | Isolation claims are false one layer below the certified boundary         | Declared `isolationClass` per executor, a dedicated out-of-process executor for subscription targets, and one conformance harness from P0 |
| Unsigned SOP YAML grants itself `auto`                       | Unauthorized configuration escalation                                     | Signed authority manifest; unlisted digest and unlisted `auto` refused. Does not claim to resist same-UID host compromise                 |
| Two controllers own the same component                       | Duplicate production mutation                                             | `mutationOwner`, competing-launchd-label probe, ordered handoff and rollback, fail-closed on unverifiable ownership                       |
| An action is credited for a recovery already in progress     | False automation credit feeds the promotion gate it is meant to inform    | Pre-action baseline; `not-needed` termination; `uncertain` only for unclear attribution                                                   |
| Cross-reference becomes majority vote                        | Shared error appears trustworthy                                          | Claim comparator and fresh-evidence adjudication                                                                                          |
| Shared workspace creates conflicts                           | Corruption and information leakage                                        | Private workspaces and immutable artifacts                                                                                                |
| Manager becomes bottleneck                                   | Bad decomposition limits the team                                         | Deterministic DAG validation and independent verifier                                                                                     |
| Agent spawning runs away                                     | Cost and latency explosion                                                | Depth, count, time, token, and monetary budgets                                                                                           |
| Restart duplicates work                                      | Duplicate side effects and inconsistent state                             | Append-only state, leases, idempotency, reconciliation                                                                                    |
| Text runbook or script drifts from production                | Automation executes an obsolete target                                    | Versioned component registry, exact script identity, preflight and postconditions                                                         |
| Parent outage creates child recovery storm                   | Controllers amplify a Colima, database, or mount failure                  | Dependency correlation, inhibition, recovery budget                                                                                       |
| Command exit is treated as recovery                          | False green or false critical state                                       | Independent postcondition grace window and reconciliation                                                                                 |
| Operator and agent act concurrently                          | Duplicate mutation or false attribution                                   | Durable operator event, action lease, supersession rules                                                                                  |
| Agent or document self-reports success                       | Demo state is mistaken for proof                                          | Evidence manifest, independent verifier, and status vocabulary                                                                            |
| Three models repeat the same unsupported claim               | False consensus looks reliable                                            | Claim lineage, source independence, and fresh verification                                                                                |
| Topology drifts across reference teams                       | Safety gates become optional conventions                                  | One normative topology plus conformance contracts                                                                                         |
| Resource incident spawns more agents                         | Helium worsens memory or CPU pressure                                     | Host-native collector and admission control before analysis                                                                               |
| Log content instructs the agent to mutate                    | Prompt injection reaches operations                                       | Logs are untrusted artifacts; no generic shell; eligible SOP IDs only                                                                     |
| Experimental DSH API changes                                 | Production breakage                                                       | Pin, contract suite, adapters, no unpublished dependency                                                                                  |
| V1 and v2 drift                                              | Rollback becomes unsafe                                                   | Frozen compatibility adapter and dual-path tests                                                                                          |

## PR and release discipline

Recommended PR sequence:

1. Documentation, program review, adjudication, and this revision
2. P0 execution and audit hardening, including the execution-boundary
   conformance harness and `quota-exhausted`
3. Provider-neutral contracts, fake provider, opaque target registry, and the
   thin selector
4. V1 compatibility adapter
5. Durable case/task/artifact kernel (general mailbox deferred)
6. DSH subagent integration as a low-isolation executor class, plus the
   out-of-process subscription executor and recovery
7. Operations contracts, fake executor, signed authority manifest,
   dual-controller exclusion, and adversarial fixtures
8. Host collector, component registry, and Ops observe-only plugin
9. Macro shadow team and Ops suggest-only
10. Team admission enforcement (P3.5)
11. Separate production canaries and promotion ladders
12. Ecosystem team plugins, once the P5 gate opens

Each PR must be independently green and reversible. Merge commits or the
repository's established PR convention preserve drill and release history.
After merge, local `master` is fetched and aligned to the remote merge commit.

## Immediate next action

Do not deploy during AC#1. The adjudicated mainline is:

1. **Land one docs-only PR**: the seven blockers, XDOC-8, the Phase 0 snippet
   errors (IMPL-1/2/3), and the defer decisions recorded in this revision.
   Nothing in it touches code or the mini. Committing the review and the
   adjudication alongside it also closes the evidence-trail gap, since the
   individual reviewer reports were never preserved and the consolidated
   summary was untracked.
2. **Update and resync the Phase 0 handover**
   (`docs/codex-handoffs/2026-08-26-helium-multi-agent-phase0-claude.md`, on
   `feat/multi-agent-phase0`), which stays paused until step 1 lands.
3. **Execute full Phase 0, including `quota-exhausted`.**

The first Phase 0 code change is now the reusable execution-boundary
conformance harness: an executable failing contract for the current senior
isolation gap, written so that every later executor class inherits it. It is
deliberately not generic over an `Executor` type, which does not exist until
P1, and it is not a new multi-agent or Ops feature. Operations execution begins
only after its named Phase 0, Phase 1, and Phase 2 prerequisites are green.
