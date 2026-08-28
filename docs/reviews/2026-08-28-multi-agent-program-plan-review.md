# Multi-Agent + Ops Agent Program Plan Review

**Date:** 2026-08-28

_Adjudicated 2026-08-28 by the project owner — see `2026-08-28-plan-review-adjudication.md`. That document is authoritative where it conflicts with this one. Program status ruled `not-ready`. The "delete capability routing" recommendation in §4 was REJECTED in favor of keeping the routing seam as a thin selector (adjudication D3). Three self-errors in this review were corrected in place: the 80% subset arithmetic (§4), the "exactly-once" semantics claims (§4), and the evidence-trail note (§6)._

**Scope:** the seven planning documents of the v2 program —
`2026-08-25-helium-multi-agent-{master-plan,design,implementation}.md`,
`2026-08-25-helium-ops-agent-{design,implementation}.md`,
`2026-08-25-provider-effort-selection-{design,implementation}.md` —
reviewed against the repository at `a1801ec` (v0.1.5 delivered, AC#1 window
open through 2026-08-31, zero v2 code).

**Method:** four independent reviewers (architecture, ops safety, code-level
feasibility, cross-document consistency + over-engineering), each required to
cite file:line evidence for every finding. The orchestrator spot-checked the
highest-severity claims against the primary sources before accepting them.
Finding IDs (`ARCH-n`, `OPS-n`, `IMPL-n`, `XDOC-n`) are stable references into
the per-reviewer reports.

**Verdict up front:** the plan set is buildable and its safety instincts are
right, but it has 7 blockers that must be settled **on paper, before the first
Phase 0 test is authored** — every one is a documentation edit, not code — and
roughly a third of the program (capability scoring, effort selection, team
mailbox, P5 marketplace, P6 self-evolution) is fleet-scale machinery that a
one-person, one-machine, two-provider system should defer or cut.

---

## 1. What the review confirmed is sound

- **Phase 0 is real work against real bugs.** All five claimed v1 defects were
  verified in source: `claude.ts:61-63` has no `--tools`/`--strict-mcp-config`
  /`--setting-sources`; `index.ts:53` runs senior in `process.cwd()` with one
  static all-tools MCP config; `mcp/selection.ts:41-43` silently drops unknown
  tools (locked in by a test asserting exactly that); `delivery.ts:172→182`
  sends SMTP before the JSONL append its own header comment promises comes
  first; invalid tenants vanish from heartbeats (`runtime.ts:151-160`).
  Paths 30/30, commands 12/12, baseline `pnpm test` 161/161 green.
- **The plans are unusually well grounded.** The DSH subagent API claims in MA
  Task 16 match the installed package's real `.d.ts` field-for-field.
- **The Ops architecture's hard parts are right:** deterministic path genuinely
  outside DSH/Colima, eligible-SOP-ID is a real server-side filter (not trusted
  ID emission), approvals are Ed25519-signed with an off-mini key, the executor
  is exact-argv with no shell, and the attribution vocabulary separates
  automatic/operator/external recovery. Observe-only and suggest-only stages
  are safe regardless of every finding below.
- **Worst-case damage from a fully compromised model output is small and
  correctly bounded** — one certified script, one schema-validated argv, one
  attempt, one component. The larger blast radius does not require compromising
  the model at all; it requires writing one YAML file (OPS-1) or forgetting one
  launchd label (OPS-2).

## 2. Blockers (fix in the documents before Phase 0 code)

