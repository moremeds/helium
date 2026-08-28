# Multi-Agent Program Plan Review — Adjudication, Round 2

_2026-08-28. Second decision record, continuing `2026-08-28-plan-review-adjudication.md` (D1–D5). It rules on the three conflicts the round-1 revision surfaced and the five review findings round 1 left unadjudicated. Where this document conflicts with the review, this document wins; where it conflicts with round 1, round 1 wins unless a ruling below says otherwise and gives its reason._

**Two of the three reported conflicts are not conflicts.** That is the headline. R2 and R3 below are recorded as _no change_, with the evidence that closes them, so a later reviewer does not re-file them.

## R1 — Ops Phase B dependency contradiction: **REAL. Extract the primitive into P1.**

`docs/plans/2026-08-25-helium-ops-agent-implementation.md:60` says Phase B (Tasks 5–8) runs in **P2.5a** with a blocking dependency on **MA Phase 2 durable kernel primitives**. D5 puts deterministic Ops before the durable kernel, and `master-plan.md:296` fixes the order `P0 -> P1 -> P2.5a -> P2 -> P3 -> P3.5 -> P4`. A P2.5a row cannot block on P2.

The line contradicts three further authorities inside its own document — `ops-impl:65` ("P2.5a contains only work whose files already exist or are created by this plan"), `ops-impl:70-71` ("Scheduling all of this plan inside a single pre-P3 block was circular; do not restore it"), and `ops-impl:29-30`, which demands MA Tasks 8–10 and 12–15 that the near-term subset at `master-plan:306-309` excludes.

**Four of the five Phase B tasks have no MA Phase 2 dependency at all.** Task 6 builds `ActionLease`, explicitly "distinct from the work-execution `ExecutionLease`" (`ops-impl:747-748`). Task 7 creates `plugins/ops-agent` from scratch on pure `spawn`. Task 7b depends only on Task 7 (`ops-impl:871-872`). Task 8 uses `EvidenceBundle`, defined in **MA Task 7**, which is P1 and in the subset.

Only Task 5 is real, and its dependency is on a **generic append-only event-store primitive** — fsync, hash, snapshot, truncated-line recovery, replay — not on the team kernel. MA Task 13 is merely where that primitive is currently first specified; its own text (`ma-impl:1386`) says it reuses "the same atomic file and hash discipline as existing state", so it is not team-specific either. The architecture already forbids the coupling: `ops-design:543-544` — "The Ops team uses the durable team kernel **but does not sit in the mandatory recovery path**" — and Phase B _is_ that path. `ops-impl:13-15` requires `helium-opsd` to work "when Colima, DSH, or every model provider is unavailable."

**Ruling: option C.** Define the generic append-only event store in **P1, in MA Task 7**, beside `EvidenceBundle`/`EvidenceLedger`. Ops Task 5 and MA Task 13 both consume it. This follows the precedent already set at `ma-impl:833-835` — "Define the generic `EvidenceBundle` and append-only `EvidenceLedger` **here so both Ops Phase 2.5a and research Phase 3 use one contract**." A shared primitive belongs in `packages/core/src/`, not under `src/operations/`.

Rejected: reordering P2 before P2.5a (contradicts D5, and inverts its safety rationale at `master-plan:290-292`); and fixing the table row alone, which leaves `ops-impl:679`/`:687` pointing at a spec file that does not exist at P2.5a, so Phase B fails at its first test run.

**Edits, which must move together:**

1. `ops-impl:60` — blocking dependency becomes `MA Phase 0-1 contracts`, matching Phase A.
2. `ops-impl:679` — "Reuse the **generic append-only event store from MA Task 7**", replacing "the Phase 2 team store's".
3. `ops-impl:687` — drop `team-store.spec.ts` from the regression command; it does not exist at P2.5a.
4. `ops-impl:29-30` — "Phase 0 and Phase 1 Tasks 6-7", matching `master-plan:306-309`.
5. `ma-impl` Task 7 — add the generic event-store module to its Files list and its steps.

