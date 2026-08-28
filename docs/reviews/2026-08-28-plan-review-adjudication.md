# Multi-Agent Program Plan Review — Adjudication

_2026-08-28. Decision record adjudicating `docs/reviews/2026-08-28-multi-agent-program-plan-review.md`. Authority: project owner. This document is the canonical input for the docs-only revision of the plan set; where it conflicts with the review, this document wins._

**Program status: `not-ready`.** The design direction is sound; the blockers are unclosed safety contracts and sequencing conflicts, not a wrong architecture. The Claude Phase 0 handoff (`docs/codex-handoffs/2026-08-26-helium-multi-agent-phase0-claude.md`) is **paused** until this docs-only revision lands and the handover is resynced.

## D1 — Blocker adjudications (all seven accepted, with corrections)

| ID     | Ruling                                               | Correction / sharpening                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-1 | Accepted                                             | Review over-attributes to DSH. The DSH subagent seam itself supports multiple named providers and out-of-process providers; the actual defect is that MA implementation Task 16 (`docs/plans/2026-08-25-helium-multi-agent-implementation.md:1133`) hardcodes `"spawn"` as the universal execution path. DSH in-process becomes one **low-isolation Executor class**, never the unified path for all targets. See D2. |
| ARCH-2 | Accepted                                             | Master plan (`docs/plans/2026-08-25-helium-multi-agent-master-plan.md:113`) demands a P0 EvidenceManifest but the schema only ships in P1. Freeze a P0 template **now**. For deterministic assertions the verifier is a **command + version + output hash** — never a model, never a pretend second human.                                                                                                            |
| ARCH-3 | Accepted                                             | `quota-exhausted` and `retryAfter` enter **P0** vocabulary. Quota is a **dynamic provider-availability state**, not a static capability score.                                                                                                                                                                                                                                                                        |
| OPS-1  | Accepted — critical gate before any `auto` authority | Signed authority manifest for SOP YAML is the right mechanism, but state the threat model explicitly: it prevents **unauthorized configuration escalation**; it does **not** claim to resist full same-UID host compromise.                                                                                                                                                                                           |
| OPS-2  | Accepted — the most important Ops blocker            | Prose ("never two controllers") is insufficient. Must specify: `mutationOwner`, a competing-launchd-label probe, handoff/rollback ordering, and a fake-launchctl test contract. Controller precondition is fail-closed: unverifiable ownership ⇒ refuse mutation.                                                                                                                                                     |
| OPS-3  | Accepted                                             | The write-ahead action intent must capture a **pre-action baseline**. If the postcondition already holds at baseline, the action terminates as `superseded` / `not-needed` (no automation credit). `uncertain` is reserved for genuinely unclear attribution only.                                                                                                                                                    |
| XDOC-1 | Accepted                                             | Split Ops Task 13: alert grouping stays in **P2.5a**; team admission enforcement plus Task 15 move to a new **P3.5** after the team controller exists.                                                                                                                                                                                                                                                                |

**XDOC-8 also stands**: the Colima fixture test (`docs/plans/2026-08-25-helium-ops-agent-implementation.md:60`) currently proves only "an array exists" (`expect.any(Array)`); it must validate the fixture against the (future) `ObservationSchema`, schema-first, or it is a structural false-green.

## D2 — ARCH-1 precise interpretation

Grounding (pinned rc docs; verify before citing elsewhere):

- The DSH subagent seam is provider-decided — current process, another process, or a future transport (`node_modules/.pnpm/@deepseek-ai+dsh-subagent@0.1.1-rc.2_*/node_modules/@deepseek-ai/dsh-subagent/README.md:5`) — and multiple named providers may coexist behind that contract (same README, line 7).
- The current in-process driver inherits parent provider, model, and working-directory lineage (`node_modules/.pnpm/@deepseek-ai+dsh-subagent-in-process-driver@0.1.1-rc.2_*/node_modules/@deepseek-ai/dsh-subagent-in-process-driver/README.md:19`).

Therefore:

1. **Keep** the DSH lifecycle seam.
2. **Stop** treating spawn (in-process) as the default implementation for all execution targets.
3. Every provider executor **declares an `isolationClass`** and passes the **same conformance suite**.
4. Claude / Codex subscription targets use a dedicated **out-of-process executor**.
5. The DSH in-process target only receives tasks its isolation class permits.

Sequencing fix for the review's own recommendation: the formal `Executor` interface does not exist until P1 Task 10, so P0 cannot be "generic over Executor". Instead, **P0 builds a reusable execution-boundary conformance harness**; P1's formal Executor inherits that contract.

## D3 — Capability routing: keep the seam, delete the complexity

The review's "delete the capability-routing layer" verdict is **rejected**. Standing product requirements: the harness never knows provider/model names; work is assigned by capability, not model name; Claude / DeepSeek / Codex models and efforts are configurable; Luna-class targets are a configured preference, never a hardcoded role.

Correct simplification: **delete the scoring, not the routing seam.** v1 is a thin selector:

```
WorkOrder capability requirements
  -> isolation / tools / quota / availability hard filter
  -> configured opaque target preference
  -> ordered fallback
  -> ExecutionLease
```

**Deferred** (until real usage data exists): the 31-item capability ontology, confidence intervals, weighted scoring, automatic learning, the full effort-evaluation harness.

**Kept**: opaque target registry; capability tags; isolation class; quota availability; per-role preference/fallback; provider-neutral execution lease.

Effort remains in the provider catalog / admin override; core sees only opaque targets. Ruling reaffirmed: `runClaude` keeps the `allowedTools` field name (no interface rename).

## D4 — Corrections to the review document itself

1. **Subset arithmetic**: "13/46" is wrong. P0 (5) + MA Tasks 6–7 (2) + Ops Tasks 1–8 (8) + Ops Tasks 9–12, 18 (5) = **20/46**.
2. **"Exactly-once" is forbidden vocabulary.** SMTP success followed by crash-before-outcome-append is still indeterminate; arbitrary external scripts cannot be made exactly-once. Correct property set: **write-ahead; at-most-one active lease; no blind retry; idempotent / effectively-once where the target supports it; otherwise crash-reconcilable `uncertain`.**
3. **Evidence-trail gap**: the four reviewer reports were not individually preserved — only the consolidated summary exists, and it was untracked (invisible to the Phase 0 worktree). Committing the review + this adjudication in the docs PR closes this.

## D5 — Revised mainline

1. **Docs-only PR**: fix the 7 blockers, XDOC-8, the Phase 0 snippet errors (IMPL-1/2/3), and record the defer decisions above as a master-plan revision.
2. Update and resync the Phase 0 handover.
3. Execute full P0, including `quota-exhausted`.
4. Minimal model-blind core: WorkOrder, AgentResult, execution snapshot, thin selector, Executor registry + conformance.
5. Deterministic Ops A+B and the observe-only collector first.
6. Minimal true multi-agent: durable task DAG, isolated identities, artifact handoff, claim comparator, independent verifier. General mailbox deferred.
7. Weighted capability scoring, full effort evaluation, P5/P6 — only after real usage data exists.

Scale warning stands (46 tasks, 233 distinct planned file paths — heavy phasing required), but the reduction must never come from deleting the model-blind capability seam.