| ID         | One-line statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fix cost                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ARCH-1** | Phase 2's execution plane — DSH **in-process** subagents — has filtered-inheritance semantics (shared `process.env`, inherited workspace/model, parent tool composition joined before the child filter; `inheritsParentContext` is "descriptive rather than enforceable" per the package README). This is the v1 `--allowedTools` defect recurring one layer down, with no adversarial gate, and the in-process seam resolves to the DSH-configured model so it cannot reach the Claude subscription target the router selects. | Add `isolation_class` to the execution-target contract; extend program rule 3 to "each execution boundary"; write the Phase 0 adversarial contract generically over `Executor`.     |
| **ARCH-2** | Master plan requires an `EvidenceManifest` at every phase exit including P0; the schema is a Phase 1 Task 7 deliverable. P0's exit artifact is undefined when required, and the solo operator is both author and verifier.                                                                                                                                                                                                                                                                                                      | Define a frozen hand-writable P0 manifest template; state that a manifest's verifier for deterministic assertions is a named command with hashed output, never a model.             |
| **ARCH-3** | The highest-frequency real failure — Claude subscription session-window exhaustion (already broke two real dispatches) — has no vocabulary anywhere: no failure class, no retry-after, no quota dimension; `classify()` buckets it as `error`. Budgets are denominated in dollars/tokens a flat-rate subscription cannot report.                                                                                                                                                                                                | Add failure class `quota-exhausted` with opaque `retryAfter`; add `availability.quota` capability dimension; emit the class in Phase 0 while `classify()` is already being touched. |
| **OPS-1**  | The SOP YAML that carries `authority` is the only unsigned link in an otherwise cryptographically pinned chain — a file write elevates `approve`→`auto`. The registry rule meant to prevent it ("authority changes without reviewed configuration history", design:363) cannot be implemented by the loader that must enforce it.                                                                                                                                                                                               | Signed authority manifest (`{sopId, version, digest, authority, certificationState}`, same off-mini Ed25519 key); `opsd` refuses unlisted digests and unlisted `auto`.              |
| **OPS-2**  | "Never two restart controllers" is stated 3× and specified 0×. The legacy watchdog is an independent launchd job outside every lease/lock; the transfer has no procedure, probe, or test — the one crash-matrix cell that produces a real duplicate production mutation.                                                                                                                                                                                                                                                        | Required `mutationOwner` per component; controller-dimension precondition that fails closed when a competing launchd label is loaded; Task 16 certification field + Task 17 case.   |
| **OPS-3**  | Exit-0 + passing postconditions + no _voluntary_ operator record ⇒ automation credited. No pre-action postcondition baseline exists, so "already recovering" is invisible — false automation credit feeds the very promotion gate designed to stop on it.                                                                                                                                                                                                                                                                       | Mandatory pre-action postcondition baseline in the write-ahead intent; already-passing baseline ⇒ `uncertain`, never `succeeded`.                                                   |
| **XDOC-1** | Circular phase dependency: Ops Task 13 modifies `plugins/helium/src/team-controller.ts`, created only in MA **Phase 3** Task 19; Ops Task 15 requires MA Task 18 (also P3). P2.5 as scheduled cannot complete, and its exit gate "host pressure prevents team fan-out" tests a scheduler that doesn't exist yet.                                                                                                                                                                                                                | Split P2.5 into P2.5a (Ops Phases A+B, genuinely pre-P3) and P3.5 (Ops Tasks 13+15); move the fan-out gate with it.                                                                 |

Two more findings sit just below blocker and belong in the same pre-Phase-0
edit pass because they silently invalidate later gates:

- **XDOC-8** — the frozen Colima fixture, the sole encoding of the production
  incident this program exists to prevent, does not conform to the
  `Observation` schema (`state: "recovery_exhausted"` / `"healthy"` vs enum
  `ok|degraded|failed|unknown`; `source` is not a field), and its contract
  asserts only `expect.any(Array)`. It will pass CI forever while proving
  nothing. Fix the fixture to hold real `Observation[]` or rename the key
  `rawSamples`; delete the brittle `toHaveLength(6)` assertion.