**If left unfixed:** an executing agent reading `:29-30` and `:60` literally schedules MA Tasks 8–15 before Ops Phase B, re-inflating the subset from 21 task units to ~29 and rebuilding the exact circularity XDOC-1 was raised to kill.

## R2 — WorkOrder YAML key casing: **NOT A CONFLICT. No change.**

`ma-design:388` writes `min_isolation_class`; `ma-impl:669` writes `minIsolationClass`. These are different artifact kinds, and each is internally consistent:

- `ma-design:379-398` is a **yaml** fence. All five multiword keys are snake_case: `task_class`, `min_isolation_class`, `max_cost`, `max_latency_ms`, `output_schema`.
- `ma-impl:660-675` is a **ts** fence calling `WorkOrderSchema.parse({...})`. The same five keys are camelCase.

A perfect 1:1 correspondence across five keys is evidence of a mapping, not a typo — and **the mapping is documented and already shipped**. `packages/core/src/job.ts:1-5`: "YAML carries human durations and snake_case; `JobSpec` carries milliseconds and camelCase, so nothing downstream re-parses a duration." It is implemented at `job.ts:125` → `:168`, and real files follow it (`jobs/macro-watch.yaml:39`).

"Unifying" either way manufactures a real defect to close a phantom one: camelCase YAML breaks the shipped `job.ts` contract; snake_case TS properties would be inconsistent with every other surface in `packages/core`.

**One clarifying sentence** is added to `ma-design` §6.1 stating the mapping explicitly, so the next reviewer does not re-file this. Nothing else changes.

**Recorded for later, not fixed here:** the P0 evidence-manifest template at `master-plan:205-231` is a yaml fence using camelCase throughout (`manifestVersion`, `recordedAt`, `outputHash`). That is a genuine on-disk artifact and a real inconsistency with the snake_case YAML convention — but it is a different finding from the one reported, and normalising it touches the frozen manifest template that D1/ARCH-2 just fixed. It is listed under **Deferred** below.

## R3 — `superseded` vs `not-needed`: **NOT A CONFLICT. One state. No change.**

The current action-plane terminal set is **six**, stated identically in five places (`ops-design:457-464`, `:503-518`; `ops-impl:224-225`, `:1032-1036`; `master-plan:514-516`): `succeeded`, `failed`, `not-needed`, `uncertain`, `superseded-by-operator`, `external-recovery`.

**The decisive evidence is the diff.** `git show HEAD:docs/plans/2026-08-25-helium-ops-agent-design.md` shows the pre-revision set was **five values, and `superseded-by-operator` was already one of them** — `not-needed` was the only one absent. So OPS-3's "`superseded` / `not-needed`" could not have been proposing `superseded` as new. The slash was two candidate names for one **new** concept: the baseline-already-satisfied case. The word survives exactly where it belongs, as prose inside the `not-needed` definition (`ops-design:513`, "recorded as superseded before execution and earns no automation credit").

XDOC-9 was never about merging the two. `review:146-148` asked to "standardize on the five-value §6.5 set and label which states are action-level vs incident-level" — a separation of the incident plane from the action plane, applied correctly at `ops-impl:220`.

**The two cases are genuinely distinct, and the discriminant is the baseline, not the actor.** The Task 8 attribution matrix (`ops-impl:998-1009`) resolves a `confirmed` operator event two different ways: baseline had a failing postcondition, intent recorded, executor exited nonzero → `superseded-by-operator` (`:1003`); baseline all passing, no intent, not executed → `not-needed`, operator-attributed (`:1008`). `attribution` is a separate field, which is what makes six sufficient rather than seven.

**Ruling: keep one state, `not-needed`. Do not add a seventh** — `ops-impl:1036` already forbids it. Splitting would duplicate the `attribution` field and force every automation-credit exclusion (seven sites) to name two states; any site updated to exclude only one silently readmits false automation credit into the promotion gate, the precise failure OPS-3 exists to prevent.

**Two documentation gaps closed here, neither changing the state count:**

