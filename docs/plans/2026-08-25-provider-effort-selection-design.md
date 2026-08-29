# Provider Effort Selection Design

**Date:** 2026-08-25

**Status:** Approved

**Revision:** 2026-08-29 — Revision 4 extends the same thin selector to
DeepSeek, Codex, and Claude, with provider-owned submodel catalogs and shared
quota-domain availability. Scoring/learning remains deferred to v2.

**Current availability:** Codex and DeepSeek may be certified now. Claude is
currently quota-exhausted and stays out of live certification and evaluation
until its own preflight publishes an available snapshot. The expected Monday
reset is not itself evidence of recovery.

## Scope tiers

This document is split into two tiers. Everything outside the explicitly marked
deferred section is **v1, in scope now**. The deferred section is preserved
design work that must not be implemented yet.

**v1 — the thin selector:**

```
WorkOrder capability requirements
  -> isolation / tools / quota / availability hard filter
  -> configured opaque target preference
  -> ordered fallback
  -> ExecutionLease
```

Kept in v1: the opaque target registry; capability tags; an `isolationClass` per
target; quota availability as a **dynamic provider-availability state** (the
`quota-exhausted` failure class and opaque provider reset hint enter the
vocabulary at multi-agent Phase 0); provider-owned shared quota domains;
per-role preference and fallback ordering configured in the plugin composition
root; and a provider-neutral `ExecutionLease`.

Effort and model choices live **only** in the provider catalog and the
privileged admin override. Core code never sees a provider or model name — it
sees opaque target references.

