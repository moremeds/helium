# Provider Effort Selection Design

**Date:** 2026-08-25

**Status:** Approved

## Decision

Reasoning effort is provider-owned execution metadata. It belongs in the
provider catalog, router candidate inventory, execution lease audit snapshot,
and privileged exact-target override. It does not belong in Helium core work
orders, roles, team manifests, or task graphs.

Normal routing chooses an execution target from measured combinations of model
and effort. A team asks for capabilities, evidence quality, latency, cost, and
safety constraints; it never asks for `claude-opus-5` at `xhigh` or any other
provider-specific combination.

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

## Claude catalog contract

The initial Claude subscription catalog is:

| Exact model | Invocation alias | Effort options | Catalog default |
|---|---|---|---|
| `claude-haiku-4-5-20251001` | `haiku` | unsupported | none |
| `claude-sonnet-5` | `sonnet` | `low`, `medium`, `high`, `xhigh`, `max` | `high` |
| `claude-opus-5` | `opus` | `low`, `medium`, `high`, `xhigh`, `max` | `high` |

The provider must reject an effort that the selected model does not advertise.
It must not depend on Claude Code silently clamping an unsupported level.
Organization-level caps must be reflected in the effective catalog snapshot
before routing.

Claude's `ultracode` is not an effort value in Helium. It combines `xhigh`
reasoning with dynamic workflow orchestration. Helium owns decomposition,
spawning, budgets, cancellation, and multi-agent state, so `ultracode` is a
separate provider execution mode and is disabled by default.

See [Claude Code model and effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

## Catalog representation

Provider plugins expose their native options at the edge:

```yaml
provider: claude-subscription
targets:
  - model: claude-haiku-4-5-20251001
    invoke_as: haiku
    effort:
      supported: false

  - model: claude-sonnet-5
    invoke_as: sonnet
    effort:
      supported: true
      options: [low, medium, high, xhigh, max]
      default: high

  - model: claude-opus-5
    invoke_as: opus
    effort:
      supported: true
      options: [low, medium, high, xhigh, max]
      default: high

execution_modes:
  ultracode:
    enabled: false
    reason: provider-owned-agent-orchestration
```

The provider registry expands or otherwise represents each valid
`(model, effort)` combination as an independently measurable execution target.
The core router sees only an opaque target reference plus normalized capability,
latency, reliability, cost, and safety evidence.

## Routing behavior

1. A work order declares capability and operational requirements only.
2. The router filters opaque targets against those requirements.
3. Measured model-effort variants compete on quality, latency, reliability,
   cost, and preference evidence.
4. The selected lease pins an exact provider target and effort outside the core
   task schema.
5. The provider invokes the selected effort explicitly rather than relying on
   a drifting CLI default.
6. The result records requested and applied effort with the full runtime model
   usage map.

If no model-effort variant satisfies the original requirements, routing returns
`capability-shortage`; it does not silently reduce effort or safety constraints.

## Administrator override

A privileged exact-target override may pin both model and effort for:

- deterministic replay;
- provider certification and evaluation;
- incident diagnosis;
- regression comparison; or
- emergency failover.

The override requires a reason and operator identity, is fully audited, and
cannot expand tools, mutations, budget, or workspace access.

## Audit requirements

Every execution snapshot records:

- exact requested model and invocation alias;
- requested effort;
- applied effort or provider-reported equivalent;
- organization cap or fallback, if any;
- complete provider `modelUsage`, including background models;
- provider and CLI version;
- latency, token use, cost metadata, and completion status; and
- catalog and evaluation versions used by the routing decision.

## Acceptance criteria

1. Core and team schemas reject `provider`, `model`, and `effort` fields.
2. Provider catalogs validate effort per model.
3. Haiku rejects an explicit effort selection.
4. Sonnet 5 and Opus 5 accept exactly `low`, `medium`, `high`, `xhigh`, and
   `max` in the initial catalog.
5. Unsupported or capped effort is visible in routing and audit evidence.
6. `ultracode` cannot be selected through the effort field.
7. Router evaluations distinguish model-effort variants.
8. Exact-target replay reproduces both model and effort without changing the
   original work order.