1. **`ActionOutcome` has no type definition.** `master-plan:489` lists it as a named P2.5a deliverable, but Ops Task 4 (`ops-impl:496-561`) defines `SopAuthority`, `ActionSpec`, `CheckDefinition`, `PostconditionSample`, `ActionIntent` — no outcome union. The six values exist only as English prose in five places, so nothing mechanically prevents a seventh from being typed. Add the union to Ops Task 4's contracts, with an exhaustiveness test.
2. `ops-design:536-537` lists "attribution as operator, external, or `not-needed`" — mixing two actors with an action _state_ name, the exact conflation XDOC-9 exists to prevent. Reword to name only actors.

## R4 — ARCH-5, topology guard: **Split it. Structural half to P1.**

Unresolved in the tree, and **made worse by the round-1 revision**. Fixing the order to `P0 -> P1 -> P2.5a -> P2 -> P3` put P2.5a third — and Ops Task 10 (`ops-impl:1204`) creates the collector and every probe, i.e. every sensor in the program. The only test asserting a sensor cannot reach an executor is `contracts/tests/topology-boundary.contract.spec.ts` in **P3** Task 19 (`ma-impl:1932`), a block byte-identical to HEAD. Every sensor now merges two phases before its guard exists. The Ops adversarial suite is not a substitute: its 26-case matrix (`ops-impl:1656-1690`) has no sensor→executor case.

Moving the whole guard to P1 is impossible — its P3 form asserts DAG advancement (MA Task 14) and claim acceptance (MA Task 17), neither of which exists at P1.

**Ruling: split, per the review's actual proposal.** A **structural** half at P1 as new **Task 10b**, and the behavioral half stays in Task 19. The structural half is static and therefore genuinely cheap:

- **Type-level.** The sensor context type exported from core has no executor, provider, lease, or run member — asserted as a compile-time exclusion so adding one breaks `pnpm typecheck`.
- **Import-graph lint.** Walk static imports from every module under `packages/core/src/sensors` and `plugins/ops-agent/src` and fail on transitive reachability of the executor registry, an `Executor` implementation, or a provider adapter.

It lands in P1 — before P2.5a in the corrected order — so it is in force on the day Ops Task 10 is written. Cross-references: `master-plan` Phase 1 exit gate gains a bullet; `ops-impl:1256` (Ops Task 10 Step 4) requires the collector and probes to pass it; `ma-impl:1956-1960` is retitled the behavioral half and must not weaken it.

## R5 — ARCH-6: **Scope rule 13. Grant EX-1 against criterion 16.**

First, a correction to the framing: **ARCH-6's "v1" means Helium release v1**, the deployed `v0.1.5` lane (`README.md:29`), **not the thin selector v1** of D3. The thin selector cannot bypass the canonical topology because the revision made it a canonical node (`ma-design:234`, `:260`); D3 deleted scoring _from_ a node, it did not route around one. Rule 13 is untouched by D3.

Rule 13 is `master-plan:144-145`. The companion is acceptance criterion 16 (`ma-design:866-867`). **No exemption exists anywhere** — a case-insensitive search for `exempt` across all seven plans returns one unrelated hit. The violation is stated plainly two lines below rule 13 itself (`master-plan:149-150`) and extended past P3 by `master-plan:729` ("Keep v1 as immediate fallback" inside Phase 4).

**Ruling: split the remedy, because the two failures are different kinds.**

- **Rule 13 is a wording bug.** Its object is the canonical _team-execution_ topology, which has no node for a pre-WorkOrder legacy runtime. v1 is not a team and produces no WorkOrder. Rescope it to WorkOrder-carrying execution paths. This is a correction, not a loophole: it stays fully binding on every team and every new plugin, which is where the escape risk actually is.
- **Criterion 16 is a real, currently-shipping exposure** and gets a named, versioned, expiring exemption — **EX-1** — so the gap stays visible, attributable and dated rather than defined away. Scoping it away instead would silently declare that today's production emails carry no evidence obligation, which is the exposure the program exists to close.