- **XDOC-2/XDOC-3 (= ARCH-9)** — two P1/P2 exit requirements have no
  implementing task anywhere: `AgentResult` has no typed `executionSnapshot`
  field (P1 gate "exact execution snapshot" lands in an uninterpreted
  `runtimeMetadata` bag), and the immutable artifact store — the sole legal
  inter-agent channel and a named crash-matrix point — has no design section
  and no task. Add a typed snapshot to MA Task 7 and one artifact-store task
  to Phase 2 before the mailbox task.

## 3. Major findings accepted (fix before the phase that hits them)

**Before Phase 0 starts (trivial edits):**

- IMPL-1 — MA Task 3's red-test example uses `thesis_write` as a mutating
  tool; it is `mutating: false` by explicit design with a locked-in test.
  Use `argon_rescan` / `argon_ai_analysis` instead.
- IMPL-2 — Task 3 must state that the existing "silently drops" test is
  _replaced_, not extended.
- IMPL-3/XDOC-15 — `runClaude()` field name diverges (`allowedTools` vs
  `tools`) exactly at the seam where the effort plan resumes.
  **Adjudicated: keep Phase 0's `allowedTools`** (no call-site churn; the
  effort plan promised to preserve the Phase 0 interface) and fix the effort
  plan's snippet.
- IMPL-4 — the effort-selection plan is reachable only from its own
  preconditions; add a forward pointer in the MA plan and a master-plan line.
  (Superseded if the effort plan is deferred per §4.)

**Before Phase 1:**

- ARCH-7/XDOC-6 — router is P3 in the master plan, P1 in the implementation,
  and the master plan's own P1 gate presupposes routing. Adjudicated: P1 =
  hard-filter-only router; P3 = scoring (see §4, which then defers scoring
  entirely).
- ARCH-8 — the neutrality guard's two word lists disagree (`claude-max` vs
  bare `claude`, the latter failing today on `core/src/mcp/server.ts:3`), and
  the scan cannot see structural leakage: core owns an MCP stdio server (a
  transport) and domain tool modules `apex.ts`/`argon.ts`/`livewire.ts` that
  criterion 14 bans, with no phase moving them. Unify the word list; schedule
  the moves or drop the clauses; prove neutrality with **two** fake providers
  of different economics (token-priced vs flat-rate-with-quota).
- ARCH-6 — the v1 production lane structurally violates the delivery-gate
  evidence rule and rule 13 with no written exemption. Add a named, versioned,
  expiring exemption clause.
- ARCH-15 — split "replay" into `state-replay` (control plane, required) vs
  `evidence-reacquisition` (re-fetch + re-verify); model-call re-execution is
  a diagnostic, not an evidence stage.
- XDOC-4 — `WorkOrder.requires` has two incompatible shapes (`high` vs
  `{min: 0.8, weight: 1}`); the implementation's numeric form wins.
- XDOC-5 — `CapabilityContract` and `RoutingPolicy` are named P1 deliverables
  and topology nodes that no task defines; define or strike.
- XDOC-12 — master plan's 11-field manifest vs implementation's 8-field
  rejection test; extend the test or trim the list.

**Before Phase 2:**

- ARCH-10/XDOC-7/XDOC-17 — three different things are called a lease with
  contradictory purity/exclusivity requirements. Name them distinctly:
  `ExecutionLease` in-process; `TaskLease` event-log CAS; `ActionLease` the
  only cross-process (OS-level) one. The router stays pure; reservation moves
  to the composition layer.
- ARCH-11 — mailbox semantics contradict themselves (redeliver-unacked vs
  fail-loud-on-duplicate-ack). At-least-once + idempotent consumers +
  duplicate ack is a no-op. (Moot if the mailbox is cut per §4.)
- ARCH-4/XDOC-14 — §5.5 renders the topology three times inconsistently
  (mermaid routes ops postconditions into the research verification node; the
  prose chain never reaches it; the text topology has no ops branch). Make the
  text topology normative, demote the mermaid to illustrative, split V into
  V-agent/V-ops, add contract rows for the four ops nodes.