Deferred to v2: see
[Deferred (v2)](#deferred-v2--do-not-implement-until-real-usage-data-exists).

## Decision

Reasoning effort is provider-owned execution metadata. It belongs in the
provider catalog, router candidate inventory, execution lease audit snapshot,
and privileged exact-target override. It does not belong in Helium core work
orders, roles, team manifests, or task graphs.

Normal routing selects an execution target by hard-filtering opaque targets and
then applying a configured preference with ordered fallback; the model and
effort behind a target stay at the provider edge. A team asks for capabilities,
latency, cost, and safety constraints; it never asks for `claude-opus-5` at
`xhigh` or any other provider-specific combination.

## Why

The providers do not share one effort vocabulary or one meaning:

- Claude effort support varies by model. Sonnet 5 and Opus 5 support five
  levels, while Haiku 4.5 does not support effort.
- DeepSeek exposes three effective levels and maps some compatibility values
  onto the same underlying level.
- Codex supports model-specific effort sets, while `Ultra` adds subagent
  orchestration rather than only increasing reasoning depth.

A global effort field in a core schema would therefore leak provider semantics,
create false equivalence, and encourage team authors to hard-code execution
choices before Helium has measured them.

## Provider catalog contracts

Each of the three provider plugins owns its native catalog and publishes a
versioned certification snapshot. A native submodel/effort variant becomes an
opaque target only when the current entitlement preflight accepts it. The
snapshot also declares `quotaDomain`, because several submodels may consume the
same subscription window. The catalog is not a cross-provider enum and core
does not inspect it.

- **DeepSeek:** invoked through the DSH in-process low-isolation executor. Its
  plugin owns the available DSH model names and their native effort mapping.
- **Codex:** invoked through a dedicated out-of-process executor. Its plugin
  owns the account-visible Codex models, model-specific effort sets, and exact
  CLI/runtime mapping.
- **Claude:** invoked through a separate dedicated out-of-process executor. Its
  plugin owns Claude model/effort support and organization caps.

The following Claude table is the 2026-08-25 catalog **seed**, not a permanent
entitlement declaration:

The initial Claude subscription catalog is:

| Exact model                 | Invocation alias | Effort options                          | Catalog default |
| --------------------------- | ---------------- | --------------------------------------- | --------------- |
| `claude-haiku-4-5-20251001` | `haiku`          | unsupported                             | none            |
| `claude-sonnet-5`           | `sonnet`         | `low`, `medium`, `high`, `xhigh`, `max` | `high`          |
| `claude-opus-5`             | `opus`           | `low`, `medium`, `high`, `xhigh`, `max` | `high`          |

The provider must reject an effort that the selected model does not advertise.
It must not depend on Claude Code silently clamping an unsupported level.
Organization-level caps and current quota availability must be reflected in
the effective catalog snapshot before routing. If a fresh preflight disagrees
with the seed table, the snapshot wins and the difference is recorded.

Claude's `ultracode` is not an effort value in Helium. It combines `xhigh`
reasoning with dynamic workflow orchestration. Helium owns decomposition,
spawning, budgets, cancellation, and multi-agent state, so `ultracode` is a
separate provider execution mode and is disabled by default.

See [Claude Code model and effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

## Catalog representation

Provider plugins expose their native options at the edge:

```yaml
provider: claude-subscription
catalog_version: <content-hash>
targets:
  - model: claude-haiku-4-5-20251001
    invoke_as: haiku
    quota_domain: claude-subscription-session
    effort:
      supported: false

  - model: claude-sonnet-5
    invoke_as: sonnet
    quota_domain: claude-subscription-session
    effort:
      supported: true
      options: [low, medium, high, xhigh, max]
      default: high

  - model: claude-opus-5
    invoke_as: opus
    quota_domain: claude-subscription-session
    effort:
      supported: true
      options: [low, medium, high, xhigh, max]
      default: high

execution_modes:
  ultracode:
    enabled: false
    reason: provider-owned-agent-orchestration
```

This is a representation example, not a hardcoded universal schema instance.
Codex and DeepSeek publish equivalent native snapshots using their own model
and effort vocabularies.

The provider registry expands or otherwise represents each valid
`(model, effort)` combination as an independent execution target. The core
selector sees only an opaque target reference plus its declared capability tags,
`isolationClass`, entitlement, and current availability state. Measured quality,
latency, reliability, and cost profiles per variant are deferred to v2.

## Routing behavior (v1 thin selector)

1. A work order declares capability and operational requirements only.
2. The selector hard-filters opaque targets on isolation class, tool
   requirements, quota availability, and the current provider-published
   snapshot. When one quota domain is exhausted, its plugin removes every
   affected target together. Core preserves but never parses a provider reset
   hint.
3. Among the surviving targets, the selector takes the configured per-role
   preference, then walks the configured ordered fallback. There is no scoring,
   no weighting, and no tie-break arithmetic.
4. The issued `ExecutionLease` is provider-neutral; it pins an exact provider
   target and effort at the provider edge, outside the core task schema.
5. The provider invokes the selected effort explicitly rather than relying on
   a drifting CLI default.
6. The result records requested and applied effort with the full runtime model
   usage map.

If no target has the static capability required, routing returns
`capability-shortage`. If capable targets exist but are temporarily unavailable,
the controller persists `waiting-for-capacity`. It never silently reduces
effort, changes submodel, or relaxes safety constraints. Preference and fallback
order are configuration, owned by the plugin composition root, never by core.

## Administrator override

A privileged exact-target override may pin both model and effort for:

- deterministic replay;
- provider certification and evaluation;
- incident diagnosis;
- regression comparison; or
- emergency failover.

The override requires a reason and operator identity, is fully audited, and
cannot expand tools, mutations, budget, or workspace access. It disables
fallback: quota exhaustion of the pinned target waits or fails under the
override policy and never selects another target.

## Audit requirements

Every execution snapshot records:

- exact requested model and invocation alias;
- requested effort;
- applied effort or provider-reported equivalent;
- organization cap or fallback, if any;
- complete provider `modelUsage`, including background models;
- provider and CLI version;
- latency, token use, cost metadata, and completion status; and
- the catalog version used by the selection decision (plus the evaluation
  version once v2 evaluations exist);
- quota-domain identity and availability-snapshot version; and
- failed-attempt, fallback-attempt, or capacity-wait linkage.

## Acceptance criteria (v1)

1. Core and team schemas reject `provider`, `model`, and `effort` fields.
2. Provider catalogs validate effort per model.
3. Every provider rejects an effort its selected submodel does not advertise.
4. DeepSeek, Codex, and Claude publish only targets accepted by the current
   entitlement preflight; the historical Claude seed is not routing evidence.
5. Unsupported or capped effort is visible in routing and audit evidence.
6. `ultracode` cannot be selected through the effort field.
7. Selection is reproducible from configuration alone: the same catalog, the
   same availability state, and the same per-role preference and fallback order
   select the same target, with no scored input.
8. Exact-target replay reproduces both model and effort without changing the
   original work order.
9. Exhausting one shared quota domain removes all affected submodels, persists
   and releases the failed attempt, and creates at most one fallback attempt.
10. With no eligible target, the run waits durably without busy polling and one
    availability event resumes exactly one attempt; fake executors prove this
    without burning live quota.

## Deferred (v2) — do not implement until real usage data exists

Everything in this section is preserved design work that is **out of scope**.
Do not build it, do not write tests against it, and do not let a v1 acceptance
criterion depend on it. It unblocks only when real usage data exists — per
adjudication D3 and D5.7.

Deferred mechanisms:

- the 31-item capability ontology (v1 uses a flat set of capability tags);
- measured capability scores and confidence intervals;
- weighted scoring, preference weighting, and tie-break arithmetic (v1 uses a
  configured preference plus an ordered fallback list);
- automatic learning of routing preference from outcomes; and
- the full effort-evaluation harness, kept as deferred task D1 in the
  implementation plan.

Deferred routing behavior — what step 3 of
[Routing behavior](#routing-behavior-v1-thin-selector) becomes in v2:

> Measured model-effort variants compete on quality, latency, reliability,
> cost, and preference evidence.

Deferred acceptance criterion:

> Router evaluations distinguish model-effort variants — separately scored per
> `(model, effort)` variant, never pooled, with sample count and confidence
> recorded per opaque target ID.

Implementation sequencing and repository touchpoints are defined in the
[provider effort-selection implementation plan](2026-08-25-provider-effort-selection-implementation.md),
which carries the same v1/v2 split and lists the deferred tasks separately.