EX-1's boundary is technical, not prose: `ma-impl:1216-1217` already defines a two-mode flag, and `legacy-direct` **is** the exempted path while `work-order-adapter` is the compliant one. Expiry anchors to that mode plus a hard review date — **not** to the shadow-team promotion gate, because `master-plan:729` keeps v1 alive past it. EX-1 exempts evidence provenance only: write-ahead JSONL before the SMTP side effect, per-tenant liveness, the tool allow-list and the isolation boundary all still bind, and it never extends to a mutating action. While EX-1 stands, criterion 16 may not be reported as `PROVEN` by any document, dashboard, or release.

## R6 — ARCH-8: **One word list. Schedule the moves. Two fakes, both axes.**

**(a) There are five disagreeing word lists, not two** — `ma-impl:599`, `ma-impl:1246`, `ops-impl:323`, `ops-impl:1369`, `ops-impl:1818` — and `git diff` confirms the round-1 revision touched none of them. Two further defects the review did not name: **list E (`ops-impl:1818`) is not a gate at all**, missing the `&& exit 1 || true` suffix every sibling carries, so it prints matches and passes; and it bans the English words `provider`, `model`, `effort` by grep, contradicting `effort-impl:119-122`, which explicitly forbids that ("Do not ban the English word `effort` … enforce the data contract through strict schema tests").

The live leak is confirmed: `packages/core/src/mcp/server.ts:3` contains `claude -p`. List A's `claude-max` misses it — and after Task 6 moves `job.ts` out of core, `claude-max` matches nothing in `packages/core/src` **forever**, a permanently-green assertion.

**Ruling: standardize on bare `claude`, defined once as an exported constant, and collapse all five lists into invocations of the one contract test.** Bare `claude` is the only token catching every production spelling (`claude-max`, `claude-subscription`, `claude-sonnet-5`, `runClaude`, `claude -p`). The objection that it fails today is the argument for it: it fails on exactly one line, a doc comment, and that comment is the leak the narrower list was hiding. Reword the comment; **do not add a file or line allow-list** — an allow-list is how `mcp/server.ts:3` survived four reviewers.

**(b) Structural leakage: schedule the moves.** `packages/core/src` holds `mcp/server.ts` (an MCP stdio transport) and `tools/{apex,argon,livewire}.ts` (three domain modules), which criterion 14 (`ma-design:862-863`) bans. No task in any of the seven plans moves any of them, and no scan can see the problem: lists A/B check `packages/core/src` but carry no domain tokens, while lists C/D/E carry domain tokens but are scoped to `packages/core/src/operations`, a subdirectory the offending files are not in. Dropping criterion 14 would be dishonest — the ban is right, the plan never implemented it. **Fold the moves into Task 6**, already titled "Move v1 provider knowledge into a compatibility package"; these files _are_ v1 provider-and-domain knowledge. `tools/types.ts` and `mcp/selection.ts` stay in core — generic contract and generic filter, no domain or provider name.

**(c) Two fakes, differing on both axes.** The round-1 revision added a second fake (`ma-impl:1147-1149`) but split it on `isolationClass` — the wrong axis for this finding. The two economics are established sharply at `ma-design:737-745`: a flat-rate subscription "cannot report" dollars or tokens, and its exhaustion is `quota-exhausted` + opaque `retryAfter`, never `budget-exhausted`. One fake cannot hold both invariants at once, so the distinction that paragraph establishes has no test that can break it. The concrete regression this permits: core normalizes `quota-exhausted` into `budget-exhausted`, or defaults a missing cost to `0` and treats it as known-zero, and the suite stays green.

**Ruling — and this resolves a collision between two findings.** R7's Gate A1 needs two _installable packages_ to make "install/remove without editing core" falsifiable; ARCH-8 needs two _fakes with different economics_. These are one change: register **exactly two fakes as workspace packages**, differing on **both** axes.