- ARCH-5 — the topology guard arrives in P3, after P2/P2.5 are built. Move it
  to P1 as a structural check (sensor context type without executor member +
  import-graph lint), not a late behavioral test.
- XDOC-9 — three terminal vocabularies for action/incident outcomes across two
  documents; standardize on the five-value §6.5 set and label which states are
  action-level vs incident-level.
- XDOC-10 — `observe`/`auto`/`approve` name both SOP authorities and runtime
  modes with different semantics; rename the modes (`collect | propose |
gated | auto`).
- XDOC-11 — the 7-day observe window is assigned to three different phases;
  one home: P2.5 = code + fixtures, no install; P4 = install + 7d observe +
  7d suggest + first `auto` SOP.

**Before Phase 2.5 (Ops specifics):**

- OPS-4 — no durable spawn record: append `execution-started` (PID, PGID,
  boot ID) before `spawn` returns; reconcile by PGID.
- OPS-5/XDOC-9 — `missing receipt → external-recovery` contradicts the
  design's own definition; split on intent presence (`intent recorded →
uncertain`).
- OPS-6 — `CheckRef` is a dangling type: postconditions, the load-bearing
  safety object, have no schema, registry, task, or fixture; only 2 of ~9
  components have even prose postconditions. Add `CheckDefinition` +
  `ops/checks/*.yaml` + at least one business check per mutating SOP.
- OPS-7 — circuit breakers appear once and are never specified; all numeric
  bounds are TBD; "one `auto` SOP at a time" has no registry check. Add the
  two registry rules and a numeric default for every bound.
- OPS-8 — "sole event-log writer" asserted 3×, enforced 0×; `opsd` takes an
  exclusive startup lock and exits if held.
- OPS-9 — the incident lead's selectable set must be the **approval-required**
  eligible set; ambiguity escalation routes to the operator, never the lead.
- OPS-10 — `opsd`'s privilege level is undefined; state: LaunchAgent under the
  operator UID, no escalation, elevation-requiring SOPs are `forbidden`.
- OPS-14 — the ops crash matrix is named 3× and enumerated 0×; write it as a
  table with a verdict per cell (this exercise is what surfaced OPS-4/5).
- OPS-11/12/13/15 (minor) — `unknown` pre/postcondition semantics; mandatory
  `maintenance` window for mutating `auto` SOPs on a trading host; local-
  filesystem assertion for the lock dir; grace-window anchored to the durable
  receipt's UTC timestamp.
- OPS-16 — two citation errors in the prior validation doc
  (`master-plan:369`, `design:38`) point at the wrong lines; that is how OPS-2
  survived the earlier pass.

**Cross-cutting:**

- ARCH-13 — the "measured lift vs deterministic baseline" autonomy rule is
  unfalsifiable for research nodes; scope it to mutating/ops nodes, and for
  research nodes the baseline is the named v1 control run.
- ARCH-14/XDOC-20 — the adjudicator is one clause, contradicts "evidence
  acceptance is deterministic", and exists in no file list. Make adjudication
  deterministic-by-default (re-fetched > fresher > more independent; no
  dominance ⇒ `PARTIAL` with both positions); a model may draft the record
  but cannot set its status.
- ARCH-18 — P3/P4 stack unbounded market-calendar waits; allow a frozen
  historical-event drill (`scope: drill`) as substitute evidence.
- ARCH-16/17, XDOC-16/18/19 — minor wording/naming fixes as recorded.

## 4. Scale verdict: defer/cut list

v1 measured: 32 source files, ~4k LOC, 168 tests. The full plan set: 46 tasks,
~200 new files, ~9k source + ~12k test LOC, 700-900 tests, plus ≈4 weeks of
serialized pure observation windows — **6-12 months of one person's part-time
capacity. Not survivable as sequenced.**

| Mechanism                                                                                                                                                                                                                        | Verdict                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 in full; write-ahead delivery; per-tenant liveness; neutrality guard                                                                                                                                                     | **KEEP**                                                                                                                                  |
| Ops: opsd outside Colima/DSH; dependency correlation/inhibition; postconditions + attribution; write-ahead intent + action lease + budgets; exact-argv executor; component lock; admission control; append-only ops log + replay | **KEEP** (this is the safety load-bearing core)                                                                                           |
| Cross-reference comparator (agreement/contradiction/unique evidence)                                                                                                                                                             | **KEEP**                                                                                                                                  |
| Catalog/size caps (32-target, bounded file counts)                                                                                                                                                                               | **KEEP** (free)                                                                                                                           |
| Capability ontology (~31 leaves)                                                                                                                                                                                                 | **DEFER → P5**; flat string set suffices                                                                                                  |
| Measured capability scores + confidence intervals                                                                                                                                                                                | **CUT** — n from a session-capped subscription makes a CI decoration that launders a guess into a number                                  |
| Weighted scoring router + preferences + tie-breaks                                                                                                                                                                               | **DEFER → P5**; keep hard filtering only                                                                                                  |
| Budget reservation inside routing                                                                                                                                                                                                | **CUT** — charge on completion from the ledger                                                                                            |
| Exact-target override machinery                                                                                                                                                                                                  | **DEFER** — with scoring gone, pinning a target is the normal path                                                                        |
| Entire provider-effort-selection plan (8 tasks)                                                                                                                                                                                  | **DEFER → after P4** — routing optimisation for a router with nothing to choose between                                                   |
| Evidence three-layer abstraction (Bundle/Ledger/Manifest + assertion-class policy engine)                                                                                                                                        | **CUT the abstraction, KEEP the record** — one concrete `AcceptedClaim` row + one `RecoveryEvidence` row deliver every stated gate        |
| Second event-sourced store/reducer for team state                                                                                                                                                                                | **DEFER → P4** — a 9-node DAG in one process needs an idempotent run log                                                                  |
| Durable mailbox (queue-then-ack, redelivery)                                                                                                                                                                                     | **CUT** — no task in either team graph ever sends a sibling message; dependencies + artifact refs are the message                         |
| Standby-controller/boot-identity lock reclaim                                                                                                                                                                                    | **CUT** — launchd `KeepAlive` + stale-lock TTL                                                                                            |
| Ed25519 approval envelope infra                                                                                                                                                                                                  | **DEFER → first `approve`/`auto` SOP (P4)**; keep the fail-closed rule from day one                                                       |
| 4-agent ops team                                                                                                                                                                                                                 | **CUT reporter + incident-lead; DEFER diagnostician + verifier** — incident volume can't measure the lift its own admission rule requires |
| `AutonomyDecisionRecord` runtime engine                                                                                                                                                                                          | **CUT the code, KEEP the rule** — it is a review-time checklist                                                                           |
| `packages/evals` harness                                                                                                                                                                                                         | **DEFER → P4** — its only consumers are deferred                                                                                          |
| Dual runtime modes (`legacy-direct`/`work-order-adapter` flag)                                                                                                                                                                   | **DEFER the flag, KEEP the package move**                                                                                                 |
| P5 ecosystem plugin marketplace contract                                                                                                                                                                                         | **CUT** — two teams, one author, no third party                                                                                           |
| P6 self-evolution                                                                                                                                                                                                                | **CUT** — its exit gate needs a trajectory corpus this system won't produce                                                               |

**The single best simplification:** delete the capability-routing layer (MA
Tasks 8-10 + the effort plan) and resolve an opaque per-role target reference
in the plugin composition root. Core stays model-blind, rule 5 intact; 11 of
46 tasks disappear along with the unfalsifiable P3 exit criterion, while every
safety mechanism is untouched.

**The 80% subset (20 of 46 tasks: P0 Tasks 1-5 (5) + MA Tasks 6-7 (2) + Ops
Tasks 1-8 (8) + Ops Tasks 9-12 and 18 (5) = 20):** MA Phase 0 (Tasks 1-5) → MA
Tasks 6-7 (v1-compat + schemas, with the XDOC-2/XDOC-4 fixes folded in) → Ops
Phases A+B (Tasks 1-8, after the XDOC-8 fixture fix) → Ops Tasks 9-12 + 18
(registry, collector, adapters, reversible observe-only packaging; no install
until AC#1 closes). (These counts describe the plan set **as reviewed**; the
adjudicated revision added Ops Task 7b and split Ops Task 13, so the current
subset is 21 of 48 task units — the authoritative task-ID enumeration lives in
the master plan under "Deferred scope and the near-term subset".) This delivers
isolation, write-ahead delivery and mutation with at-most-one active lease,
no blind retry, and idempotent /
effectively-once handling where the target supports it (otherwise
crash-reconcilable `uncertain`), postcondition-verified recovery, truthful
attribution, deterministic operation with all providers dead, and v1
rollback — and fixes both incidents that actually occurred — while skipping
exactly the parts whose value is unproven and whose gates are unfalsifiable.

**Unfalsifiable program-outcome bullets to reword or drop:** "install or
remove an execution provider without editing core" (no real second provider
plugin is planned anywhere — no DeepSeek provider task exists); "dynamically
route work by measured capability" (no minimum n, no staleness window; nothing
ever reads the stored `sampleCount`); "attach every claimed capability…" (an
unbounded set no test can fail); the P3 quality-advantage gate (no effect
size, one human as the preference metric); the P5 30-minute activation gate
(measures typing speed).

**Adjudication outcome (2026-08-28):** the "delete the capability-routing
layer" recommendation above was REJECTED — see
`2026-08-28-plan-review-adjudication.md` D3. The capability-routing layer is
kept, not deleted; only the scoring/ontology/learning/effort-harness
machinery is deferred. v1 keeps the routing seam as a thin selector: opaque
target registry, capability tags, isolation class, quota availability,
per-role preference/fallback, and a provider-neutral `ExecutionLease`.

## 5. Recommended immediate sequence

1. One documentation PR fixing the 7 blockers + XDOC-8 + the trivial Phase 0
   edits (IMPL-1/2/3), and recording the defer/cut decisions of §4 as a
   master-plan revision. Nothing in it touches code or the mini.
2. Then start Phase 0 Task 1 in the existing worktree
   (`feat/multi-agent-phase0`) with the adversarial contract written
   generically over `Executor` (ARCH-1) and `classify()` gaining
   `quota-exhausted` (ARCH-3) while the file is open.
3. AC#1 closes 2026-08-31; nothing here changes that constraint.

**Adjudication outcome (2026-08-28):** this sequence is superseded by the
revised 7-step mainline in `2026-08-28-plan-review-adjudication.md` D5 (docs
PR → resync Phase 0 handover → execute full P0 → minimal model-blind core →
deterministic Ops A+B + observe-only collector → minimal true multi-agent →
weighted scoring/effort/P5/P6 only after real usage data exists).

## 6. Review credits and evidence trail

Four independent reviews with mandatory file:line citations; orchestrator
spot-checked ARCH-1 (dsh-subagent README), OPS-1 (grep for signing scope),
XDOC-1 (`team-controller.ts` create-vs-modify phases), XDOC-3 (absence of any
artifact task), and XDOC-8 (fixture vs schema enum) against primary sources —
all confirmed. Baseline verification: `pnpm test` 161/161, `pnpm typecheck`
clean, at `a1801ec`.

**Limitation:** the four individual reviewer reports (ARCH/OPS/IMPL/XDOC)
cited above were not preserved as separate files — only this consolidated
summary exists. At review time it was untracked, and therefore invisible to
the Phase 0 worktree; committing this file together with
`2026-08-28-plan-review-adjudication.md` in the docs PR closes that gap.