- `fake-metered` — `isolationClass: "process"`; token-priced. Reports `usage.tokens` and `usage.cost`; may terminate `budget-exhausted`; **must never** emit `quota-exhausted`.
- `fake-flat-rate` — `isolationClass: "in-process"`; flat-rate-with-session-quota. Reports **no** cost and **no** tokens (fields absent, not zero); may terminate `quota-exhausted` with opaque `retryAfter`; **must never** emit `budget-exhausted`.

This satisfies the portability gate, the economics-blindness assertions, and preserves the isolation-class coverage round 1 added. `ma-design:496-501` gains a `billing model` field so the distinction is representable in the catalog rather than only in a fixture.

## R7 — The unfalsifiable exit gates: **four live, all replaced.**

Count correction: the review's sentence (`review:254-261`) names **five**; "dynamically route work by measured capability" was already closed by round 1 (`master-plan:97-98`, deferral at `:274-277`). Four remain. All four are held to the standard ARCH-2 already set and that `master-plan:362-363` already meets once at the P0 gate: **a command, its version, and its output hash.**

| Gate                                                                                     | Why it cannot fail today                                                                                                                                              | Replacement                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** install/remove a provider without editing core (`master-plan:95`, `:408`, `:847`) | Nothing installable exists — the only non-production target is an in-tree module (`ma-impl:1087`)                                                                     | `pnpm remove` then `pnpm add` each of the two provider packages from R6(c); pass requires every command exit 0 **and** `git diff --name-only -- packages/core plugins/helium` prints nothing                                                                                                                                |
| **A2** attach every claimed capability to a manifest (`master-plan:113-114`)             | "Every claimed capability" is an open set with no register — no denominator, so nothing can be found missing                                                          | Close the population: `docs/evidence/claims.yaml` registers one id per program-outcome bullet, phase gate, `succeeded` outcome and promotion decision; the contract test re-runs each deterministic claim's command at its pinned version and compares `sha256`. **An empty register fails rather than passing vacuously.** |
| **A3** P3 quality-advantage (`master-plan:682-683`)                                      | "quality **or** information" lets the metric be picked after seeing results; no effect size, no n, no test; "human preference" is one operator who is also the author | One pre-registered primary metric — unsupported-claim rate — on a hashed fixture set frozen **before** the first shadow run. Human preference demoted to descriptive secondary, per ARCH-2's "never a pretend second human"                                                                                                 |
| **A4** P5 30-minute activation (`master-plan:809`)                                       | Measures operator typing speed; a slow morning cannot falsify a design                                                                                                | Measure the **automated** path: one non-interactive command, a wall-clock ceiling, zero interactive prompts, and `git diff --name-only -- packages/core plugins/helium` empty                                                                                                                                               |

`master-plan:808` ("Install or remove a team package without core changes") has A1's identical defect and adopts the same `git diff --name-only` proof.

## R8 — XDOC-11: **two windows, stated as verb lists.**

XDOC-11 is cited by ID nowhere in the plans. Its phase-assignment half was applied; its **"no install" definition half was not**.

The plans use "observe-only" for two mutually incompatible states — P2.5a, where `opsd` is absent from the mini entirely, and P4 Stage 1, where `opsd` **is installed and running** and only mutation is forbidden. No document says which is meant where. Three concrete consequences:

1. **The canonical document carries the weakest wording.** `master-plan:545` says "No production component or host mutation during AC#1." Installing a LaunchAgent is not, on a literal reading, mutating a production _component_, and "host mutation" is undefined. The strong wording exists only in the implementation doc (`ops-impl:27-28`).
2. **Round 1 dropped a caveat.** `review:241-242` scoped the subset as "reversible observe-only packaging; **no install until AC#1 closes**". `master-plan:306-309` now lists "Ops Tasks 9–12 and 18" with no caveat.
3. **The freeze has no end date anywhere in the plan set.** `grep -rn "2026-08-31" docs/` hits only the review. All seven plans say "the active AC#1 observation window", and `ops-impl:1751` requires the installer to refuse "during a **configured** freeze window" — a guard with no value to read.

**Ruling: add a boundary section to `ops-design` stating both windows separately, as verb lists rather than adjectives, and pin the date.** Adjectives ("observe only", "read-only") are what an implementer rationalizes — is `docker ps -a` read-only? is a plist write a mutation? Named verbs are checkable at registration time.

- **Window 1 — pre-install (P2.5a; Ops Tasks 9–12 and 18; the AC#1 freeze, closing 2026-08-31).** The test is **presence**: if it puts a byte on the mini or starts a process there, it is forbidden. Permitted: all code, tests, fixtures and merges; installer/uninstaller runs on a developer machine with `HOME` and the launchd root redirected into a process-local temp directory; reading the mini's already-published artifacts through pre-existing channels. Forbidden without exception: any file written anywhere on the mini, any `launchctl load`/`bootstrap`/`enable` of a `com.helium.opsd*` label, starting any probe or `opsd` process there **including a single manual one-shot run**, any package install or upgrade, any probe executed against the mini from another host, and any Helium deploy to the mini.
- **Window 2 — installed and observing (P4 Stage 1 and Stage 2).** `opsd` **is** installed; the boundary moves from presence to **mutation**. Permitted: the LaunchAgent under the operator UID with no `sudo`; exact-argv, timeout-bounded read-only probes; writes confined to `opsd`'s own declared base directory; emitting observations, incidents, alerts and (Stage 2) proposals. Forbidden: executing any SOP script at any authority including a dry run that invokes the real script; any write outside that base directory; `launchctl` mutation verbs, `docker`/`colima` lifecycle verbs, `kill`/`pkill`, non-`SELECT` SQL, file deletion, any package-manager invocation; claiming or asserting `mutationOwner`; touching an existing watchdog or restart policy; and restarting anything as a side effect of installing `opsd` itself.

Window 2's boundary is enforced as a **deny-list in the executor**: a probe registered with a forbidden verb fails **registration at load time**, not call time. Window 1's is enforced by the installer's freeze-window refusal, whose configured value is the date above.

## Provisional parameters — require operator ratification

Four numbers below are **chosen to make a gate falsifiable, not derived from any measurement or prior decision in this program**. They are written into the plans marked `PROVISIONAL` so no gate stays unfalsifiable in the interim, and they must be ratified or replaced before the phase that consumes them begins.

| #   | Parameter                                                   | Value                                             | Consumed by |
| --- | ----------------------------------------------------------- | ------------------------------------------------- | ----------- |
| P-1 | R7/A3 minimum paired evaluation cases                       | n >= 30                                           | P3          |
| P-2 | R7/A3 required relative reduction in unsupported-claim rate | 20%, at p < 0.05 (two-sided Wilcoxon signed-rank) | P3          |
| P-3 | R7/A4 automated team-activation wall-clock ceiling          | 120 s                                             | P5          |
| P-4 | R5 EX-1 hard expiry date                                    | 2027-02-28                                        | P1 onward   |

## Deferred — found while adjudicating, deliberately not applied here

Each is real and evidenced; none is among the eight items this record was convened to decide, and each expands the docs-only PR beyond its scope.

1. **`README.md:48-69` has drifted from the canonical `ma-design:230-253` Mermaid block** — round 1 updated the design only. Worse, the parity check `2026-08-26-topology-graph-reminder.md:43-48` mandated was never committed (absent from `scripts/`, `.github/`, `contracts/`, `package.json`), so the drift is currently undetectable. **Highest-value deferred item.**
2. **XDOC-10's runtime-mode rename** (`collect | propose | gated | auto`) was never applied, so `observe` simultaneously names an SOP authority (`ops-design:971`), a runtime mode (`ops-impl:1491`) and a rollout stage (`ops-design:886`). Applying it would remove roughly half the ambiguity R8 works around.
3. **The P0 evidence-manifest template's camelCase YAML** (`master-plan:205-231`) against the snake_case YAML convention of the design docs. See R2.
4. **`jobs/macro-watch.yaml:50` ships a camelCase `allowMutations:`** outlier, so the shipped snake_case convention already has one crack.
